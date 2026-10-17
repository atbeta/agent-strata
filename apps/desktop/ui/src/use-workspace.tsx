import { createResource, createSignal } from "solid-js";
import { getJson } from "./api";
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
  const [wsList, { refetch: refetchWs }] = createResource(() =>
    getJson<{ workspaces: { directory: string; name?: string }[] }>("/workspaces"),
  );
  const [lastDir, setLastDir] = createSignal<string | null>(localStorage.getItem(LAST_DIR_KEY));
  const [addedDirs, setAddedDirs] = createSignal<string[]>(readDirs());
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

  const rememberDir = (dir: string | undefined) => {
    if (!dir) return;
    setLastDir(dir);
    localStorage.setItem(LAST_DIR_KEY, dir);
  };

  const addDir = (dir: string) => {
    const d = dir.trim();
    if (!d) return;
    if (!addedDirs().includes(d)) {
      const next = [...addedDirs(), d];
      setAddedDirs(next);
      localStorage.setItem(ADDED_DIRS_KEY, JSON.stringify(next));
    }
    rememberDir(d);
    setDirOpen(false);
    setDirDraft("");
  };

  /** The desktop shell's directory chooser. Browsers can't reach the native
      dialog, so the sidebar keeps the typed-path popover as its fallback. */
  const pickDir = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true });
    if (typeof dir === "string") addDir(dir);
  };

  return {
    wsList,
    refetchWs,
    lastDir,
    rememberDir,
    projectDirs,
    dirOpen,
    setDirOpen,
    dirDraft,
    setDirDraft,
    addDir,
    pickDir,
  };
}

export type WorkspaceCtl = ReturnType<typeof useWorkspace>;
