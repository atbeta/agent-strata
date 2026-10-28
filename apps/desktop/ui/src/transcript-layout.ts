/**
 * Where a transcript was, so the next one can open there.
 *
 * Focusing a pane mounts a new list. The list it replaces already measured
 * every row on screen and already knew which row the reader was in. Neither
 * fact used to leave with it: the new list guessed 100px for every row, so the
 * turns stacked on top of each other, and it scrolled to a pixel offset taken
 * from a coordinate system that no longer existed. Measurements then arrived
 * and the column jumped into place.
 *
 * Heights are kept per pane and session. A split can make the same
 * conversation narrower in one pane than the other, and a narrower column
 * wraps taller. The reading position is a row plus how far into that row the
 * viewport has moved, which stays meaningful when a row above it changes
 * height.
 */

/**
 * Height of a row nobody has measured. Shared with every transcript list.
 *
 * 100px was about a third of a real turn, so the same pixel window mounted
 * roughly three times the rows on screen and each one parsed markdown in that
 * frame. A guess near the real height mounts a handful. A short row leaves a
 * gap until it is measured, and the list already corrects for that. A low
 * guess stacked the rows and parsed the extras.
 */
export const ROW_ESTIMATE = 320;

/** Space between rows, included after every row the way the list's prefix sum does. */
export const ROW_GAP = 32;

const EPS = 0.5;

const heights = new Map<string, Map<string, number>>();
const readings = new Map<string, Reading>();

import type { Reading } from "./scroll-owner";

export type { Reading };

export function layoutKey(paneId: string, sessionId: string): string {
  return `${paneId}:${sessionId}`;
}

export function readRowHeights(key: string): ReadonlyMap<string, number> {
  return heights.get(key) ?? EMPTY;
}

export function writeRowHeight(key: string, turnId: string, height: number): void {
  if (!turnId || !height) return;
  let rows = heights.get(key);
  if (!rows) {
    rows = new Map();
    heights.set(key, rows);
  }
  const prev = rows.get(turnId);
  if (prev !== undefined && Math.abs(prev - height) < EPS) return;
  rows.set(turnId, height);
}

export function rememberReading(key: string, reading: Reading): void {
  readings.set(key, reading);
}

export function recallReading(key: string): Reading | undefined {
  return readings.get(key);
}

const EMPTY: ReadonlyMap<string, number> = new Map();
