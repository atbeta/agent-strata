// One session's edits belong to one checkout. A worktree is a second checkout
// of the same repository: the session writes there, the main tree stays
// untouched, and the branch is what merges back. The service runs git itself
// — a worktree is just a directory to everything downstream, and the session
// path is already directory-scoped end to end.

import { spawn } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** A git failure worded for a person, carrying the status the route answers. */
export class WorktreeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const proc = spawn(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new WorktreeError(err.trim() || `git ${args[0]} failed`);
  return out.trim();
}

/** symlinks resolved, so a worktree path compares equal no matter how it was spelled */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The repository's main checkout, or nothing when dir is inside no repo. */
export async function toplevel(dir: string): Promise<string | undefined> {
  try {
    const top = await git(["-C", dir, "rev-parse", "--show-toplevel"]);
    return top ? canonical(top) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A linked worktree's repo and branch; nothing for the main checkout or a
 * non-repo. The answer comes from git itself — a linked checkout's git dir
 * lives under `<repo>/.git/worktrees/` — so nothing is recorded that can lie.
 */
export async function worktreeInfo(
  dir: string,
): Promise<{ repo: string; branch?: string } | undefined> {
  try {
    const gitDir = resolve(dir, await git(["-C", dir, "rev-parse", "--git-dir"]));
    if (!gitDir.split(sep).join("/").includes("/.git/worktrees/")) return undefined;
    const common = resolve(dir, await git(["-C", dir, "rev-parse", "--git-common-dir"]));
    const repo = canonical(dirname(common));
    const branch = (await git(["-C", dir, "branch", "--show-current"])) || undefined;
    return { repo, branch };
  } catch {
    return undefined;
  }
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  /** --porcelain lists the repository's own checkout first */
  main: boolean;
}

/** Every checkout the repository knows — the main one plus its worktrees. */
export async function worktreeList(dir: string): Promise<WorktreeEntry[]> {
  const raw = await git(["-C", dir, "worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    const ref = lines.find((l) => l.startsWith("branch "))?.slice(7);
    entries.push({
      path: canonical(path),
      head: lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? "",
      ...(ref ? { branch: ref.replace(/^refs\/heads\//, "") } : {}),
      detached: lines.includes("detached"),
      bare: lines.includes("bare"),
      main: entries.length === 0,
    });
  }
  return entries;
}

const ADJECTIVES = [
  "amber", "brisk", "calm", "cedar", "crisp", "dawn", "ember", "faint",
  "golden", "harbor", "ivory", "jade", "keen", "lunar", "mellow", "north",
  "onyx", "pale", "quiet", "rustic", "stone", "tidal", "umber", "velvet",
];
const NOUNS = [
  "anchor", "brook", "cliff", "cove", "crane", "elm", "fern", "field",
  "fox", "gale", "grove", "hawk", "isle", "lake", "lark", "mesa",
  "mill", "oak", "otter", "peak", "reef", "shore", "vale", "wren",
];

/** A name a person can say — `ember-otter`, not `wt-4f8a2`. */
function slug(): string {
  const b = randomBytes(2);
  return `${ADJECTIVES[b[0]! % ADJECTIVES.length]}-${NOUNS[b[1]! % NOUNS.length]}`;
}

export interface WorktreeAdded {
  directory: string;
  branch: string;
  repo: string;
}

/**
 * A new checkout beside the repo's own, on a new `strata/<name>` branch off
 * the repo's HEAD. Worktrees live under the service's state dir — inside the
 * repo they would be files the agent's own tools can see. A taken name steps
 * to `-2`, `-3`, the way the upstream flow does.
 */
export async function worktreeAdd(opts: {
  dir: string;
  name?: string;
  branch?: string;
  stateDir: string;
}): Promise<WorktreeAdded> {
  const repo = await toplevel(opts.dir);
  if (!repo) throw new WorktreeError("not a git repository");
  const key = `${basename(repo).replace(/[^\w.-]+/g, "_")}-${createHash("sha1")
    .update(repo)
    .digest("hex")
    .slice(0, 6)}`;
  const parent = join(opts.stateDir, "worktrees", key);
  mkdirSync(parent, { recursive: true });
  const base = opts.name?.trim() || slug();
  for (let i = 1; i <= 10; i += 1) {
    const name = i === 1 ? base : `${base}-${i}`;
    const dest = join(parent, name);
    if (existsSync(dest)) continue;
    const branch = opts.branch?.trim() || `strata/${name}`;
    try {
      await git(["-C", repo, "worktree", "add", dest, "-b", branch]);
      return { directory: canonical(dest), branch, repo };
    } catch (e) {
      // An auto branch can collide with one an earlier worktree left behind;
      // the next name gets a fresh one. A branch the caller named is final.
      if (opts.branch || i === 10) throw e;
    }
  }
  throw new WorktreeError("no free worktree name", 500);
}

/**
 * Drop a linked worktree's checkout. Uncommitted changes refuse without
 * `force`, and the branch stays either way: `git worktree remove` deletes the
 * directory, not the ref — removing `strata/<name>` would lose commits the
 * session made, and that is not ours to take.
 */
export async function worktreeRemove(opts: {
  dir: string;
  force?: boolean;
  stateDir: string;
}): Promise<void> {
  const dir = canonical(opts.dir);
  if (!existsSync(dir)) throw new WorktreeError("worktree not found", 404);
  const info = await worktreeInfo(dir);
  if (!info) throw new WorktreeError("not a worktree");
  if (!opts.force && (await git(["-C", dir, "status", "--porcelain"]))) {
    throw new WorktreeError("worktree has uncommitted changes", 409);
  }
  await git([
    "-C",
    info.repo,
    "worktree",
    "remove",
    dir,
    ...(opts.force ? ["--force"] : []),
  ]);
  // Empty parents under our own worktrees root go with it; anywhere else is
  // not ours to clean.
  const root = canonical(join(opts.stateDir, "worktrees")) + sep;
  if (dir.startsWith(root)) {
    for (const parent of [dirname(dir), dirname(dirname(dir))]) {
      try {
        rmdirSync(parent);
      } catch {
        // not empty — leave it
      }
    }
  }
}

export interface WorkspaceDir {
  directory: string;
  name?: string;
  /** set when the directory is a linked git worktree — repo is the main checkout */
  worktree?: { repo: string; branch?: string };
}

/**
 * Mark which of these dirs are linked worktrees, and add the ones under the
 * service's root that no session points at: an empty group is where their
 * remove action lives, and it is the only way a leftover shows up at all.
 */
export async function withWorktrees(dirs: WorkspaceDir[], stateDir: string): Promise<WorkspaceDir[]> {
  const repos = new Set<string>();
  await Promise.all(
    dirs.map(async (w) => {
      const top = await toplevel(w.directory);
      if (top) repos.add(top);
    }),
  );
  const marks = new Map<string, { repo: string; branch?: string }>();
  const ours = new Set<string>();
  const ourRoot = canonical(join(stateDir, "worktrees")) + sep;
  await Promise.all(
    [...repos].map(async (repo) => {
      let entries: WorktreeEntry[];
      try {
        entries = await worktreeList(repo);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.main) continue;
        marks.set(e.path, { repo, ...(e.branch ? { branch: e.branch } : {}) });
        if (e.path.startsWith(ourRoot)) ours.add(e.path);
      }
    }),
  );
  const byPath = new Map(dirs.map((w) => [canonical(w.directory), w] as const));
  for (const path of ours) {
    if (!byPath.has(path)) byPath.set(path, { directory: path });
  }
  return [...byPath.values()].map((w) => {
    const wt = marks.get(canonical(w.directory));
    return wt ? { ...w, worktree: wt } : w;
  });
}
