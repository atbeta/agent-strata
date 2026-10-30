import { createMemo } from "solid-js";
import type { Turn } from "./api";

export function shareTurnIds(previous: readonly string[], next: readonly string[]): readonly string[] {
  return previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next;
}

export function createTurnIds(turns: () => readonly Turn[]): () => readonly string[] {
  return createMemo(() => turns().map((turn) => turn.turn_id), undefined, {
    equals: (previous, next) => shareTurnIds(previous, next) === previous,
  });
}
