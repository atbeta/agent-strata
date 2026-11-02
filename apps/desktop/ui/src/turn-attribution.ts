import type { ToolCallView, Turn } from "./api";

/**
 * Which tool call belongs to which message of a turn, and which belongs to
 * none of them.
 *
 * A call's `msg_id` names an absolute message index inside the turn, so the
 * attribution is a property of the turn and not of a piece of it. A turn
 * mounted in segments computes this per segment, and a turn of two hundred
 * messages has seventeen of them: the whole turn was walked seventeen times
 * over for one slice of it.
 *
 * Keyed by the turn object, so it is built once and every segment of that
 * turn reads the same one. The turn object changes when the turn does, and
 * the old entry goes with it.
 */
const attributions = new WeakMap<Turn, Attribution>();

export interface Attribution {
  /** Calls grouped under the message that made them, by message index. */
  byMessage: Map<number, ToolCallView[]>;
  /** Calls the backend never attributed to a message. */
  loose: ToolCallView[];
}

export function attributionOf(turn: Turn): Attribution {
  const hit = attributions.get(turn);
  if (hit) return hit;
  const at = new Map<string, number>();
  turn.assistant.forEach((m, i) => {
    if (m.msg_id !== undefined) at.set(m.msg_id, i);
  });
  const byMessage = new Map<number, ToolCallView[]>();
  const loose: ToolCallView[] = [];
  for (const c of turn.tool_calls) {
    const i = c.msg_id === undefined ? undefined : at.get(c.msg_id);
    if (i === undefined) {
      loose.push(c);
      continue;
    }
    const list = byMessage.get(i);
    if (list) list.push(c);
    else byMessage.set(i, [c]);
  }
  const out: Attribution = { byMessage, loose };
  attributions.set(turn, out);
  return out;
}
