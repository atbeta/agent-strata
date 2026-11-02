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

/** The words of a message still being written, in the order the reader sees them. */
function streamedText(content: ContentBlock[]): string {
  let out = "";
  for (const block of content) {
    if (block.type === "text" || block.type === "thinking") out += block.text;
  }
  return out;
}

/**
 * `next` is an older copy of `previous`: a prefix, and shorter.
 *
 * A rewrite is not this. "final" does not begin "draft", so a snapshot that
 * actually changed the sentence still lands. An empty frame and a part update
 * that arrived behind the deltas both do, and both used to blank the reply.
 */
function snapshotBehind(previous: ContentBlock[], next: ContentBlock[]): boolean {
  const prev = streamedText(previous);
  const nxt = streamedText(next);
  return nxt.length < prev.length && prev.startsWith(nxt);
}

/**
 * A view that arrived over the wire must not take words off a reply the reader
 * is already looking at.
 *
 * The fetch was in flight while snapshots kept extending that reply, and the
 * answer it carries is the reply as of when the request was built. Laying it
 * down as-is shortens the paragraph, and the next snapshot writes the words
 * back — the reply blinks out and in for as long as generation and refresh
 * overlap. A finished message is the record and wins. A busy view that has not
 * caught the reply up yet keeps the words already on screen; an idle one does
 * not, so a reply the reader removed stays removed.
 */
export function keepStreamingLead(held: SessionView, incoming: SessionView): SessionView {
  if (held.session_id !== incoming.session_id) return incoming;
  const heldTurn = held.turns.at(-1);
  const index = incoming.turns.length - 1;
  const incomingTurn = index >= 0 ? incoming.turns[index] : undefined;
  if (!heldTurn || !incomingTurn || heldTurn.turn_id !== incomingTurn.turn_id) return incoming;
  let assistant = incomingTurn.assistant;
  let changed = false;
  for (const msg of heldTurn.assistant) {
    if (msg.partial !== true || !msg.msg_id) continue;
    const at = assistant.findIndex((a) => a.msg_id === msg.msg_id);
    if (at < 0) {
      if (incoming.busy !== true) continue;
      assistant = [...assistant, msg];
      changed = true;
      continue;
    }
    const found = assistant[at]!;
    if (found.partial !== true || !snapshotBehind(msg.content, found.content)) continue;
    assistant = assistant.map((a, i) => (i === at ? msg : a));
    changed = true;
  }
  if (!changed) return incoming;
  const turns = incoming.turns.slice();
  turns[index] = { ...incomingTurn, assistant };
  return { ...incoming, turns };
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
  // A shorter prefix is a frame that fell behind, not a new sentence. Taking
  // it clears the paragraph until the next snapshot, which is the blink.
  if (ai >= 0 && snapshotBehind(turn.assistant[ai]!.content, snap.content)) return view;
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
