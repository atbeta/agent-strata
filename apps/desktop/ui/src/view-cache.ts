import type { SessionView, ViewTail } from "./api";
import { filesKeyOf } from "../../../../packages/projector/src/files-key";

export { filesKeyOf };

const CAPACITY = 4;

/**
 * How much kept view the cache may hold, in turns.
 *
 * The count alone was the wrong limit: four conversations is plenty when they
 * are small and nothing when the reader is working through a set of long ones.
 * Switching back to a session that fell out of a four-slot cache rebuilt it
 * from a skeleton, which is the blank frame readers notice — the view was
 * already on screen a minute earlier.
 *
 * Counted in turns rather than bytes because that is what the cache can measure
 * without walking a multi-megabyte object on every write, and a turn is what
 * the memory cost is proportional to. 4,000 turns holds the sessions a reader
 * actually moves between while a single enormous one still evicts the rest
 * rather than growing without bound.
 */
const MAX_TURNS = 4_000;

/** turns a live refresh asks for; a durable event during a reply lands in the last one or two */
export const TAIL_TURNS = 3;

interface Slot {
  id: string;
  view: SessionView;
  filesKey?: string;
}

export interface CachedView {
  view: SessionView;
  filesKey?: string;
}

/**
 * Recent full views the reader has already settled. A tail preview is not a
 * record and must not be stored here: the next open would paint a transcript
 * that is missing its history. The service projection, including live events
 * on the tail route, stays the source this cache is checked against.
 */
export function createViewCache(capacity = CAPACITY, maxTurns = MAX_TURNS) {
  const slots: Slot[] = [];

  /** Turns held across every slot; the bound the capacity alone could not give. */
  const held = () => slots.reduce((n, s) => n + s.view.turns.length, 0);

  const peek = (id: string): CachedView | undefined => {
    const i = slots.findIndex((s) => s.id === id);
    if (i < 0) return undefined;
    const [slot] = slots.splice(i, 1);
    slots.push(slot!);
    return { view: slot!.view, filesKey: slot!.filesKey };
  };

  const remember = (id: string, view: SessionView, filesKey?: string) => {
    const i = slots.findIndex((s) => s.id === id);
    const prev = i >= 0 ? slots.splice(i, 1)[0] : undefined;
    slots.push({ id, view, filesKey: filesKey ?? prev?.filesKey });
    // The newest entry is never the one dropped: a conversation the reader just
    // opened has to be here when they come back to it, even if it is the only
    // thing that fits.
    while (slots.length > 1 && (slots.length > capacity || held() > maxTurns)) slots.shift();
    while (slots.length > capacity) slots.shift();
  };

  return { peek, remember };
}

const sessionViews = createViewCache();

export const peekView = (id: string) => sessionViews.peek(id);
export const rememberView = (id: string, view: SessionView, filesKey?: string) =>
  sessionViews.remember(id, view, filesKey);

/** A tail response drawn as the whole transcript until the full view arrives. */
export function viewFromTail(tail: ViewTail): SessionView {
  const { turn_offset: _offset, prev_turn_id: _prev, files_key: _key, files_changed, ...rest } = tail;
  return { ...rest, files_changed: files_changed ?? [] };
}

/**
 * True when laying the tail over the view would not change what the reader
 * sees. The check is how a warm open avoids rebuilding rows that are already
 * on screen.
 */
export function tailMatches(view: SessionView, tail: ViewTail): boolean {
  if (view.session_id !== tail.session_id) return false;
  if (view.turns.length !== tail.turn_offset + tail.turns.length) return false;
  if ((view.turns[tail.turn_offset - 1]?.turn_id ?? null) !== tail.prev_turn_id) return false;
  if (filesKeyOf(view) !== tail.files_key) return false;
  if (view.status !== tail.status || view.busy !== tail.busy) return false;
  if (view.title !== tail.title || view.workspace !== tail.workspace) return false;
  if (view.revert_turn_id !== tail.revert_turn_id) return false;
  if ((view.parent_session_id ?? null) !== (tail.parent_session_id ?? null)) return false;
  if ((view.goal ?? null) !== (tail.goal ?? null)) return false;
  if ((view.goal_met === true) !== (tail.goal_met === true)) return false;
  if ((view.goal_paused === true) !== (tail.goal_paused === true)) return false;
  if ((view.archived === true) !== (tail.archived === true)) return false;
  if ((view.deleted === true) !== (tail.deleted === true)) return false;
  if (JSON.stringify(view.orphans ?? []) !== JSON.stringify(tail.orphans ?? [])) return false;
  if (JSON.stringify(view.totals) !== JSON.stringify(tail.totals)) return false;
  if (JSON.stringify(view.pending_permissions) !== JSON.stringify(tail.pending_permissions)) return false;
  if (JSON.stringify(view.pending_questions ?? []) !== JSON.stringify(tail.pending_questions ?? [])) return false;
  if (JSON.stringify(view.plan ?? []) !== JSON.stringify(tail.plan ?? [])) return false;
  return JSON.stringify(view.turns.slice(tail.turn_offset)) === JSON.stringify(tail.turns);
}
