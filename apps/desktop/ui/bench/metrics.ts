/**
 * What the bench measures, as pure functions over what the probe recorded.
 *
 * Kept apart from the browser so every definition here is unit tested: a
 * number that is plausible and wrong is worse than no number, and the last
 * round of this work went around in circles partly because each change was
 * judged by a different, unrecorded measurement.
 */

export interface Sample {
  /** rAF timestamp of the frame this sample was taken in. */
  t: number;
  st: number;
  sh: number;
  ch: number;
  /** Turn ids of the rows intersecting the scroller's viewport, top to bottom. */
  ids: string[];
  /** Each visible row's top edge, relative to the scroller's top edge. */
  tops: number[];
  /** Rows mounted in the scroller, visible or not. */
  rows: number;
  /** Pixels the bench's driver scrolled up between the previous sample and this one. */
  drive: number;
}

export interface Write {
  t: number;
  kind: string;
  from: number;
  to: number;
  /** Made by the bench's own driver rather than the app. */
  driver: boolean;
}

export interface Recording {
  samples: Sample[];
  writes: Write[];
  clicks: number[];
  errors: string[];
  longtasks: { t: number; d: number }[];
}

const within = <T extends { t: number }>(xs: readonly T[], from: number, to: number) =>
  xs.filter((x) => x.t >= from && x.t <= to);

/** Time a frame may take before the part over it counts as blocked, as in Total Blocking Time. */
export const BLOCKING_MS = 50;

export interface FrameStats {
  frames: number;
  /** Longest gap between two consecutive frames. */
  maxGap: number;
  p95Gap: number;
  /** Gaps over 50ms and over 100ms. */
  over50: number;
  over100: number;
  /** Sum over every gap of the part beyond 50ms. */
  blockedMs: number;
}

export function frameStats(samples: readonly Sample[], from: number, to: number): FrameStats {
  const s = within(samples, from, to);
  const gaps: number[] = [];
  for (let i = 1; i < s.length; i++) gaps.push(s[i]!.t - s[i - 1]!.t);
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    frames: s.length,
    maxGap: sorted.at(-1) ?? 0,
    p95Gap: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0,
    over50: gaps.filter((g) => g > 50).length,
    over100: gaps.filter((g) => g > 100).length,
    blockedMs: gaps.reduce((n, g) => n + Math.max(0, g - BLOCKING_MS), 0),
  };
}

/** Programmatic scrolls of the transcript the app made itself, and how far they moved it in total. */
export function appWrites(writes: readonly Write[], from: number, to: number): { count: number; movedPx: number } {
  const w = within(writes, from, to).filter((x) => !x.driver);
  return { count: w.length, movedPx: w.reduce((n, x) => n + Math.abs(x.to - x.from), 0) };
}

export interface DriftStats {
  /** Frame pairs that shared a visible row, so drift could be measured. */
  frames: number;
  maxAbs: number;
  sumAbs: number;
  /** Frame pairs where content moved more than 2px on its own. */
  over2: number;
}

/**
 * Content moving under a reader who is scrolling.
 *
 * Between two samples the driver scrolled up by `b.drive` px, so every row
 * still on screen should have moved down by exactly that much. Anything else
 * is the page moving on its own: a row above changed height and nothing
 * compensated, or a compensation overshot. Whether the browser or the app did
 * the compensating does not matter — what counts is what the reader saw.
 *
 * The row measured is the shared one nearest the middle of the viewport,
 * where a reader's eye is. A row whose own height changes does not move its
 * own top edge, so the topmost row would miss exactly the shift readers see.
 */
export function drift(samples: readonly Sample[], from: number, to: number): DriftStats {
  const s = within(samples, from, to);
  const out: DriftStats = { frames: 0, maxAbs: 0, sumAbs: 0, over2: 0 };
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    const mid = b.ch / 2;
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < b.ids.length; j++) {
      if (!a.ids.includes(b.ids[j]!)) continue;
      const dist = Math.abs(b.tops[j]! - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = j;
      }
    }
    if (best < 0) continue;
    const before = a.tops[a.ids.indexOf(b.ids[best]!)]!;
    const d = Math.abs(b.tops[best]! - before - b.drive);
    out.frames += 1;
    out.sumAbs += d;
    if (d > out.maxAbs) out.maxAbs = d;
    if (d > 2) out.over2 += 1;
  }
  return out;
}

/**
 * How close to the end of the scroll range counts as "at the tail".
 *
 * The list pins to its own extent, and the column around it is padded 16px
 * top and bottom, so a pinned transcript leaves 32px of scroll range below it.
 * The last turn being on screen is the other half of the condition.
 */
export const TAIL_PX = 48;

export interface OpenStats {
  /** From the start of the open to the first frame showing this session's rows. */
  firstContentMs: number | null;
  /** Lowest turn index painted between first content and settling. */
  minIndexShown: number | null;
  /** True when a turn from the head of the conversation was painted on the way to the tail. */
  headShown: boolean;
  /** Frames with no rows on screen after content had first appeared. */
  blankFrames: number;
  atTail: boolean;
}

/** Rows above the final screen a settling tail may show without counting as the head. */
export const HEAD_SLACK_ROWS = 2;

/** A turn index counts as "the head" when it is further than this from the end. */
export function headLimit(count: number): number {
  return count - Math.max(5, Math.ceil(count * 0.1));
}

export function openStats(samples: readonly Sample[], order: readonly string[], from: number, settledAt: number): OpenStats {
  const index = new Map(order.map((id, i) => [id, i]));
  const s = within(samples, from, Number.POSITIVE_INFINITY);
  const first = s.find((x) => x.ids.length > 0 && x.ids.every((id) => index.has(id)));
  let minIndex: number | null = null;
  let blank = 0;
  if (first) {
    for (const x of s) {
      if (x.t < first.t || x.t > settledAt) continue;
      if (x.ids.length === 0) blank += 1;
      for (const id of x.ids) {
        const i = index.get(id);
        if (i !== undefined && (minIndex === null || i < minIndex)) minIndex = i;
      }
    }
  }
  const last = s.at(-1);
  const atTail =
    !!last && last.sh - last.st - last.ch <= TAIL_PX && order.length > 0 && last.ids.includes(order.at(-1)!);
  // A short session can have its head on the final screen. Only turns above
  // both the head limit and the first turn the open settled on were passed
  // through on the way — with a couple of rows of slack, because a tail screen
  // whose rows are still growing into their painted height legitimately shows
  // a row or two above where it ends up.
  const finalFirst = last?.ids.length ? index.get(last.ids[0]!) : undefined;
  const limit = Math.min(headLimit(order.length), (finalFirst ?? Number.POSITIVE_INFINITY) - HEAD_SLACK_ROWS);
  return {
    firstContentMs: first ? first.t - from : null,
    minIndexShown: minIndex,
    headShown: minIndex !== null && minIndex < limit,
    blankFrames: blank,
    atTail,
  };
}

export interface SwitchStats {
  /** How long after the switch the previous session's rows were still on screen. */
  staleMs: number;
  /** First frame showing only the new session's rows. */
  firstCorrectMs: number | null;
  /** Frames with no rows at all, before and after the new session first appeared. */
  blankBefore: number;
  blankAfter: number;
}

export function switchStats(
  samples: readonly Sample[],
  prev: ReadonlySet<string>,
  next: readonly string[],
  from: number,
  settledAt: number,
): SwitchStats {
  const want = new Set(next);
  const s = samples.filter((x) => x.t >= from && x.t <= settledAt);
  let stale = 0;
  let first: number | null = null;
  let before = 0;
  let after = 0;
  for (const x of s) {
    if (x.ids.some((id) => prev.has(id) && !want.has(id))) stale = x.t - from;
    if (first === null && x.ids.length > 0 && x.ids.every((id) => want.has(id))) first = x.t;
    if (x.ids.length === 0) {
      if (first === null) before += 1;
      else after += 1;
    }
  }
  return { staleMs: stale, firstCorrectMs: first === null ? null : first - from, blankBefore: before, blankAfter: after };
}

/** Where the reader is: the top visible row and how far its top edge sits from the viewport's. */
export interface Place {
  id: string;
  top: number;
}

export function placeOf(sample: Sample | undefined): Place | null {
  if (!sample || sample.ids.length === 0) return null;
  return { id: sample.ids[0]!, top: sample.tops[0]! };
}

/** How far a remembered place is from where the reader actually is now; null when the row is not on screen. */
export function placeError(place: Place, sample: Sample | undefined): number | null {
  if (!sample) return null;
  const i = sample.ids.indexOf(place.id);
  return i < 0 ? null : Math.abs(sample.tops[i]! - place.top);
}

/** The gap `virtual-tail.ts` leaves above a row the reader jumped to. */
export const JUMP_GAP = 12;

export interface JumpStats {
  /** From the click to the first frame whose scroll position differs from the click's. */
  firstMoveMs: number | null;
  /** Distance of the target's top edge from where a jump should put it; null if it is not on screen. */
  landingError: number | null;
}

export function jumpStats(samples: readonly Sample[], target: string, clickAt: number): JumpStats {
  const s = samples.filter((x) => x.t >= clickAt);
  const base = samples.filter((x) => x.t < clickAt).at(-1)?.st;
  const moved = base === undefined ? undefined : s.find((x) => x.st !== base);
  const last = s.at(-1);
  const i = last ? last.ids.indexOf(target) : -1;
  return {
    firstMoveMs: moved ? moved.t - clickAt : null,
    landingError: i < 0 ? null : Math.abs(last!.tops[i]! - JUMP_GAP),
  };
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
