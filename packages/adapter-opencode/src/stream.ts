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
  /** Testing seam: how long the global bus is given before the root bus is tried. */
  globalProbeMs?: number;
  /** Testing seam: how long a fallback waits before it asks for the global bus again. */
  globalRetryMs?: number;
}): Promise<void> {
  const { client, abort, connectTimeout, handle, onReconnect } = opts;
  // `/event` is one project directory. `/global/event` carries every project,
  // which is what a desktop session list has to follow. A 404 only rejects
  // once the body is read, so probe the global bus and fall back to `/event`.
  // The probe runs on every reconnect: a backend that answered late once — an
  // embedded server still warming up when the service attaches — is not a
  // reason to spend the life of the process on a single-directory bus.
  //
  // The fallback is what the per-directory buses are for. `/event` without a
  // directory watches the server's own root, and the root carries nothing for
  // a session that lives somewhere else: measured on a live server, a session
  // in a project directory produced every frame of its turn on the global bus
  // and on its own directory's bus, while the root bus carried nothing but
  // `server.connected` and heartbeats. A session nobody hears from is a
  // session that never says it is working — the busy mark comes from work
  // evidence, and work evidence is a frame — so a reader in that session sees
  // no running mark at all.
  /**
   * How long the global bus is given before the root bus is tried. It is the
   * whole budget by default, and that is not generosity — it is the race.
   *
   * Measured on a cold embedded server: it started listening at once and
   * answered nothing for eight seconds, and the moment it woke up both buses
   * produced their first frame within a millisecond of each other. A short
   * window for the global bus loses that race by a hair and puts the service
   * on the root bus, which reaches nothing but the server's own directory —
   * and the root bus answers immediately, so the loss looks like a success.
   * A server that has no global bus at all rejects it outright, so the long
   * window is only paid by a server that is slow, not by one that lacks it.
   */
  const globalWindow = (budgetMs: number) =>
    Math.min(opts.globalProbeMs ?? Infinity, budgetMs - Math.min(1_000, Math.floor(budgetMs / 4)));
  /**
   * How long a fallback waits before it asks for the global bus again.
   */
  const GLOBAL_RETRY_MS = opts.globalRetryMs ?? 15_000;
  /**
   * How long the reconnect is given in total: the global bus first, then the
   * root bus with whatever is left of the budget.
   */
  const RECONNECT_BUDGET_MS = 6_000;

  /**
   * Open a bus, preferring the global one.
   *
   * `/event` is one project directory — the server's own root when no
   * directory is named — and `/global/event` carries every project, which is
   * what a desktop session list has to follow. The global bus is given the
   * budget and the root bus a moment of what is left, because the two do not
   * answer in the same order: a server that is still warming up answers
   * neither, and answers both the instant it is ready. The root bus is a
   * bridge, not a destination — the caller keeps asking for the global one
   * (see `GLOBAL_RETRY_MS`).
   */
  const openBus = async (
    signal: AbortSignal,
    budgetMs: number,
  ): Promise<{ iter: AsyncIterator<unknown>; value: unknown; global: boolean } | undefined> => {
    const started = Date.now();
    const global = await firstEvent(
      async () => ({
        global: true,
        ...(await client.global.event({ signal })),
      }),
      globalWindow(budgetMs),
    );
    if (global) return global;
    const left = budgetMs - (Date.now() - started);
    if (left < 200) return undefined;
    return await firstEvent(
      async () => ({
        global: false,
        ...(await client.event.subscribe({ signal } as { directory?: string })),
      }),
      left,
    );
  };
  const firstEvent = async (
    open: () => Promise<{ stream: AsyncGenerator<unknown>; global: boolean }>,
    timeoutMs: number,
  ) => {
    let opened: { stream: AsyncGenerator<unknown>; global: boolean };
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
    return { iter, value: first.value, global: opened.global };
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
  const INTERRUPTED = "interrupted" as const;
  /** Never settles: a read that nobody interrupts waits on the frame alone. */
  const NEVER = new Promise<never>(() => {});

  /**
   * A deadline that can cut a read short. The fallback has to be able to give
   * up its socket and ask for the global bus again, and a read waiting on a
   * frame is the thing that would otherwise hold it there for good.
   */
  const interruptible = (ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    return {
      promise,
      cancel: () => {
        if (timer !== undefined) clearTimeout(timer);
      },
    };
  };

  /**
   * One read, raced against the stream's own silence window. The read is
   * issued once — an iterator must not be driven concurrently — and the tick
   * only re-checks the deadline, so the sleep is paid per window, not per
   * event.
   */
  const readNext = async (
    iter: AsyncIterator<unknown>,
    seen: { at: number },
    interrupt?: Promise<void>,
  ): Promise<IteratorResult<unknown> | typeof SILENT | typeof INTERRUPTED> => {
    const pending = iter.next();
    // The read may be abandoned when the window lapses; never leave it unhandled.
    pending.catch(() => {});
    for (;;) {
      const r = await Promise.race([
        pending,
        Bun.sleep(Math.max(seen.at + SILENCE_MS - Date.now(), 250)).then(
          () => "tick" as const,
        ),
        interrupt ? interrupt.then(() => "interrupt" as const) : NEVER,
      ]);
      if (r !== "tick" && r !== "interrupt") return r;
      if (r === "interrupt") return INTERRUPTED;
      if (abort.signal.aborted) return { done: true, value: undefined };
      if (Date.now() - seen.at < SILENCE_MS) continue;
      return SILENT;
    }
  };

  /**
   * One subscription per project directory, opened only while the global bus
   * is not the one in use.
   *
   * The global bus carries every project, so it is the bus a desktop session
   * list needs and the only socket the server should have to serve — measured
   * at 52 sockets before, one after. It is also not always there: an embedded
   * server that is still warming up when the service attaches answers
   * `/event` before `/global/event`, and the fallback that follows watches
   * the server's own root, which carries nothing for a session in another
   * directory.
   *
   * So the directories get their own buses, and only for as long as the
   * global one is missing. They are learned from the frames that arrive and
   * from the session list, because a directory the root bus cannot mention is
   * a directory this layer would otherwise never hear about: the sessions
   * there are still discovered by the sync, and still run, but no frame of
   * their turn reaches the mapper — so the reader in one of them sees no
   * running mark and the composer stops offering Stop while the model is
   * still working.
   */
  const knownDirectories = new Set<string>();
  const projectStreams = new Map<string, AbortController>();
  /** whether the main stream is the global bus — it is the one that reaches every directory */
  let usingGlobal = false;

  const watchProject = (directory: string) => {
    if (abort.signal.aborted) return;
    knownDirectories.add(directory);
    // The global bus already carries this directory. A second socket for it
    // would buy nothing.
    if (usingGlobal || projectStreams.has(directory)) return;
    // One controller for the whole watch: it means "stop watching this
    // directory", and it outlives every attempt.
    const watched = new AbortController();
    projectStreams.set(directory, watched);
    void (async () => {
      let pause = 1_000;
      for (;;) {
        // The watch was stopped on purpose — the global one took over, or the
        // whole connection went down.
        if (abort.signal.aborted || watched.signal.aborted) return;
        // Each attempt gets its own signal. The one that closed the socket
        // must not also close the next one: a single controller for the whole
        // watch was aborted by the attempt that ended, and the loop then
        // found it aborted and left — so the bus of this directory was
        // opened exactly once and never again.
        const streamAbort = new AbortController();
        const stop = () => streamAbort.abort();
        abort.signal.addEventListener("abort", stop, { once: true });
        watched.signal.addEventListener("abort", stop, { once: true });
        let iter: AsyncIterator<unknown> | undefined;
        let wedged = false;
        const seen = { at: Date.now() };
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
            if (r === INTERRUPTED) break;
            if (r.done || abort.signal.aborted) break;
            seen.at = Date.now();
            dispatch(r.value);
          }
          if (abort.signal.aborted || watched.signal.aborted) return;
          streamAbort.abort();
          if (!wedged) {
            await Bun.sleep(pause);
            pause = Math.min(pause * 2, 30_000);
          }
        } catch {
          if (abort.signal.aborted || watched.signal.aborted) return;
          await Bun.sleep(pause);
          pause = Math.min(pause * 2, 30_000);
        } finally {
          abort.signal.removeEventListener("abort", stop);
          watched.signal.removeEventListener("abort", stop);
          streamAbort.abort();
          void iter?.return?.(undefined)?.catch?.(() => {});
        }
        // A wedged stream re-opens straight away; an ended one pays backoff.
      }
    })();
  };

  /** Close the per-directory buses: the global one reaches all of them. */
  const stopProjectStreams = () => {
    for (const controller of projectStreams.values()) controller.abort();
    projectStreams.clear();
  };

  /** Open a bus for every directory we know of, if the global bus is missing. */
  const syncProjectStreams = () => {
    if (usingGlobal) {
      stopProjectStreams();
      return;
    }
    for (const directory of knownDirectories) watchProject(directory);
  };

  const dispatch = (raw: unknown) => {
    const evt = normalizeOpencodeEvent(raw);
    if (!evt) return;
    // Learn directories on sight: `session.created`/`session.updated` carry
    // `info.directory`, and a session in a directory nothing else mentions is
    // exactly the one the root bus cannot deliver.
    const props = evt.properties as
      | { info?: { directory?: unknown }; directory?: unknown }
      | undefined;
    const dir =
      typeof props?.info?.directory === "string"
        ? props.info.directory
        : typeof props?.directory === "string"
          ? props.directory
          : undefined;
    if (dir && !knownDirectories.has(dir)) {
      watchProject(dir);
      syncProjectStreams();
    }
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

  /**
   * The directories the server knows, so the per-directory buses have a list
   * to open before any frame names one.
   */
  const learnDirectories = async () => {
    try {
      const projects = await client.project.list();
      for (const project of projects.data ?? []) {
        if (project.worktree) watchProject(project.worktree);
        for (const sandbox of project.sandboxes ?? []) watchProject(sandbox);
      }
    } catch (err) {
      console.error("opencode project list failed:", err);
    }
    // A session can live in a directory no project was opened from.
    try {
      const sessions = await client.session.list({ roots: true, limit: 200 });
      for (const session of sessions.data ?? []) {
        if (session.directory) watchProject(session.directory);
      }
    } catch (err) {
      console.error("opencode session list failed:", err);
    }
    syncProjectStreams();
  };

  // Global and the fallback share one budget. A quiet socket must not
  // pay the timeout twice before connect gives up.
  let streamAbort = new AbortController();
  let got = await openBus(streamAbort.signal, connectTimeout);
  if (!got) {
    streamAbort.abort();
    abort.abort();
    throw new Error(`opencode event stream produced no events within ${connectTimeout}ms`);
  }
  usingGlobal = got.global;
  console.log(`opencode event bus: ${usingGlobal ? "global" : "root fallback"}`);
  dispatch(got.value);
  // The directories are worth knowing before the first frame names one: when
  // the global bus is missing, they are the only way to reach a session that
  // lives outside the server's root.
  void learnDirectories();

  const pump = async (
    iter: AsyncIterator<unknown>,
    seen: { at: number },
    interrupt?: Promise<void>,
  ) => {
    for (;;) {
      const r = await readNext(iter, seen, interrupt);
      if (r === SILENT || r === INTERRUPTED || r.done || abort.signal.aborted) return;
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
      /**
       * A fallback is a bridge, not a destination. The root bus watches the
       * server's own root and carries nothing for a session that lives
       * elsewhere, so the per-directory buses are open to cover for it — but
       * the global bus reaches every directory on a single socket, and it was
       * missing for a reason that may pass: an embedded server still warming
       * up when the service attaches answers the root bus first and the
       * global one a second later. So the fallback is given a deadline, and
       * when it lapses the stream is reopened in the hope of the global bus.
       * If it arrives, the per-directory buses are closed and the server is
       * back to the one socket it should have.
       */
      const deadline = usingGlobal ? undefined : interruptible(GLOBAL_RETRY_MS);
      try {
        await pump(current, seen, deadline?.promise);
      } catch (err) {
        if (!abort.signal.aborted) console.error("opencode event stream error:", err);
      }
      deadline?.cancel();
      if (abort.signal.aborted) return;
      // Whether the stream ended, errored or was interrupted, take its socket down
      // before opening another.
      streamAbort.abort();
      await Bun.sleep(pause);
      if (abort.signal.aborted) return;
      streamAbort = new AbortController();
      const again = await openBus(streamAbort.signal, RECONNECT_BUDGET_MS);
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
      // The bus in use may have changed: the global one reaches every
      // directory, so the per-directory buses are closed; the fallback does
      // not, so the ones we know of are opened.
      if (again.global !== usingGlobal) {
        usingGlobal = again.global;
        console.log(`opencode event bus: ${usingGlobal ? "global" : "root fallback"}`);
        syncProjectStreams();
      }
      // A directory that appeared after the last look is one the buses know
      // nothing about, and a session living there is one nobody hears from.
      // The global bus would carry it — but the fallback is here precisely
      // because the global bus is missing.
      if (!usingGlobal) void learnDirectories();
      dispatch(again.value);
      onReconnect();
    }
  })();
}
