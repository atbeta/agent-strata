/**
 * Row heights and offsets for a transcript, pulled out of the virtual list.
 *
 * The list renders from this and the scroll owner reads from it, so both agree
 * on where a row stands. Heights are learned as rows mount: a row that has been
 * on screen keeps its measurement, a row that has not falls back to
 * `estimate`, and the prefix sum folds the gap between rows into every offset
 * so the scrollbar covers the whole column.
 */
import { createSignal } from "solid-js";

/** Sub-pixel height churn is noise; rebuilding the prefix sum for 0.2px is not free. */
const EPS = 0.5;

export interface RowLayout {
  ids: () => readonly string[];
  /** Prefix sums of (height + gap). [i] = top of row i in list coordinates, [n] = extent. */
  offsets: () => Float64Array;
  end: () => number;
  heightOf: (i: number) => number; // measured ?? estimate
  /** -1 when absent. */
  indexOf: (id: string) => number;
  /** List-relative y → index; ids.length when past the end. */
  rowAt: (y: number) => number;
  isMeasured: (id: string) => boolean;
  /**
   * One signal write per call. Ignores |Δ| < 0.5 — a row never measured still
   * occupies `estimate` in the prefix sum, so its first real height displaces
   * everything below it exactly like a change does. Calls onHeight for each
   * changed id.
   */
  commit: (heights: ReadonlyMap<string, number>) => void;
}

export function createRowLayout(opts: {
  ids: () => readonly string[];
  /** Height for a row that has not been measured and has no estimate of its own. */
  estimate: number;
  /**
   * Per-row heights for rows that have not been measured, by row id.
   *
   * Rows are not one size. A turn split into segments has a first segment
   * that carries the turn's own block and continuations that carry messages
   * alone, and a one-message turn is a fraction of either. One number for
   * every row makes the scrollbar wrong by the widest of them, in whichever
   * direction that is.
   */
  estimates?: () => ReadonlyMap<string, number>;
  gap: number;
  /** "row i+1 continues row i": no gap is folded in after a row its successor continues. */
  joined?: (i: number) => boolean;
  seed?: ReadonlyMap<string, number>;
  onHeight?: (id: string, height: number) => void;
}): RowLayout {
  const [measured, setMeasured] = createSignal<ReadonlyMap<string, number>>(new Map(opts.seed));

  /**
   * The prefix sum and the id index are cached by identity: a new `measured`
   * map or a new ids array means recompute, and reading either signal inside an
   * effect is what subscribes that effect to the change.
   */
  let cachedOffsets: Float64Array | undefined;
  let offsetsIds: readonly string[] | undefined;
  let offsetsMeasured: ReadonlyMap<string, number> | undefined;
  let offsetsEstimates: ReadonlyMap<string, number> | undefined;
  const offsets = (): Float64Array => {
    const known = measured();
    const ids = opts.ids();
    const ests = opts.estimates?.();
    if (
      !cachedOffsets ||
      known !== offsetsMeasured ||
      ids !== offsetsIds ||
      ests !== offsetsEstimates
    ) {
      const out = new Float64Array(ids.length + 1);
      let acc = 0;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        out[i] = acc;
        acc += (known.get(id) ?? ests?.get(id) ?? opts.estimate) + (opts.joined?.(i) ? 0 : opts.gap);
      }
      out[ids.length] = acc;
      cachedOffsets = out;
      offsetsMeasured = known;
      offsetsIds = ids;
      offsetsEstimates = ests;
    }
    return cachedOffsets;
  };

  let indexIds: readonly string[] | undefined;
  let indexMap: Map<string, number> | undefined;
  const index = (): Map<string, number> => {
    const ids = opts.ids();
    if (ids !== indexIds || !indexMap) {
      indexMap = new Map();
      for (let i = 0; i < ids.length; i++) indexMap.set(ids[i]!, i);
      indexIds = ids;
    }
    return indexMap;
  };

  return {
    ids: opts.ids,
    offsets,
    end: () => offsets()[opts.ids().length] ?? 0,
    heightOf: (i) => {
      const id = opts.ids()[i];
      if (id === undefined) return opts.estimate;
      return measured().get(id) ?? opts.estimates?.().get(id) ?? opts.estimate;
    },
    indexOf: (id) => index().get(id) ?? -1,
    rowAt: (y) => {
      const o = offsets();
      let lo = 0;
      let hi = o.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (o[mid + 1]! <= y) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    isMeasured: (id) => measured().has(id),
    commit: (heights) => {
      const current = measured();
      const ests = opts.estimates?.();
      let next: Map<string, number> | undefined;
      for (const [id, height] of heights) {
        const prev = current.get(id) ?? ests?.get(id) ?? opts.estimate;
        if (Math.abs(prev - height) < EPS) continue;
        next ??= new Map(current);
        next.set(id, height);
        opts.onHeight?.(id, height);
      }
      if (next) setMeasured(next);
    },
  };
}
