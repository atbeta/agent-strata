// One session's edits belong to one checkout. A worktree is a second checkout
// of the same repository: the session writes there, the main tree stays
// untouched, and the branch is what merges back. The service runs git itself
// — a worktree is just a directory to everything downstream, and the session
// path is already directory-scoped end to end.

import { spawn } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import type { Dirent } from "node:fs";
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
    // Without this a console program started from a GUI process gets its own
    // console window on Windows — one black box per `git` invocation, opening
    // and closing. `dev-process.ts` spells the same thing out; this module was
    // added later and did not.
    //
    // The count is what made it unusable: a single workspace listing runs one
    // `rev-parse` per directory and one `worktree list` per repository, so a
    // reader with a few hundred sessions in the store got dozens of windows
    // per request, and the page retries that request while the service is
    // still starting.
    windowsHide: true,
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
  // A directory that is gone cannot be in a repository, and saying so here
  // saves spawning a process to be told. Most of what reaches this function
  // comes from the workspaces of stored sessions, and those outlive the
  // checkouts they name — a deleted branch, a cleaned /tmp, a colleague's
  // path from a shared store.
  if (!existsSync(dir)) return undefined;
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
  /**
   * The path as git itself spells it.
   *
   * git matches a worktree by comparing that string, not by resolving it, so
   * the real path of a checkout under a symlink (`/var` → `/private/var` on
   * macOS) is a path git has never heard of. Commands that name a worktree
   * have to use this one; the resolved one is for comparing.
   */
  gitPath: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  /** git was told to keep this one — it refuses to remove it until unlocked */
  locked: boolean;
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
      gitPath: path,
      head: lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? "",
      ...(ref ? { branch: ref.replace(/^refs\/heads\//, "") } : {}),
      detached: lines.includes("detached"),
      bare: lines.includes("bare"),
      locked: lines.some((l) => l === "locked" || l.startsWith("locked ")),
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
 * `force`, and the branch stays either way: removing the checkout deletes the
 * directory, not the ref — removing `strata/<name>` would lose commits the
 * session made, and that is not ours to take.
 */
export async function worktreeRemove(opts: {
  dir: string;
  force?: boolean;
  stateDir: string;
  /**
   * Called when the folder will not empty — the app's own programs inside it
   * may be what is holding it. It is not called before that: a dirty
   * checkout only asks for a second click, and nothing should die for it.
   */
  release?: () => Promise<void>;
}): Promise<void> {
  const dir = canonical(opts.dir);
  if (!existsSync(dir)) throw new WorktreeError("worktree not found", 404);
  const info = await worktreeInfo(dir);
  if (!info) {
    // git has already given this checkout up: it drops the registration
    // before it deletes the folder, so a removal that failed leaves a
    // directory with nothing left naming it. Under our own root that is ours
    // to finish, and it is the only way it goes away.
    if (!underOwnRoot(dir, opts.stateDir)) throw new WorktreeError("not a worktree");
    await removeDirectory(dir, opts.release);
    return;
  }
  if (!opts.force && (await git(["-C", dir, "status", "--porcelain"]))) {
    throw new WorktreeError("worktree has uncommitted changes", 409);
  }
  // git compares the path it recorded, so it has to be given that spelling —
  // the resolved one is a path it has never heard of.
  const listed = (await worktreeList(info.repo)).find((e) => e.path === dir);
  await removeCheckout(
    { gitPath: listed?.gitPath ?? dir, locked: listed?.locked === true },
    info.repo,
    opts.force === true,
    opts.release,
  );
  // Empty parents under our own worktrees root go with it; anywhere else is
  // not ours to clean.
  if (underOwnRoot(dir, opts.stateDir)) {
    for (const parent of [dirname(dir), dirname(dirname(dir))]) {
      try {
        rmdirSync(parent);
      } catch {
        // not empty — leave it
      }
    }
  }
}

/** Is this directory one the service created, under its own worktrees root? */
function underOwnRoot(dir: string, stateDir: string): boolean {
  return dir.startsWith(canonical(join(stateDir, "worktrees")) + sep);
}

/** How many times to try a directory something is still holding, and how long
 *  to wait between tries. A handle is often released in a moment — a scanner
 *  finished, an editor closed the file — and the next try succeeds. */
const REMOVE_ATTEMPTS = 4;
const REMOVE_RETRY_MS = 250;

/**
 * Take the checkout off the disk.
 *
 * The folder goes first, git's bookkeeping second, and the order is the whole
 * point.
 *
 * git drops a worktree's registration *before* it tries to delete the folder,
 * so a removal that fails leaves the folder behind with nothing left naming
 * it: the checkout is stranded — invisible in the sidebar, and no git command
 * will take it. Deleting the folder ourselves keeps that from happening.
 * While the folder is still there, git still knows the checkout, so a reader
 * who closes whatever is holding it can simply try again, and the worktree
 * stays visible until they do.
 */
async function removeCheckout(
  target: { gitPath: string; locked: boolean },
  repo: string,
  force: boolean,
  release?: () => Promise<void>,
): Promise<void> {
  if (target.locked) {
    // A locked checkout is refused until the lock is lifted, and one
    // `--force` is not enough — git wants "-f -f". The reader's second click
    // is what says "remove it anyway", so the lock goes by name.
    if (!force) throw new WorktreeError("worktree locked", 409);
    await git(["-C", repo, "worktree", "unlock", target.gitPath]).catch(() => {});
  }
  await removeDirectory(target.gitPath, release);
  try {
    // git cleans up after a checkout whose folder is gone, and keeps the
    // branch — the commits the session made stay on it.
    await git(["-C", repo, "worktree", "remove", ...(force ? ["--force"] : []), target.gitPath]);
  } catch {
    // The folder is gone either way; git's bookkeeping for it is not worth
    // failing over. A prune clears what is left.
    await git(["-C", repo, "worktree", "prune"]).catch(() => {});
  }
}

/**
 * Empty a directory the filesystem is still holding.
 *
 * `release` is asked once, after the first refusal: the app's own programs
 * inside the folder may be what is holding it, and they are the only holder
 * the app can let go of.
 *
 * When it still cannot be emptied, the reader is told what is holding it
 * instead of git's own sentence — and git still knows the checkout, because
 * nothing has been unregistered yet.
 */
async function removeDirectory(dir: string, release?: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, REMOVE_RETRY_MS * attempt));
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // still held
    }
    if (attempt === 0 && release) await release();
  }
  throw new WorktreeError("worktree in use", 423);
}

export interface WorkspaceDir {
  directory: string;
  name?: string;
  /** set when the directory is a linked git worktree — repo is the main checkout */
  worktree?: { repo: string; branch?: string };
  /** the repository's main checkout, set whenever the directory sits inside a repo at all */
  repo?: string;
}

/**
 * Mark which of these dirs are linked worktrees, and add the ones under the
 * service's root that no session points at: an empty group is where their
 * remove action lives, and it is the only way a leftover shows up at all.
 */
/**
 * How many `git` processes may be in flight at once.
 *
 * Every directory in the answer costs a process, and the answer is built from
 * the workspaces of every stored session — hundreds on a real machine, most of
 * them long since deleted. Unbounded, one workspace listing started that many
 * processes at the same instant; on Windows each one is a console window, so
 * the popups arrived in a wave. Four is enough to keep a warm disk busy and
 * few enough that the wave is not a stampede.
 */
const GIT_CONCURRENCY = 4;

/** Run `fn` over `items` with at most {@link GIT_CONCURRENCY} at a time. */
async function mapLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  // In chunks rather than a worker pool: the order comes out the same as the
  // input without an index to write into, and `new Array(n)` — the pool's
  // shape — is a lint error here because one numeric argument means length
  // rather than an element, which is the kind of thing that reads fine and
  // behaves wrong.
  const out: R[] = [];
  for (let i = 0; i < items.length; i += GIT_CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + GIT_CONCURRENCY).map(fn))));
  }
  return out;
}

/**
 * Answers `toplevel` already paid for, so a repeated listing is cheap.
 *
 * The page asks for the workspace list while it starts, and asks again on every
 * retry; without this each attempt redid the whole sweep. Short-lived on
 * purpose: a directory can become a repository between two listings, and a
 * minute is long enough to cover a launch and short enough that nobody has to
 * restart the app to see a new checkout.
 */
const TOPLEVEL_TTL_MS = 60_000;
const topCache = new Map<string, { at: number; top: string | undefined }>();

async function toplevelCached(dir: string): Promise<string | undefined> {
  const hit = topCache.get(dir);
  const now = Date.now();
  if (hit && now - hit.at < TOPLEVEL_TTL_MS) return hit.top;
  const top = await toplevel(dir);
  topCache.set(dir, { at: now, top });
  // Bound the map: a machine that opens a new directory every hour would grow
  // it forever otherwise.
  if (topCache.size > 2_000) {
    for (const [key, entry] of topCache) {
      if (now - entry.at >= TOPLEVEL_TTL_MS) topCache.delete(key);
    }
  }
  return top;
}

export async function withWorktrees(dirs: WorkspaceDir[], stateDir: string): Promise<WorkspaceDir[]> {
  const tops = new Map<string, string>();
  const repos = new Set<string>();
  await mapLimit(dirs, async (w) => {
    const top = await toplevelCached(w.directory);
    if (top) {
      tops.set(w.directory, top);
      repos.add(top);
    }
  });
  const marks = new Map<string, { repo: string; branch?: string }>();
  const ours = new Set<string>();
  const ourRoot = canonical(join(stateDir, "worktrees")) + sep;
  await mapLimit([...repos], async (repo) => {
    let entries: WorktreeEntry[];
    try {
      entries = await worktreeList(repo);
    } catch {
      return;
    }
    // The listing may have run inside a linked worktree — its `repo` is the
    // first entry, the repository's own checkout, not the dir that was asked.
    const main = entries.find((e) => e.main)?.path ?? repo;
    for (const e of entries) {
      if (e.main) continue;
      marks.set(e.path, { repo: main, ...(e.branch ? { branch: e.branch } : {}) });
      if (e.path.startsWith(ourRoot)) ours.add(e.path);
    }
  });
  const byPath = new Map(dirs.map((w) => [canonical(w.directory), w] as const));
  for (const path of ours) {
    if (!byPath.has(path)) byPath.set(path, { directory: path });
  }
  // The checkouts under our own root that git has given up on. git drops a
  // worktree's registration before it deletes the folder, so a removal that
  // failed leaves a directory with nothing left naming it — still the app's,
  // still on disk, and the only way it goes is through the remove action.
  const known = new Set(marks.keys());
  for (const path of ownCheckouts(stateDir)) {
    if (known.has(path)) continue;
    const existing = byPath.get(path);
    if (existing?.worktree) continue;
    const repo = repoOfCheckout(path);
    if (!repo) continue;
    byPath.set(path, { ...(existing ?? { directory: path }), worktree: { repo } });
  }
  return [...byPath.values()].map((w) => {
    const wt = marks.get(canonical(w.directory));
    const repo = wt?.repo ?? tops.get(w.directory);
    return {
      ...w,
      ...(wt ? { worktree: wt } : {}),
      ...(repo ? { repo } : {}),
    };
  });
}

/**
 * The checkouts under the service's own root, whatever git still knows
 * about them.
 *
 * One level of repository key, one of checkout: the shape `worktreeAdd`
 * creates them in.
 */
function ownCheckouts(stateDir: string): string[] {
  const root = join(stateDir, "worktrees");
  const out: string[] = [];
  let repos: Dirent[];
  try {
    repos = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const repo of repos) {
    if (!repo.isDirectory()) continue;
    const parent = join(root, repo.name);
    let names: Dirent[];
    try {
      names = readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.isDirectory()) continue;
      out.push(canonical(join(parent, name.name)));
    }
  }
  return out;
}

/**
 * The repository a checkout was made from, read from the `.git` file it
 * kept. The repository no longer lists the checkout, but the file still
 * names where it came from — which is what the reader needs to know.
 */
function repoOfCheckout(dir: string): string | undefined {
  try {
    const text = readFileSync(join(dir, ".git"), "utf8");
    const match = text.match(/^gitdir:\s*(.+)$/m);
    if (!match) return undefined;
    // <repo>/.git/worktrees/<name>
    return canonical(dirname(dirname(dirname(match[1]!.trim()))));
  } catch {
    return undefined;
  }
}
