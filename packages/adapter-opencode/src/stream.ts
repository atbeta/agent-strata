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
}): Promise<void> {
  const { client, abort, connectTimeout, handle, onReconnect } = opts;
  // `/event` is one project directory. `/global/event` carries every project,
  // which is what a desktop session list has to follow. A 404 only rejects
  // once the body is read, so probe the global bus and fall back to `/event`.
  let preferGlobal = true;
  const openStream = async () => {
    if (preferGlobal) {
      try {
        return await client.global.event();
      } catch {
        preferGlobal = false;
      }
    }
    return client.event.subscribe();
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
  // Global and the per-directory bus share one budget. A quiet socket must not
  // pay the timeout twice before connect gives up.
  const connectStarted = Date.now();
  let got = await firstEvent(
    () => client.global.event() as Promise<{ stream: AsyncGenerator<unknown> }>,
    Math.min(connectTimeout, 3_000),
  );
  if (!got) {
    preferGlobal = false;
    const left = connectTimeout - (Date.now() - connectStarted);
    if (left >= 200) {
      got = await firstEvent(
        () => client.event.subscribe() as Promise<{ stream: AsyncGenerator<unknown> }>,
        left,
      );
    }
  }
  if (!got) {
    abort.abort();
    throw new Error(`opencode event stream produced no events within ${connectTimeout}ms`);
  }
  const dispatch = (raw: unknown) => {
    const evt = normalizeOpencodeEvent(raw);
    if (!evt) return;
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
  dispatch(got.value);

  const pump = async (iter: AsyncIterator<unknown>) => {
    for (;;) {
      const r = await iter.next();
      if (r.done || abort.signal.aborted) return;
      dispatch(r.value);
    }
  };

  /**
   * One subscription per project, alongside the global one.
   *
   * The global bus is the only way to hear about a session in a project we were
   * not launched in, so it stays. It is also the bus whose `session.status`
   * cannot be trusted for idleness: measured live, it keeps carrying `busy` for
   * a run that has already ended, long after the project bus reported idle. The
   * last state to arrive is then not the state of the run, and a session whose
   * tools are visibly working reads idle in every list.
   *
   * So each known project gets `/event?directory=…` as well, and that stream is
   * in step with the work. Both feed the same dispatcher: the global bus still
   * discovers sessions, transcripts and file changes arrive once however many
   * buses carry them, and an idle is only believed when it comes from a bus
   * that is watching that project.
   *
   * A project whose stream fails to open is not fatal — its sessions are still
   * discovered and still run, they just fall back to trusting the global bus,
   * which is what happened to every session before this existed.
   */
  const projectStreams = new Set<string>();
  const watchProject = (directory: string) => {
    if (abort.signal.aborted || projectStreams.has(directory)) return;
    projectStreams.add(directory);
    void (async () => {
      let pause = 1_000;
      for (;;) {
        if (abort.signal.aborted) return;
        let iter: AsyncIterator<unknown> | undefined;
        try {
          const opened = (await client.event.subscribe({ directory })) as {
            stream: AsyncGenerator<unknown>;
          };
          iter = opened.stream[Symbol.asyncIterator]();
          pause = 1_000;
          for (;;) {
            const r = await iter.next();
            if (r.done || abort.signal.aborted) return;
            dispatch(r.value);
          }
        } catch {
          if (abort.signal.aborted) return;
          await Bun.sleep(pause);
          pause = Math.min(pause * 2, 30_000);
        } finally {
          void iter?.return?.(undefined)?.catch?.(() => {});
        }
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
  };
  void watchProjects();
  const quiet: AsyncIterator<unknown> = (async function* () {})();
  const loop = (async () => {
    let current: AsyncIterator<unknown> = got.iter;
    let pause = 1_000;
    while (!abort.signal.aborted) {
      try {
        await pump(current);
      } catch (err) {
        if (!abort.signal.aborted) console.error("opencode event stream error:", err);
      }
      if (abort.signal.aborted) return;
      await Bun.sleep(pause);
      if (abort.signal.aborted) return;
      const again = await firstEvent(
        () => openStream() as Promise<{ stream: AsyncGenerator<unknown> }>,
        3_000,
      );
      if (!again) {
        current = quiet;
        pause = Math.min(pause * 2, 15_000);
        if (!abort.signal.aborted) console.error("opencode event stream reconnect failed");
        continue;
      }
      pause = 1_000;
      current = again.iter;
      dispatch(again.value);
      onReconnect();
    }
  })();
}
