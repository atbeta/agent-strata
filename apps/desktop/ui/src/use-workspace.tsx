import { createMemo, createResource, createSignal } from "solid-js";
import { getJson, type WorkspaceInfo } from "./api";
import { settled } from "./resource";

const LAST_DIR_KEY = "strata.lastDir";
const ADDED_DIRS_KEY = "strata.projectDirs";

function readDirs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ADDED_DIRS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string" && !!d) : [];
  } catch {
    return [];
  }
}

/**
 * The sidebar's project directories: what the service reports, plus the paths
 * a person opened by hand — a project is a place sessions live, so one with
 * none yet still belongs in the list — and the directory the last new session
 * aimed at, which is where the bare "+" keeps firing until pointed elsewhere.
 *
 * There is no "current workspace" to pick: the list shows every project it
 * knows and a fold does the focusing. That was the whole argument for dropping
 * the picker — two ways to say the same thing, one of them modal.
 */
export function useWorkspace() {
  const [lastDir, setLastDir] = createSignal<string | null>(localStorage.getItem(LAST_DIR_KEY));
  const [addedDirs, setAddedDirs] = createSignal<string[]>(readDirs());
  // The reader's own additions ride along as `dir` params: a just-added place
  // has no sessions yet, so nothing the service already knows can say what
  // kind of directory it is — and the answer decides which actions it shows.
  const [wsList, { refetch: refetchWs }] = createResource(addedDirs, (dirs) => {
    const q = dirs.map((d) => `dir=${encodeURIComponent(d)}`).join("&");
    return getJson<{ workspaces: WorkspaceInfo[] }>(`/workspaces${q ? `?${q}` : ""}`);
  });
  const [dirOpen, setDirOpen] = createSignal(false);
  const [dirDraft, setDirDraft] = createSignal("");

  const projectDirs = () => {
    const dirs = new Set<string>();
    for (const w of settled(wsList)?.workspaces ?? []) {
      if (w.directory) dirs.add(w.directory);
    }
    for (const d of addedDirs()) dirs.add(d);
    return [...dirs];
  };

  /** What a directory is a worktree of — repo and branch — when it is one. */
  const worktrees = createMemo(() => {
    const map = new Map<string, NonNullable<WorkspaceInfo["worktree"]>>();
    for (const w of settled(wsList)?.workspaces ?? []) {
      if (w.worktree) map.set(w.directory, w.worktree);
    }
    return map;
  });
  const worktreeOf = (dir: string | undefined) =>
    dir === undefined ? undefined : worktrees().get(dir);

  /** The repository a directory sits inside — the answer's absence hides the
      worktree action, since a worktree needs a repo to fork. */
  const repos = createMemo(() => {
    const map = new Map<string, string>();
    for (const w of settled(wsList)?.workspaces ?? []) {
      if (w.repo) map.set(w.directory, w.repo);
    }
    return map;
  });
  const repoOf = (dir: string | undefined) =>
    dir === undefined ? undefined : repos().get(dir);

  const rememberDir = (dir: string | undefined) => {
    if (!dir) return;
    setLastDir(dir);
    localStorage.setItem(LAST_DIR_KEY, dir);
  };

  /**
   * Add a directory the list should know about.
   *
   * Returns whether it became a place to work in, so a caller that reacts to
   * that — switching which axis the list is cut by, for one — does not act on
   * an empty or unchanged path.
   */
  const addDir = (dir: string): boolean => {
    const d = dir.trim();
    if (!d) return false;
    if (!addedDirs().includes(d)) {
      const next = [...addedDirs(), d];
      setAddedDirs(next);
      localStorage.setItem(ADDED_DIRS_KEY, JSON.stringify(next));
    }
    rememberDir(d);
    setDirOpen(false);
    setDirDraft("");
    return true;
  };

  /** Whether a place is on the list only because someone opened it by hand —
      a session does not point there. Only then is "remove from list" honest:
      it takes away a bookmark, not a project. */
  const isBookmark = (dir: string) => addedDirs().includes(dir);

  /**
   * Takes a hand-opened place off the list. Local bookkeeping only — nothing
   * on disk and nothing on a backend is touched, because nothing there knows
   * this entry exists. A session arriving for the directory later brings the
   * group back on its own, which is the correct way for the list to say the
   * place is real again.
   */
  const removeDir = (dir: string) => {
    if (!isBookmark(dir)) return;
    const next = addedDirs().filter((d) => d !== dir);
    setAddedDirs(next);
    localStorage.setItem(ADDED_DIRS_KEY, JSON.stringify(next));
    // The bare "+" must not keep aiming at a place the reader just took off
    // the list; falling back to the active session's project is the honest
    // answer once the bookmark is gone.
    if (lastDir() === dir) {
      setLastDir(null);
      localStorage.removeItem(LAST_DIR_KEY);
    }
  };

  /** The desktop shell's directory chooser. Browsers can't reach the native
      dialog, so the sidebar keeps the typed-path popover as its fallback.
      Returns the directory when one was actually chosen: a cancelled picker
      resolves with nothing, and a caller that switches what the list shows has
      to know the difference. */
  const pickDir = async (): Promise<string | undefined> => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return undefined;
    addDir(dir);
    return dir;
  };

  return {
    wsList,
    refetchWs,
    lastDir,
    rememberDir,
    projectDirs,
    worktreeOf,
    repoOf,
    dirOpen,
    setDirOpen,
    dirDraft,
    setDirDraft,
    addDir,
    isBookmark,
    removeDir,
    pickDir,
  };
}

export type WorkspaceCtl = ReturnType<typeof useWorkspace>;
