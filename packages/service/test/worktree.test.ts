import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  toplevel,
  worktreeAdd,
  worktreeInfo,
  worktreeList,
  worktreeRemove,
  withWorktrees,
} from "../src/worktree";

/**
 * Real git, real temp repos — the functions are thin wrappers over git's own
 * answers, so the meaningful test is whether those answers land where the
 * routes and the sidebar expect them.
 */

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "strata-wt-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" });

/** A committed file, so `worktree add` has a HEAD to start from. */
function makeRepo(): string {
  const repo = tempDir();
  git(repo, "init");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "f"), "x");
  git(repo, "add", "f");
  git(repo, "commit", "-m", "init");
  return repo;
}

describe("toplevel", () => {
  test("finds the repo root from a nested dir, nothing outside a repo", async () => {
    const repo = makeRepo();
    expect(await toplevel(repo)).toBeTruthy();
    expect(await toplevel(tempDir())).toBeUndefined();
  });
});

describe("worktreeAdd", () => {
  test("creates a checkout under the state dir on a strata branch", async () => {
    const repo = makeRepo();
    const state = tempDir();
    const wt = await worktreeAdd({ dir: repo, stateDir: state });
    // canonical() resolves /var → /private/var, so compare against the
    // resolved root the way the implementation does
    expect(wt.directory.startsWith(realpathSync(join(state, "worktrees")))).toBe(true);
    expect(wt.branch.startsWith("strata/")).toBe(true);
    expect(wt.repo).toBeTruthy();
    expect(existsSync(join(wt.directory, "f"))).toBe(true);
  });

  test("rejects a directory that is not a repo", async () => {
    await expect(worktreeAdd({ dir: tempDir(), stateDir: tempDir() })).rejects.toThrow(
      "not a git repository",
    );
  });

  test("two adds in a row do not collide on the same name", async () => {
    const repo = makeRepo();
    const state = tempDir();
    const a = await worktreeAdd({ dir: repo, name: "fixed", stateDir: state });
    const b = await worktreeAdd({ dir: repo, name: "fixed", stateDir: state });
    expect(a.directory).not.toBe(b.directory);
    expect(existsSync(a.directory)).toBe(true);
  });
});

describe("worktreeInfo / worktreeList", () => {
  test("the linked checkout reports its repo and branch; the main checkout does not", async () => {
    const repo = makeRepo();
    const wt = await worktreeAdd({ dir: repo, stateDir: tempDir() });
    const info = await worktreeInfo(wt.directory);
    expect(info?.branch).toBe(wt.branch);
    expect(info?.repo).toBe(wt.repo);
    expect(await worktreeInfo(repo)).toBeUndefined();
  });

  test("list sees the worktree git knows about", async () => {
    const repo = makeRepo();
    const wt = await worktreeAdd({ dir: repo, stateDir: tempDir() });
    const list = await worktreeList(repo);
    expect(list.length).toBe(2);
    const linked = list.find((e) => e.path === wt.directory);
    expect(linked?.branch).toBe(wt.branch);
    expect(linked?.main).toBe(false);
    expect(list.find((e) => e.main)?.path).toBe(wt.repo);
  });
});

describe("worktreeRemove", () => {
  test("removes a clean worktree and keeps its branch", async () => {
    const repo = makeRepo();
    const wt = await worktreeAdd({ dir: repo, stateDir: tempDir() });
    await worktreeRemove({ dir: wt.directory, stateDir: tempDir() });
    expect(existsSync(wt.directory)).toBe(false);
    const branches = git(repo, "branch", "--list", wt.branch).stdout;
    expect(branches).toContain(wt.branch);
  });

  test("refuses a dirty worktree until forced", async () => {
    const repo = makeRepo();
    const state = tempDir();
    const wt = await worktreeAdd({ dir: repo, stateDir: state });
    writeFileSync(join(wt.directory, "dirty"), "x");
    await expect(worktreeRemove({ dir: wt.directory, stateDir: state })).rejects.toThrow(
      "uncommitted changes",
    );
    await worktreeRemove({ dir: wt.directory, force: true, stateDir: state });
    expect(existsSync(wt.directory)).toBe(false);
  });

  test("the main checkout is not removable through this door", async () => {
    const repo = makeRepo();
    await expect(
      worktreeRemove({ dir: repo, stateDir: tempDir() }),
    ).rejects.toThrow("not a worktree");
  });
});

describe("withWorktrees", () => {
  test("marks session dirs that are worktrees and surfaces orphans under the root", async () => {
    const repo = makeRepo();
    const state = tempDir();
    const wt = await worktreeAdd({ dir: repo, stateDir: state });
    const orphan = await worktreeAdd({ dir: repo, stateDir: state });
    const marked = await withWorktrees(
      [
        { directory: repo },
        { directory: wt.directory },
        { directory: tempDir() },
      ],
      state,
    );
    const byDir = new Map(marked.map((w) => [w.directory, w]));
    expect(byDir.get(repo)?.worktree).toBeUndefined();
    expect(byDir.get(wt.directory)?.worktree?.branch).toBe(wt.branch);
    // the worktree no session points at still gets a row — its remove button
    // lives on that empty group
    expect(byDir.get(orphan.directory)?.worktree?.branch).toBe(orphan.branch);
  });

  test("marks which dirs a repository claims — the worktree button's gate", async () => {
    const repo = makeRepo();
    const state = tempDir();
    const wt = await worktreeAdd({ dir: repo, stateDir: state });
    const plain = tempDir();
    const marked = await withWorktrees(
      [{ directory: repo }, { directory: wt.directory }, { directory: plain }],
      state,
    );
    const byDir = new Map(marked.map((w) => [w.directory, w]));
    expect(byDir.get(repo)?.repo).toBe(realpathSync(repo));
    // a linked worktree names its repo's main checkout, not its own root —
    // the listing that ran inside it must not point the mark at itself
    expect(byDir.get(wt.directory)?.repo).toBe(realpathSync(repo));
    expect(byDir.get(plain)?.repo).toBeUndefined();
  });

  /**
   * Every `git` this module runs must stay off the desktop.
   *
   * On Windows a console program started from a GUI process gets its own
   * console window. One workspace listing runs a `rev-parse` per directory and
   * a `worktree list` per repository, so without `windowsHide` a reader with a
   * few hundred stored sessions got dozens of black windows opening and closing
   * — and the page retries that request, so the wave repeated.
   *
   * No test on this platform can observe the window; the assertion is on the
   * source, which is the only thing that can be checked from here. It is
   * deliberately narrow: one `spawn` call, and it must carry the flag.
   */
  test("no git runs without hiding its console window", () => {
    const src = readFileSync(new URL("../src/worktree.ts", import.meta.url), "utf8");
    const spawns = src.match(/spawn\(\[/g) ?? [];
    expect(spawns.length).toBe(1);
    // The options object that follows the single call has to name the flag.
    const at = src.indexOf('spawn(["git"');
    expect(at).toBeGreaterThan(-1);
    const options = src.slice(at, src.indexOf("});", at));
    expect(options).toContain("windowsHide: true");
  });
});
