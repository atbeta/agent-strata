import type { Turn } from "./api";

/**
 * One turn can hold hundreds of assistant messages, and mounted whole it is a
 * row that takes hundreds of milliseconds to build and cannot be windowed —
 * the reader pays for all of it the moment any of it is on screen. The virtual
 * list is generic over row ids, so a turn is cut into fixed-size parts and
 * each part becomes a row of its own.
 */
export const SEGMENT_MESSAGES = 12;

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
