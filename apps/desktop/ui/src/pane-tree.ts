export type SplitDir = "row" | "col";

export type PaneLeaf = {
  kind: "leaf";
  id: string;
  sessionId: string | null;
};

export type PaneSplit = {
  kind: "split";
  id: string;
  dir: SplitDir;
  /** Share of the first child `a`, clamped to [RATIO_MIN, RATIO_MAX]. */
  ratio: number;
  a: PaneNode;
  b: PaneNode;
};

export type PaneNode = PaneLeaf | PaneSplit;

export type PaneMode = "single" | "multiplex";

export type LayoutPreset = "single" | "cols-2" | "rows-2" | "grid-4";

export type PaneWorkspaceState = {
  mode: PaneMode;
  root: PaneNode;
  focusedPaneId: string;
  zoomedPaneId: string | null;
};

export const PANES_STORAGE_KEY = "strata.panes.v1";
export const RATIO_MIN = 0.18;
export const RATIO_MAX = 0.82;
export const RATIO_DEFAULT = 0.5;

let nextSeq = 1;

function makeId(prefix: "pane" | "split", taken: ReadonlySet<string>): string {
  while (taken.has(`${prefix}-${nextSeq}`)) nextSeq += 1;
  const id = `${prefix}-${nextSeq}`;
  nextSeq += 1;
  return id;
}

function collectIds(node: PaneNode, out = new Set<string>()): Set<string> {
  out.add(node.id);
  if (node.kind === "split") {
    collectIds(node.a, out);
    collectIds(node.b, out);
  }
  return out;
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return RATIO_DEFAULT;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, Math.round(ratio * 1000) / 1000));
}

export function listLeaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === "leaf") return [node];
  return [...listLeaves(node.a), ...listLeaves(node.b)];
}

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | undefined {
  if (node.kind === "leaf") return node.id === paneId ? node : undefined;
  return findLeaf(node.a, paneId) ?? findLeaf(node.b, paneId);
}

export function findLeafBySession(node: PaneNode, sessionId: string): PaneLeaf | undefined {
  if (node.kind === "leaf") return node.sessionId === sessionId ? node : undefined;
  return findLeafBySession(node.a, sessionId) ?? findLeafBySession(node.b, sessionId);
}

export function createInitialWorkspace(initialSessionId: string | null = null): PaneWorkspaceState {
  return {
    mode: "single",
    root: { kind: "leaf", id: "pane-1", sessionId: initialSessionId },
    focusedPaneId: "pane-1",
    zoomedPaneId: null,
  };
}

/**
 * Resolve the effective focused leaf. Falls back to the first leaf if
 * `focusedPaneId` ever points at a removed node.
 */
export function focusedLeaf(state: PaneWorkspaceState): PaneLeaf {
  return findLeaf(state.root, state.focusedPaneId) ?? listLeaves(state.root)[0]!;
}

/**
 * The session ID that owns the shared header, composer dock, terminal and side
 * rail. If the focused leaf is an empty slot waiting for a choice, falls back
 * to the first populated leaf or `fallbackSessionId`.
 */
export function activeSessionOf(state: PaneWorkspaceState, fallbackSessionId: string): string {
  const current = focusedLeaf(state);
  if (current.sessionId) return current.sessionId;
  for (const leaf of listLeaves(state.root)) {
    if (leaf.sessionId) return leaf.sessionId;
  }
  return fallbackSessionId;
}

function updateLeaf(node: PaneNode, paneId: string, updater: (leaf: PaneLeaf) => PaneNode): PaneNode {
  if (node.kind === "leaf") {
    return node.id === paneId ? updater(node) : node;
  }
  const a = updateLeaf(node.a, paneId, updater);
  const b = updateLeaf(node.b, paneId, updater);
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/**
 * Route / sidebar selection policy:
 * - In `single` mode: the focused leaf takes `sessionId`.
 * - In `multiplex` mode:
 *   1. If the focused leaf already holds `sessionId`, no-op.
 *   2. If the focused leaf is empty (`null`), fill it with `sessionId`.
 *   3. Otherwise, if any other leaf is empty (`null`), fill the first empty leaf
 *      and move focus to it.
 *   4. Otherwise, replace the focused leaf's `sessionId` in place.
 */
export function assignSessionToWorkspace(
  state: PaneWorkspaceState,
  sessionId: string,
): PaneWorkspaceState {
  if (!sessionId) return state;
  const focused = focusedLeaf(state);
  if (focused.sessionId === sessionId && state.focusedPaneId === focused.id) {
    return state;
  }

  if (state.mode === "single") {
    const nextRoot = updateLeaf(state.root, focused.id, (leaf) =>
      leaf.sessionId === sessionId ? leaf : { ...leaf, sessionId },
    );
    if (nextRoot === state.root && state.focusedPaneId === focused.id) return state;
    return {
      ...state,
      root: nextRoot,
      focusedPaneId: focused.id,
    };
  }

  // Multiplex mode: fill focused if empty, else first empty slot, else replace focused.
  if (focused.sessionId === null) {
    return {
      ...state,
      root: updateLeaf(state.root, focused.id, (leaf) => ({ ...leaf, sessionId })),
      focusedPaneId: focused.id,
    };
  }

  const emptyLeaf = listLeaves(state.root).find((l) => l.sessionId === null);
  if (emptyLeaf) {
    return {
      ...state,
      root: updateLeaf(state.root, emptyLeaf.id, (leaf) => ({ ...leaf, sessionId })),
      focusedPaneId: emptyLeaf.id,
    };
  }

  return {
    ...state,
    root: updateLeaf(state.root, focused.id, (leaf) => ({ ...leaf, sessionId })),
    focusedPaneId: focused.id,
  };
}

export function focusPane(state: PaneWorkspaceState, paneId: string): PaneWorkspaceState {
  const target = findLeaf(state.root, paneId);
  if (!target) return state;
  const nextZoom = state.zoomedPaneId && state.zoomedPaneId !== paneId ? null : state.zoomedPaneId;
  if (state.focusedPaneId === paneId && nextZoom === state.zoomedPaneId) return state;
  return {
    ...state,
    focusedPaneId: paneId,
    zoomedPaneId: nextZoom,
  };
}

export function setPaneSession(
  state: PaneWorkspaceState,
  paneId: string,
  sessionId: string | null,
): PaneWorkspaceState {
  const target = findLeaf(state.root, paneId);
  if (!target) return state;
  return {
    ...state,
    root: updateLeaf(state.root, paneId, (leaf) => ({ ...leaf, sessionId })),
    focusedPaneId: paneId,
  };
}

/**
 * Split a pane horizontally (`row`, left/right) or vertically (`col`, top/bottom).
 * Automatically enters `multiplex` mode and focuses the newly created pane.
 */
export function splitPane(
  state: PaneWorkspaceState,
  paneId: string,
  dir: SplitDir,
  newSessionId: string | null = null,
): PaneWorkspaceState {
  const target = findLeaf(state.root, paneId) ?? focusedLeaf(state);
  const taken = collectIds(state.root);
  const newLeafId = makeId("pane", taken);
  taken.add(newLeafId);
  const splitId = makeId("split", taken);

  const nextRoot = updateLeaf(state.root, target.id, (leaf) => ({
    kind: "split",
    id: splitId,
    dir,
    ratio: RATIO_DEFAULT,
    a: leaf,
    b: {
      kind: "leaf",
      id: newLeafId,
      sessionId: newSessionId,
    },
  }));

  return {
    mode: "multiplex",
    root: nextRoot,
    focusedPaneId: newLeafId,
    zoomedPaneId: null,
  };
}

function removeNode(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === "leaf") {
    return node.id === paneId ? null : node;
  }
  const nextA = removeNode(node.a, paneId);
  const nextB = removeNode(node.b, paneId);
  if (nextA === null) return nextB;
  if (nextB === null) return nextA;
  if (nextA === node.a && nextB === node.b) return node;
  return { ...node, a: nextA, b: nextB };
}

/**
 * Close a pane. If only one leaf remains, returns to `single` mode automatically.
 * When closing the focused pane, focus shifts to its nearest neighbour.
 */
export function closePane(state: PaneWorkspaceState, paneId: string): PaneWorkspaceState {
  const leaves = listLeaves(state.root);
  if (leaves.length <= 1) {
    return {
      ...state,
      mode: "single",
      zoomedPaneId: null,
    };
  }
  const idx = leaves.findIndex((l) => l.id === paneId);
  if (idx < 0) return state;

  const nextRoot = removeNode(state.root, paneId);
  if (!nextRoot) return state;

  const remaining = listLeaves(nextRoot);
  const nextFocused =
    state.focusedPaneId === paneId
      ? (leaves[idx + 1]?.id ?? leaves[idx - 1]?.id ?? remaining[0]!.id)
      : findLeaf(nextRoot, state.focusedPaneId)
        ? state.focusedPaneId
        : remaining[0]!.id;

  return {
    mode: remaining.length <= 1 ? "single" : state.mode,
    root: nextRoot,
    focusedPaneId: nextFocused,
    zoomedPaneId: state.zoomedPaneId === paneId || remaining.length <= 1 ? null : state.zoomedPaneId,
  };
}

export function resizeSplit(
  state: PaneWorkspaceState,
  splitId: string,
  ratio: number,
): PaneWorkspaceState {
  const clamped = clampSplitRatio(ratio);
  const update = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") return node;
    if (node.id === splitId) {
      return node.ratio === clamped ? node : { ...node, ratio: clamped };
    }
    const a = update(node.a);
    const b = update(node.b);
    return a === node.a && b === node.b ? node : { ...node, a, b };
  };
  const nextRoot = update(state.root);
  return nextRoot === state.root ? state : { ...state, root: nextRoot };
}

export function toggleZoomPane(state: PaneWorkspaceState, paneId: string): PaneWorkspaceState {
  if (state.mode !== "multiplex" || listLeaves(state.root).length <= 1) return state;
  if (!findLeaf(state.root, paneId)) return state;
  const unzoom = state.zoomedPaneId === paneId;
  return {
    ...state,
    focusedPaneId: paneId,
    zoomedPaneId: unzoom ? null : paneId,
  };
}

/**
 * Collect distinct session IDs to seed a preset layout:
 * 1. `activeSessionId` always comes first (for the focused pane).
 * 2. Other sessions already open in the current pane tree follow in leaf order.
 * 3. Additional `candidates` (e.g. recent sessions) fill remaining slots if needed,
 *    or slots stay `null` when no candidates are passed.
 */
function pickPresetSessions(
  state: PaneWorkspaceState,
  count: number,
  activeSessionId: string,
  candidates: readonly string[] = [],
): (string | null)[] {
  const out: (string | null)[] = [];
  const pushUnique = (id: string | null | undefined) => {
    if (!id || out.includes(id)) return;
    out.push(id);
  };
  pushUnique(activeSessionId);
  for (const leaf of listLeaves(state.root)) {
    pushUnique(leaf.sessionId);
  }
  for (const id of candidates) {
    if (out.length >= count) break;
    pushUnique(id);
  }
  while (out.length < count) {
    out.push(null);
  }
  return out.slice(0, count);
}

/**
 * Apply a layout preset:
 * - `single`: switches to traditional single-session mode while keeping the
 *   focused session active.
 * - `cols-2`: 1x2 side-by-side split.
 * - `rows-2`: 2x1 top-and-bottom split.
 * - `grid-4`: 2x2 four-pane grid.
 */
export function applyLayoutPreset(
  state: PaneWorkspaceState,
  preset: LayoutPreset,
  activeSessionId: string,
  candidates: readonly string[] = [],
): PaneWorkspaceState {
  if (preset === "single") {
    const focused = focusedLeaf(state);
    const nextRoot = updateLeaf(state.root, focused.id, (leaf) => ({
      ...leaf,
      sessionId: activeSessionId || leaf.sessionId,
    }));
    return {
      mode: "single",
      root: nextRoot,
      focusedPaneId: focused.id,
      zoomedPaneId: null,
    };
  }

  if (preset === "cols-2" || preset === "rows-2") {
    const dir: SplitDir = preset === "cols-2" ? "row" : "col";
    const [s1, s2] = pickPresetSessions(state, 2, activeSessionId, candidates);
    return {
      mode: "multiplex",
      root: {
        kind: "split",
        id: "split-root",
        dir,
        ratio: RATIO_DEFAULT,
        a: { kind: "leaf", id: "pane-1", sessionId: s1 ?? null },
        b: { kind: "leaf", id: "pane-2", sessionId: s2 ?? null },
      },
      focusedPaneId: "pane-1",
      zoomedPaneId: null,
    };
  }

  // grid-4: 2x2
  const [s1, s2, s3, s4] = pickPresetSessions(state, 4, activeSessionId, candidates);
  return {
    mode: "multiplex",
    root: {
      kind: "split",
      id: "split-root",
      dir: "col",
      ratio: RATIO_DEFAULT,
      a: {
        kind: "split",
        id: "split-top",
        dir: "row",
        ratio: RATIO_DEFAULT,
        a: { kind: "leaf", id: "pane-1", sessionId: s1 ?? null },
        b: { kind: "leaf", id: "pane-2", sessionId: s2 ?? null },
      },
      b: {
        kind: "split",
        id: "split-bottom",
        dir: "row",
        ratio: RATIO_DEFAULT,
        a: { kind: "leaf", id: "pane-3", sessionId: s3 ?? null },
        b: { kind: "leaf", id: "pane-4", sessionId: s4 ?? null },
      },
    },
    focusedPaneId: "pane-1",
    zoomedPaneId: null,
  };
}

/**
 * Toggle between single-session mode and multiplex mode.
 * If entering multiplex mode when the tree only has 1 leaf, automatically
 * creates a 2-column split so entering multiplex mode visibly splits the screen.
 */
export function setPaneMode(
  state: PaneWorkspaceState,
  mode: PaneMode,
  activeSessionId: string,
  candidates: readonly string[] = [],
): PaneWorkspaceState {
  if (mode === "single") {
    return applyLayoutPreset(state, "single", activeSessionId, candidates);
  }
  const leaves = listLeaves(state.root);
  if (leaves.length <= 1) {
    return applyLayoutPreset(state, "cols-2", activeSessionId, candidates);
  }
  const focused = focusedLeaf(state);
  const nextRoot =
    focused.sessionId === null && activeSessionId
      ? updateLeaf(state.root, focused.id, (l) => ({ ...l, sessionId: activeSessionId }))
      : state.root;
  return {
    ...state,
    mode: "multiplex",
    root: nextRoot,
    focusedPaneId: focused.id,
    zoomedPaneId: null,
  };
}

/** Detect which preset matches the current state, if any. */
export function detectPreset(state: PaneWorkspaceState): LayoutPreset | "custom" {
  if (state.mode === "single") return "single";
  const r = state.root;
  if (r.kind === "leaf") return "single";
  if (r.a.kind === "leaf" && r.b.kind === "leaf") {
    return r.dir === "row" ? "cols-2" : "rows-2";
  }
  if (
    r.dir === "col" &&
    r.a.kind === "split" &&
    r.a.dir === "row" &&
    r.a.a.kind === "leaf" &&
    r.a.b.kind === "leaf" &&
    r.b.kind === "split" &&
    r.b.dir === "row" &&
    r.b.a.kind === "leaf" &&
    r.b.b.kind === "leaf"
  ) {
    return "grid-4";
  }
  return "custom";
}

function parseNode(raw: unknown, seen: Set<string>): PaneNode | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id || seen.has(obj.id)) return null;
  if (obj.kind === "leaf") {
    seen.add(obj.id);
    const sessionId = typeof obj.sessionId === "string" && obj.sessionId ? obj.sessionId : null;
    return { kind: "leaf", id: obj.id, sessionId };
  }
  if (obj.kind === "split" && (obj.dir === "row" || obj.dir === "col")) {
    seen.add(obj.id);
    const a = parseNode(obj.a, seen);
    const b = parseNode(obj.b, seen);
    if (!a || !b) return null;
    const ratio = typeof obj.ratio === "number" ? clampSplitRatio(obj.ratio) : RATIO_DEFAULT;
    return { kind: "split", id: obj.id, dir: obj.dir, ratio, a, b };
  }
  return null;
}

export function readPaneWorkspace(
  storage: Pick<Storage, "getItem"> | undefined = typeof localStorage !== "undefined" ? localStorage : undefined,
): PaneWorkspaceState {
  try {
    const raw = storage?.getItem(PANES_STORAGE_KEY);
    if (!raw) return createInitialWorkspace();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return createInitialWorkspace();
    const seen = new Set<string>();
    const root = parseNode(parsed.root, seen);
    if (!root) return createInitialWorkspace();
    const leaves = listLeaves(root);
    if (leaves.length === 0) return createInitialWorkspace();
    const mode: PaneMode =
      parsed.mode === "multiplex" && leaves.length > 1 ? "multiplex" : "single";
    const focusedPaneId =
      typeof parsed.focusedPaneId === "string" && leaves.some((l) => l.id === parsed.focusedPaneId)
        ? parsed.focusedPaneId
        : leaves[0]!.id;
    const zoomedPaneId =
      mode === "multiplex" &&
      typeof parsed.zoomedPaneId === "string" &&
      leaves.some((l) => l.id === parsed.zoomedPaneId)
        ? parsed.zoomedPaneId
        : null;
    return { mode, root, focusedPaneId, zoomedPaneId };
  } catch {
    return createInitialWorkspace();
  }
}

export function writePaneWorkspace(
  state: PaneWorkspaceState,
  storage: Pick<Storage, "setItem"> | undefined = typeof localStorage !== "undefined" ? localStorage : undefined,
): void {
  try {
    storage?.setItem(PANES_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or quota reached.
  }
}
