import type { ContentBlock, SessionView, ViewTail } from "./api";

export interface StreamingSnapshot {
  turn_id: string;
  msg_id?: string;
  content: ContentBlock[];
}

/**
 * Whether the composer should offer Stop.
 *
 * A prompt just handed over counts, and so does `busy`. A partial message does
 * not. Partials outlive the run: the idle fallback retires `busy` while the
 * last snapshot is still open, and a later import publishes that snapshot
 * again. Treating it as a run leaves Stop on a session that is idle, and
 * pressing it cannot retire a message the backend has already finished.
 */
export function runInProgress(input: { pending?: boolean; busy?: boolean }): boolean {
  return input.pending === true || input.busy === true;
}

/** Lay a message still being written over the view the reader holds; a finished one is left alone. */
export function applyStreamingSnapshot(view: SessionView, snap: StreamingSnapshot): SessionView {
  if (!snap.msg_id) return view;
  const entry = { content: snap.content, msg_id: snap.msg_id, partial: true };
  const ti = view.turns.findIndex((t) => t.turn_id === snap.turn_id);
  if (ti < 0) {
    return { ...view, turns: [...view.turns, { turn_id: snap.turn_id, assistant: [entry], tool_calls: [] }] };
  }
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
