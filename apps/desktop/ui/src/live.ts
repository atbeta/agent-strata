import type { ContentBlock, SessionView } from "./api";

export interface StreamingSnapshot {
  turn_id: string;
  msg_id?: string;
  content: ContentBlock[];
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

export function isStreamingSnapshotMessage(raw: string): boolean {
  try {
    const e = JSON.parse(raw) as { type?: unknown; data?: { partial?: unknown } };
    return e.type === "turn.assistant" && e.data?.partial === true;
  } catch {
    return false;
  }
}
