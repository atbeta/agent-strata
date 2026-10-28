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
  estimate: number;
  gap: number;
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
  const offsets = (): Float64Array => {
    const known = measured();
    const ids = opts.ids();
    if (!cachedOffsets || known !== offsetsMeasured || ids !== offsetsIds) {
      const out = new Float64Array(ids.length + 1);
      let acc = 0;
      for (let i = 0; i < ids.length; i++) {
        out[i] = acc;
        acc += (known.get(ids[i]!) ?? opts.estimate) + opts.gap;
      }
      out[ids.length] = acc;
      cachedOffsets = out;
      offsetsMeasured = known;
      offsetsIds = ids;
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
    heightOf: (i) => measured().get(opts.ids()[i]!) ?? opts.estimate,
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
      let next: Map<string, number> | undefined;
      for (const [id, height] of heights) {
        const prev = current.get(id) ?? opts.estimate;
        if (Math.abs(prev - height) < EPS) continue;
        next ??= new Map(current);
        next.set(id, height);
        opts.onHeight?.(id, height);
      }
      if (next) setMeasured(next);
    },
  };
}
