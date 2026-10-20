/**
 * The prompt rail's own geometry.
 *
 * LibreChat pins a previous/next step and a start/end dot outside the
 * scrolling column, and widens the ribs under the pointer with a cosine
 * falloff. The ticks here are one line per prompt; the same split keeps the
 * ends reachable once the column is taller than its cap.
 */

/** Cosine bell: 1 on the pointer, 0 at `influence`. */
export function magnifyFalloff(distance: number, influence: number): number {
  if (influence <= 0 || distance >= influence) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * distance) / influence));
}

/** Resting width at the edge of the falloff, peak width under the pointer. */
export function magnifiedWidth(
  base: number,
  peak: number,
  distance: number,
  influence: number,
): number {
  const t = magnifyFalloff(distance, influence);
  return base + (peak - base) * t;
}

/** True when the ticks cannot all sit in the rail's cap. */
export function railOverflows(entryCount: number, rowPx: number, capPx: number): boolean {
  if (entryCount <= 0 || rowPx <= 0 || capPx <= 0) return false;
  return entryCount * rowPx > capPx + 0.5;
}

export type NavSteps = {
  previousId?: string;
  nextId?: string;
  firstId: string;
  lastId: string;
};

/**
 * Arrows walk one prompt away from the one on screen. The dots are the first
 * and last prompt, pinned so a scrolled rail never hides them.
 */
export function navSteps(ids: readonly string[], activeId: string | undefined): NavSteps | undefined {
  if (ids.length === 0) return undefined;
  const i = activeId == null ? -1 : ids.indexOf(activeId);
  return {
    previousId: i > 0 ? ids[i - 1] : undefined,
    nextId: i >= 0 && i < ids.length - 1 ? ids[i + 1] : i < 0 ? ids[0] : undefined,
    firstId: ids[0],
    lastId: ids[ids.length - 1],
  };
}
