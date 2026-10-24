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

  // Global and the fallback share one budget. A quiet socket must not
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
