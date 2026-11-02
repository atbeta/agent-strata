import { createMemo } from "solid-js";
import type { Turn } from "./api";
import { stableKeys } from "./keyed";

/** Row ids of any item list, sharing the previous array while nothing in it moved. */
export function createIds<T>(items: () => readonly T[], id: (item: T) => string): () => readonly string[] {
  return createMemo(() => items().map(id), undefined, {
    equals: (previous, next) => stableKeys(previous, next) === previous,
  });
}

export function createTurnIds(turns: () => readonly Turn[]): () => readonly string[] {
  return createIds(turns, (turn) => turn.turn_id);
}
