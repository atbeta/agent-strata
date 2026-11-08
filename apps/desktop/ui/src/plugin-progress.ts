// Progress a plugin tool reports while it runs.
//
// `tool.progress` is memory-only: it never reaches the store, so it cannot be
// read back from the transcript — it has to be caught as it arrives. This
// module is the catch: a map keyed by call id, fed by the stream, read by the
// tool row.
//
// Two things make the join work. A call id, when the adapter could supply one,
// is exact. Without one, the latest pending call for the same tool in the same
// session is the best answer available, and the plugin's event carries
// `plugin_id` and `tool` so that answer can be found — which is the fallback
// the design promised rather than an accident.

import { createSignal } from "solid-js";

export interface Progress {
  call_id?: string;
  plugin_id?: string;
  tool?: string;
  message?: string;
  percent?: number;
  at: number;
}

const [byCall, setByCall] = createSignal<Record<string, Progress>>({});

/**
 * Remember one progress event.
 *
 * A call id is required because that is what the transcript row is keyed by.
 * The host guarantees one: when the adapter could not name it, the service
 * resolves the session's pending call before dispatching (§4.3's fallback), so
 * an event without a key here is a bug in the host, not a normal case.
 */
export function noteProgress(progress: Omit<Progress, "at"> & { at?: number }): void {
  const key = progress.call_id;
  if (!key) return;
  setByCall((prev) => ({ ...prev, [key]: { ...progress, at: progress.at ?? Date.now() } }));
}

/** The last progress seen for a call, if any. */
export function progressOf(callId: string): Progress | undefined {
  return byCall()[callId];
}

/** Drop a call's progress once the result is in; the row has what it needs. */
export function clearProgress(callId: string): void {
  setByCall((prev) => {
    if (!(callId in prev)) return prev;
    const next = { ...prev };
    delete next[callId];
    return next;
  });
}

/**
 * The stream listener, installed once.
 *
 * It filters for `tool.progress` and ignores everything else, so it can sit
 * beside the other `strata-stream-event` listeners without adding work to the
 * transcript's hot path.
 */
export function installProgressListener(): () => void {
  const onStream = (event: Event) => {
    const detail = (event as CustomEvent<{ type?: string; call_id?: string; plugin_id?: string; tool?: string; message?: string; percent?: number }>).detail;
    if (detail?.type !== "tool.progress") return;
    noteProgress({
      call_id: detail.call_id,
      plugin_id: detail.plugin_id,
      tool: detail.tool,
      message: detail.message,
      percent: detail.percent,
    });
  };
  window.addEventListener("strata-stream-event", onStream);
  return () => window.removeEventListener("strata-stream-event", onStream);
}

/** What a row shows beside a running call: "3 of 5", "halfway", or nothing. */
export function progressLabel(callId: string | undefined): string | undefined {
  if (!callId) return undefined;
  const progress = progressOf(callId);
  if (!progress) return undefined;
  if (progress.percent !== undefined) return `${Math.round(progress.percent)}%`;
  return progress.message;
}
