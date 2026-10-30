import type { ContentBlock, SessionView, ViewTail } from "./api";

export interface StreamingSnapshot {
  turn_id: string;
  msg_id?: string;
  content: ContentBlock[];
}

/**
 * How long "the prompt is on its way" may stand on its own.
 *
 * It covers one round trip: the POST lands, the backend marks the session busy,
 * the projection says so and the view behind it re-fetches. Generous enough for
 * a long session where that view is the slowest thing on screen, and short
 * enough that a session nobody is in is not still holding the composer.
 *
 * It has to be a deadline. Every earlier version made this a flag with four
 * exits, of which the ordinary one — the backend's own idle — depends on the
 * backend saying so. When it did not, the flag outlived the run and the
 * composer kept a second, independent reason to believe the session was busy
 * that no event and no re-fetch could ever clear. Two latches OR-ed together,
 * each with its own incomplete exit, is why this took four passes to land: a
 * fix to one arm left the other standing.
 */
export const SEND_GRACE_MS = 15_000;

/**
 * Whether the composer should offer Stop.
 *
 * `busy` is the fact: the projection's own read of the session, and the one
 * thing here that changes for reasons other than the reader. Everything else is
 * a bounded handover window covering the gap before that fact catches up — a
 * partial message does not count, because partials outlive the run, and neither
 * does a handover that has run out of time.
 */
export function runInProgress(input: { handover?: number; busy?: boolean; now?: number }): boolean {
  if (input.busy === true) return true;
  if (input.handover === undefined) return false;
  return (input.now ?? Date.now()) - input.handover < SEND_GRACE_MS;
}

/** Lay a message still being written over the latest known turn; finished and older turns are left alone. */
export function applyStreamingSnapshot(view: SessionView, snap: StreamingSnapshot): SessionView {
  if (!snap.msg_id) return view;
  const ti = view.turns.findIndex((t) => t.turn_id === snap.turn_id);
  if (ti < 0 || ti !== view.turns.length - 1) return view;
  const entry = { content: snap.content, msg_id: snap.msg_id, partial: true };
  const turn = view.turns[ti]!;
  const ai = turn.assistant.findIndex((a) => a.msg_id === snap.msg_id);
  if (ai >= 0 && turn.assistant[ai]!.partial !== true) return view;
  const assistant =
    ai >= 0 ? turn.assistant.map((a, i) => (i === ai ? { ...a, ...entry } : a)) : [...turn.assistant, entry];
  const turns = view.turns.slice();
  turns[ti] = { ...turn, assistant };
  return { ...view, turns };
}

/** Lay a view's last turns over the one the reader holds; undefined when the two no longer line up. */
export function mergeViewTail(view: SessionView, tail: ViewTail): SessionView | undefined {
  if (view.session_id !== tail.session_id) return undefined;
  const { turn_offset, prev_turn_id, files_key: _key, files_changed, ...rest } = tail;
  if (turn_offset > view.turns.length) return undefined;
  if ((view.turns[turn_offset - 1]?.turn_id ?? null) !== prev_turn_id) return undefined;
  return {
    ...rest,
    turns: view.turns.slice(0, turn_offset).concat(tail.turns),
    files_changed: files_changed ?? view.files_changed,
  };
}

export function isStreamingSnapshotMessage(raw: string): boolean {
  try {
    const e = JSON.parse(raw) as { type?: unknown; data?: { partial?: unknown } };
    return e.type === "turn.assistant" && e.data?.partial === true;
  } catch {
    return false;
  }
}
