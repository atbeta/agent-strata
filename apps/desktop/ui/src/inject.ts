import type { SessionView } from "./api";

/**
 * How a whole session view is put on screen.
 *
 * The view of a long session is megabytes, and landing it in one piece spends
 * a few hundred milliseconds of the main thread parsing it and rebuilding
 * every row under it — long enough that the reader watches the window stop.
 * The same view laid down in batches costs the same work spread over frames
 * instead of one.
 */
export const INJECT_FIRST = 4;
/**
 * Turns added per frame after the first batch.
 *
 * One. A turn is the largest thing that can be rendered on its own, so one turn
 * per frame is the smallest block that can be scheduled — and the block that
 * decides the length of the longest frame the reader sees. A batch of two
 * turns costs what the two of them cost, and the heaviest pair in a long
 * session measured twice the heaviest single turn.
 */
export const INJECT_BATCH = 1;
/**
 * Above this many turns, batches would take longer than the single landing
 * they were meant to improve on, so the view lands whole.
 */
export const INJECT_MAX = 96;

/**
 * How many turns are on screen after each batch.
 *
 * The first batch is the head of the session and every later batch adds the
 * turns after it. It grows forward because a batch that reaches further back
 * has to move the turns already on screen, and moving a node costs an order
 * of magnitude more than adding one. A session long enough that the batches
 * would take longer than the one landing they were meant to improve on gets a
 * single batch of everything.
 *
 * The first batch is a little larger than the rest so that a session short
 * enough to fit lands whole rather than being split across frames.
 */
export function injectionBatches(
  total: number,
  first: number = INJECT_FIRST,
  batch: number = INJECT_BATCH,
  max: number = INJECT_MAX,
): number[] {
  if (total <= 0) return [0];
  if (total > max) return [total];
  const out: number[] = [];
  let shown = Math.min(total, first);
  out.push(shown);
  while (shown < total) {
    shown = Math.min(total, shown + batch);
    out.push(shown);
  }
  return out;
}

/**
 * The turns a stored view cannot hold, carried across a batch.
 *
 * A reply still being written lives on the stream and never reaches the log,
 * so the stored view does not have it. Without carrying it, the first batch
 * would take the reply off the screen, and the cursor that marked it would go
 * with it.
 *
 * `known` is every turn the stored view holds — not just the ones on screen.
 * A turn the view has but has not shown yet is not missing from it, and
 * carrying it would show it twice.
 */
export function carryLive(
  live: SessionView["turns"] | undefined,
  known: ReadonlySet<string>,
): SessionView["turns"] {
  if (!live || !live.length) return [];
  return live.filter((t) => !known.has(t.turn_id));
}
