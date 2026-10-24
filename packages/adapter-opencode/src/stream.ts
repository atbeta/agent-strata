import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2";

/**
 * The live bus. A frame is applied as it arrives. Re-reading the transcript is
 * the importer's job, and only when a session is disconnected, its revision
 * moved, or the mapping itself changed.
 */

/** OpenCode's global bus wraps the event, and newer servers put the body in `data`. */
export function normalizeOpencodeEvent(raw: unknown): Event | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  let evt = raw as Record<string, unknown>;
  if (evt.payload && typeof evt.payload === "object") evt = evt.payload as Record<string, unknown>;
  if (evt.data && typeof evt.data === "object" && !evt.properties) {
    evt = { ...evt, properties: evt.data };
  }
  if (typeof evt.type !== "string") return undefined;
  return evt as unknown as Event;
}

export async function runOpencodeStream(opts: {
  client: OpencodeClient;
  abort: AbortController;
  connectTimeout: number;
  onEvent?: (evt: Event) => void;
  handle: (evt: Event) => void;
  onReconnect: () => void;
  /** Testing seam: how long a stream may stay silent before it is called wedged. */
  silenceMs?: number;
}): Promise<void> {
  const { client, abort, connectTimeout, handle, onReconnect } = opts;
  // `/event` is one project directory. `/global/event` carries every project,
  // which is what a desktop session list has to follow. A 404 only rejects
  // once the body is read, so probe the global bus and fall back to `/event`.
  // The probe runs on every reconnect: a backend that answered late once — an
  // embedded server still warming up when the service attaches — is not a
  // reason to spend the life of the process on a single-directory bus.
  const openStream = async (signal: AbortSignal) => {
    try {
      return await client.global.event({ signal });
    } catch {
      return client.event.subscribe({ signal } as { directory?: string });
    }
  };
  const firstEvent = async (
    open: () => Promise<{ stream: AsyncGenerator<unknown> }>,
    timeoutMs: number,
  ) => {
    let opened: { stream: AsyncGenerator<unknown> };
    try {
      opened = await open();
    } catch {
      return undefined;
    }
    const stream = opened.stream;
    const iter = stream[Symbol.asyncIterator]();
    const pending = iter.next();
    pending.catch(() => {});
    const first = await Promise.race([
      pending.then(
        (value) => value,
        () => "error" as const,
      ),
      Bun.sleep(timeoutMs).then(() => "timeout" as const),
    ]);
    if (first === "timeout" || first === "error" || first.done) {
      // return() waits on the in-flight read, which is the thing that timed
      // out, so it must not be awaited. stop()/abort cancels the body.
      void stream.return(undefined).catch(() => {});
      return undefined;
    }
    return { iter, value: first.value };
  };

  /**
   * A healthy SSE stream heartbeats; one that has been silent this long is
   * wedged. A wedged socket is the failure mode that matters most here: the
   * iterator stays pending, no error surfaces, and every live event from then
   * on is invisible until the process restarts — while heartbeats on other
   * subscriptions make the connection look alive.
   */
  const SILENCE_MS = opts.silenceMs ?? 45_000;
  const SILENT = "silent" as const;

  /**
   * One read, raced against the stream's own silence window. The read is
   * issued once — an iterator must not be driven concurrently — and the tick
   * only re-checks the deadline, so the sleep is paid per window, not per
   * event.
   */
  const readNext = async (
    iter: AsyncIterator<unknown>,
    seen: { at: number },
  ): Promise<IteratorResult<unknown> | typeof SILENT> => {
    const pending = iter.next();
    // The read may be abandoned when the window lapses; never leave it unhandled.
    pending.catch(() => {});
    for (;;) {
      const r = await Promise.race([
        pending,
        Bun.sleep(Math.max(seen.at + SILENCE_MS - Date.now(), 250)).then(
          () => "tick" as const,
        ),
      ]);
      if (r !== "tick") return r;
      if (abort.signal.aborted) return { done: true, value: undefined };
      if (Date.now() - seen.at < SILENCE_MS) continue;
      return SILENT;
    }
  };

  /**
   * One subscription per project directory, alongside the global one.
   *
   * The global bus is the only way to hear about a session in a project we were
   * not launched in, so it stays. It is also the bus whose `session.status`
   * cannot be trusted for idleness: measured live, it keeps carrying `busy` for
   * a run that has already ended, long after the project bus reported idle. The
   * last state to arrive is then not the state of the run, and a session whose
   * tools are visibly working reads idle in every list.
   *
   * So each known directory gets `/event?directory=…` as well, and that stream
   * is in step with the work. Both feed the same dispatcher: the global bus
   * still discovers sessions, transcripts and file changes arrive once however
   * many buses carry them, and an idle is only believed when it comes from a
   * bus that is watching that project.
   *
   * Directories are learned from the project and session lists at connect and
   * from every session event after — `session.created`/`session.updated` carry
   * `info.directory` — so a session in a directory no project was opened from
   * (a temp dir, an unregistered worktree) still gets a bus that watches it,
   * instead of depending entirely on the global stream.
   *
   * A directory whose stream fails to open is not fatal — its sessions are
   * still discovered and still run, they just fall back to trusting the global
   * bus, which is what happened to every session before this existed.
   */
  const projectStreams = new Set<string>();
  const dispatch = (raw: unknown) => {
    const evt = normalizeOpencodeEvent(raw);
    if (!evt) return;
    // Learn directories on sight: a session that updates in a directory no
    // stream covers is only as live as the global bus, which is also the
    // stream most likely to be the wedged one.
    const props = evt.properties as
      | { info?: { directory?: unknown }; directory?: unknown }
      | undefined;
    const dir =
      typeof props?.info?.directory === "string"
        ? props.info.directory
        : typeof props?.directory === "string"
          ? props.directory
          : undefined;
    if (dir) watchProject(dir);
    // The live bus already carries the parts. Re-reading the whole transcript
    // after every status ran on this same thread, one transaction per part,
    // for as long as a reply lasted. A session whose revision moved is
    // imported by sync and by the reconnect catch-up; a mapper change
    // rebuilds. A live event does not schedule that read.
    handle(evt);
    if (!opts.onEvent) return;
    try {
      opts.onEvent(evt);
    } catch (err) {
      console.error("opencode onEvent error:", err);
    }
  };
  const watchProject = (directory: string) => {
    if (abort.signal.aborted || projectStreams.has(directory)) return;
    projectStreams.add(directory);
    void (async () => {
      let pause = 1_000;
      for (;;) {
        if (abort.signal.aborted) return;
        const streamAbort = new AbortController();
        const stop = () => streamAbort.abort();
        abort.signal.addEventListener("abort", stop, { once: true });
        const seen = { at: Date.now() };
        let iter: AsyncIterator<unknown> | undefined;
        let wedged = false;
        try {
          const opened = (await client.event.subscribe({
            directory,
            signal: streamAbort.signal,
          } as { directory: string })) as { stream: AsyncGenerator<unknown> };
          iter = opened.stream[Symbol.asyncIterator]();
          pause = 1_000;
          for (;;) {
            const r = await readNext(iter, seen);
            if (r === SILENT) {
              wedged = true;
              break;
            }
            if (r.done || abort.signal.aborted) break;
            seen.at = Date.now();
            dispatch(r.value);
          }
          if (abort.signal.aborted) return;
          streamAbort.abort();
          if (!wedged) {
            await Bun.sleep(pause);
            pause = Math.min(pause * 2, 30_000);
          }
        } catch {
          if (abort.signal.aborted) return;
          await Bun.sleep(pause);
          pause = Math.min(pause * 2, 30_000);
        } finally {
          abort.signal.removeEventListener("abort", stop);
          streamAbort.abort();
          void iter?.return?.(undefined)?.catch?.(() => {});
        }
        // A wedged stream re-opens straight away; an ended one pays backoff.
      }
    })();
  };
  const watchProjects = async () => {
    try {
      const r = await client.project.list();
      for (const project of r.data ?? []) {
        watchProject(project.worktree);
        for (const sandbox of project.sandboxes ?? []) watchProject(sandbox);
      }
    } catch (err) {
      console.error("opencode project list failed:", err);
    }
    // A session can live in a directory no project was opened from. Listing
    // sessions covers the ones that exist already; the ones created later are
    // learned as their events arrive.
    try {
      const s = await client.session.list({ roots: true, limit: 200 });
      for (const session of s.data ?? []) watchProject(session.directory);
    } catch (err) {
      console.error("opencode session list failed:", err);
    }
  };

  // Global and the per-directory bus share one budget. A quiet socket must not
  // pay the timeout twice before connect gives up.
  const connectStarted = Date.now();
  let streamAbort = new AbortController();
  let got = await firstEvent(
    () =>
      client.global.event({ signal: streamAbort.signal }) as Promise<{
        stream: AsyncGenerator<unknown>;
      }>,
    Math.min(connectTimeout, 3_000),
  );
  if (!got) {
    streamAbort.abort();
    streamAbort = new AbortController();
    const left = connectTimeout - (Date.now() - connectStarted);
    if (left >= 200) {
      got = await firstEvent(
        () =>
          client.event.subscribe({ signal: streamAbort.signal } as {
            directory?: string;
          }) as Promise<{
            stream: AsyncGenerator<unknown>;
          }>,
        left,
      );
    }
  }
  if (!got) {
    streamAbort.abort();
    abort.abort();
    throw new Error(`opencode event stream produced no events within ${connectTimeout}ms`);
  }
  void watchProjects();
  dispatch(got.value);

  const pump = async (iter: AsyncIterator<unknown>, seen: { at: number }) => {
    for (;;) {
      const r = await readNext(iter, seen);
      if (r === SILENT || r.done || abort.signal.aborted) return;
      seen.at = Date.now();
      dispatch(r.value);
    }
  };

  const quiet: AsyncIterator<unknown> = (async function* () {})();
  const loop = (async () => {
    let current: AsyncIterator<unknown> = got.iter;
    const seen = { at: Date.now() };
    let pause = 1_000;
    while (!abort.signal.aborted) {
      try {
        await pump(current, seen);
      } catch (err) {
        if (!abort.signal.aborted) console.error("opencode event stream error:", err);
      }
      if (abort.signal.aborted) return;
      // Whether the stream ended, errored or went silent, take its socket down
      // before opening another.
      streamAbort.abort();
      await Bun.sleep(pause);
      if (abort.signal.aborted) return;
      streamAbort = new AbortController();
      const again = await firstEvent(
        () =>
          openStream(streamAbort.signal) as Promise<{
            stream: AsyncGenerator<unknown>;
          }>,
        3_000,
      );
      if (!again) {
        streamAbort.abort();
        current = quiet;
        pause = Math.min(pause * 2, 15_000);
        if (!abort.signal.aborted) console.error("opencode event stream reconnect failed");
        continue;
      }
      pause = 1_000;
      seen.at = Date.now();
      current = again.iter;
      dispatch(again.value);
      onReconnect();
    }
  })();
}
