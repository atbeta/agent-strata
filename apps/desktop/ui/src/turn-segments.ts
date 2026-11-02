import type { Turn } from "./api";
import { attributionOf } from "./turn-attribution";

/**
 * One turn can hold hundreds of assistant messages, and mounted whole it is a
 * row that takes hundreds of milliseconds to build and cannot be windowed —
 * the reader pays for all of it the moment any of it is on screen. The virtual
 * list is generic over row ids, so a turn is cut into fixed-size parts and
 * each part becomes a row of its own.
 *
 * A row mounts whole, in one frame, so the size of a part is the size of the
 * longest frame a reader can scroll into. Twelve heavy messages laid out at
 * once was a 50ms frame in WebKit; six is about half that. Smaller costs a few
 * ms on a jump into a giant turn, which mounts more rows to land.
 */
export const SEGMENT_MESSAGES = 6;

/** A slice of a turn's assistant messages: absolute indexes into turn.assistant, msgTo exclusive. */
export interface TurnPart {
  part: number;
  /** True on the slice that ends the turn — it owns the footer, loose calls, awaiting, compaction. */
  last: boolean;
  msgFrom: number;
  msgTo: number;
}

export interface TurnSegment extends TurnPart {
  /** Row id: the turn id for part 0, `${turnId}#${part}` after it. */
  id: string;
  turn: Turn;
  turnIndex: number;
}

/** Part 0 keeps the turn's own id so jumpTo, remembered readings and the outline resolve unchanged. */
export function segmentId(turnId: string, part: number): string {
  return part === 0 ? turnId : `${turnId}#${part}`;
}

/**
 * What a segment is expected to be tall, before it has been measured.
 *
 * One number for every row is wrong in both directions, and the two errors
 * pull against each other: a turn of one long reply draws several hundred
 * pixels, a segment of twelve short ones draws several times that. A single
 * guess is either too tall for most rows — the scrollbar claims twice the
 * conversation — or too short for the big ones, and then the scrollbar grows
 * under the reader as the tall rows are measured.
 *
 * The guess is built from what the row holds: the turn's own block, which
 * only its first segment carries, the characters of the messages, and a row
 * for each tool call. Tool output does not add to it — its box is capped, so
 * a longer answer is not a taller row.
 */
export const TURN_BASE = 120;
export const MESSAGE_CHARS = 0.2;
export const TOOL_ROW = 60;

/**
 * By segment object. `turnSegments` hands back the same object while its turn
 * and span hold, so the whole list is estimated again only where it changed.
 */
const estimated = new WeakMap<TurnSegment, number>();

export function estimateSegmentHeight(seg: TurnSegment): number {
  const hit = estimated.get(seg);
  if (hit !== undefined) return hit;
  const height = estimateFresh(seg);
  estimated.set(seg, height);
  return height;
}

function estimateFresh(seg: TurnSegment): number {
  const msgs = seg.turn.assistant;
  let chars = 0;
  for (let i = seg.msgFrom; i < seg.msgTo; i++) {
    for (const b of msgs[i]?.content ?? []) {
      // A thought is drawn too, and it is text like any other.
      if (b.type === "text" || b.type === "thinking") chars += b.text.length;
    }
  }
  const { byMessage } = attributionOf(seg.turn);
  let calls = 0;
  for (let i = seg.msgFrom; i < seg.msgTo; i++) calls += byMessage.get(i)?.length ?? 0;
  // Whole pixels: a fractional height puts the prefix sum off a pixel
  // boundary, and the browser rounds the rows onto the device grid, so the
  // content moves under a reader who is only scrolling.
  return Math.round((seg.part === 0 ? TURN_BASE : 0) + chars * MESSAGE_CHARS + calls * TOOL_ROW);
}

/**
 * The rows the virtual list mounts for `turns`. `prev` is the last result:
 * a segment whose turn object and span are unchanged is handed back as the
 * same object, so a streaming tick leaves every row it did not touch alone.
 */
export function turnSegments(turns: readonly Turn[], prev?: readonly TurnSegment[]): TurnSegment[] {
  let byId: Map<string, TurnSegment> | undefined;
  if (prev?.length) {
    byId = new Map();
    for (const s of prev) byId.set(s.id, s);
  }
  const out: TurnSegment[] = [];
  turns.forEach((turn, turnIndex) => {
    const len = turn.assistant.length;
    const parts = Math.max(1, Math.ceil(len / SEGMENT_MESSAGES));
    for (let part = 0; part < parts; part++) {
      const msgFrom = part * SEGMENT_MESSAGES;
      const msgTo = Math.min(msgFrom + SEGMENT_MESSAGES, len);
      const last = part === parts - 1;
      const id = segmentId(turn.turn_id, part);
      const old = byId?.get(id);
      if (
        old !== undefined &&
        old.turn === turn &&
        old.turnIndex === turnIndex &&
        old.part === part &&
        old.last === last &&
        old.msgFrom === msgFrom &&
        old.msgTo === msgTo
      ) {
        out.push(old);
        continue;
      }
      out.push({ id, turn, turnIndex, part, last, msgFrom, msgTo });
    }
  });
  return out;
}
