import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { createTraceData } from "./trace-data";
import type { TraceBlock } from "./trace-model";

/**
 * The trace panel and the replay it drives: which block is selected, the seq
 * the transcript is rewound to, and the trace's event store.
 */
export function useTraceReplay(props: { id: string }, head: Accessor<number | undefined>) {
  const [replayPos, setReplayPos] = createSignal<number | null>(null);
  const [traceOn, setTraceOn] = createSignal(false);
  /**
   * Selection is a key, not the block: the trace keeps loading while a session
   * runs, and a stored object would show yesterday's data. `traceBlock`
   * resolves the key against the freshest load every read.
   */
  const [traceKey, setTraceKey] = createSignal<string | null>(null);
  /** bumped when events may have been re-sequenced (rebuild, re-import) —
   *  the trace reloads fully instead of appending duplicates */
  const [traceEpoch, setTraceEpoch] = createSignal(0);

  /**
   * The trace's event store: paged on open, appended to as the head advances,
   * thrown away when the epoch bumps. Fetches nothing while the trace is off.
   */
  const trace = createTraceData({
    sessionId: () => props.id,
    head: () => head(),
    epoch: traceEpoch,
    enabled: traceOn,
  });
  /** the block behind the drawer — resolved by key so live data flows in */
  const traceBlock = createMemo(() => {
    const key = traceKey();
    if (!key) return null;
    return trace.blocks().find((b) => b.key === key) ?? null;
  });
  const traceParent = createMemo(() => {
    const b = traceBlock();
    return b?.parentKey ? trace.blocks().find((x) => x.key === b.parentKey) : undefined;
  });
  /** idle time between the previous block's end and the selected one's start */
  const traceGap = createMemo(() => {
    const b = traceBlock();
    if (!b) return undefined;
    const all = trace.blocks();
    const i = all.indexOf(b);
    if (i <= 0) return undefined;
    return Math.max(0, b.startTs - all[i - 1]!.endTs);
  });

  // Keyboard selection moves fast; the replay view fetch must not fire per
  // keypress. The key is stored at once, the fetch is debounced.
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  const requestReplay = (seq: number, debounce: boolean) => {
    clearTimeout(replayTimer);
    replayTimer = undefined;
    if (debounce) replayTimer = setTimeout(() => setReplayPos(seq), 120);
    else setReplayPos(seq);
  };
  const clearReplay = () => {
    clearTimeout(replayTimer);
    replayTimer = undefined;
    setReplayPos(null);
  };
  const toggleTrace = () => {
    if (traceOn()) {
      setTraceOn(false);
      setTraceKey(null);
      clearReplay();
    } else {
      setTraceOn(true);
    }
  };
  onCleanup(() => clearTimeout(replayTimer));

  /** Selecting the selected block again lets go of it. */
  const selectTrace = (block: TraceBlock, opts?: { debounce?: boolean }) => {
    if (traceKey() === block.key) {
      setTraceKey(null);
      clearReplay();
      return;
    }
    setTraceKey(block.key);
    requestReplay(block.seq, opts?.debounce === true);
  };
  /** Back to the live transcript, the trace still open. */
  const deselectTrace = () => {
    setTraceKey(null);
    clearReplay();
  };
  /** A different session: live, trace closed. */
  const resetTrace = () => {
    clearReplay();
    setTraceOn(false);
    setTraceKey(null);
  };
  const resequenceTrace = () => setTraceEpoch((e) => e + 1);

  return {
    replayPos,
    traceOn,
    traceKey,
    traceBlocks: trace.blocks,
    traceLoading: trace.loading,
    traceBlock,
    traceParent,
    traceGap,
    toggleTrace,
    selectTrace,
    deselectTrace,
    resetTrace,
    resequenceTrace,
  };
}
