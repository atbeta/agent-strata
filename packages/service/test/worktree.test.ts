import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  test("a locked worktree asks for the second click, then goes", async () => {
    const repo = makeRepo();
    const state = tempDir();
    const wt = await worktreeAdd({ dir: repo, stateDir: state });
    git(repo, "worktree", "lock", wt.directory);
    // One --force refuses a locked checkout outright, so the reader could
    // never remove one; the error asks for the click that forces it.
    await expect(worktreeRemove({ dir: wt.directory, stateDir: state })).rejects.toThrow(
      "worktree locked",
    );
    await worktreeRemove({ dir: wt.directory, force: true, stateDir: state });
    expect(existsSync(wt.directory)).toBe(false);
  });

  test("a folder something still holds says so, not git's own sentence", async () => {
    // A directory nobody can write into cannot be emptied — the same shape as
    // a file a dev server or an editor still has open on Windows.
    if (process.platform === "win32") return;
    const repo = makeRepo();
    const state = tempDir();
    const wt = await worktreeAdd({ dir: repo, stateDir: state });
    writeFileSync(join(wt.directory, "locked"), "x");
    chmodSync(wt.directory, 0o500);
    try {
      await expect(
        worktreeRemove({ dir: wt.directory, force: true, stateDir: state }),
      ).rejects.toThrow("worktree in use");
      expect(existsSync(wt.directory)).toBe(true);
      // The checkout is not stranded by the failure: git still knows it, so
      // it stays in the sidebar and the reader can try again once whatever
      // held the folder lets go.
      expect(git(repo, "worktree", "list", "--porcelain").stdout).toContain(wt.directory);
    } finally {
      chmodSync(wt.directory, 0o700);
    }
  });

  test("the folder is released only when it is the thing that will not empty", async () => {
    const repo = makeRepo();
    const state = tempDir();
    const wt = await worktreeAdd({ dir: repo, stateDir: state });
    let released = 0;
    const release = async () => {
      released += 1;
    };
    // A dirty checkout only asks for a second click — nothing should die for it.
    writeFileSync(join(wt.directory, "dirty"), "x");
    await expect(
      worktreeRemove({ dir: wt.directory, stateDir: state, release }),
    ).rejects.toThrow("uncommitted changes");
    expect(released).toBe(0);
    // When the folder itself will not empty, it is asked for.
    rmSync(join(wt.directory, "dirty"));
    if (process.platform !== "win32") {
      chmodSync(wt.directory, 0o500);
      try {
        await expect(
          worktreeRemove({ dir: wt.directory, force: true, stateDir: state, release }),
        ).rejects.toThrow("worktree in use");
        expect(released).toBe(1);
      } finally {
        chmodSync(wt.directory, 0o700);
      }
    }
  });

  test("a checkout whose folder was emptied is still removable", async () => {
    // What a removal that emptied the folder and could not remove it leaves
    // behind: the checkout is gone from the disk, git still lists it by path,
    // and the empty folder cannot say which repository it belongs to.
    const repo = makeRepo();
    const state = tempDir();
    const wt = await worktreeAdd({ dir: repo, stateDir: state });
    for (const name of readdirSync(wt.directory)) {
      rmSync(join(wt.directory, name), { recursive: true, force: true });
    }
    // An emptied folder answers nothing…
    expect(await worktreeInfo(wt.directory)).toBeUndefined();
    // …but git still lists the checkout by path. Git spells a Windows path
    // with forward slashes and a path built here is spelled with backslashes,
    // so the two are compared in one spelling.
    const listed = git(repo, "worktree", "list", "--porcelain").stdout.replace(/\\/g, "/");
    expect(listed).toContain(wt.directory.replace(/\\/g, "/"));

    // Asked of the repositories the app knows about, the checkout is found
    // again and goes away.
    await worktreeRemove({ dir: wt.directory, force: true, stateDir: state, repos: async () => [repo] });
    expect(existsSync(wt.directory)).toBe(false);
    // The branch is not what was asked for.
    expect(git(repo, "branch", "--list", wt.branch).stdout).toContain(wt.branch);
  });

  test("a checkout whose folder was emptied is found through a sibling", async () => {
    // The app keeps one folder of checkouts per repository, and every checkout
    // in it points back at the same repository. A sibling that still has its
    // `.git` file therefore says which repository the folder belongs to — the
    // answer for a checkout whose own file went when the folder was emptied,
    // and the one the app would have if no session is in that repository any
    // more.
    const repo = makeRepo();
    const state = tempDir();
    const first = await worktreeAdd({ dir: repo, stateDir: state });
    const second = await worktreeAdd({ dir: repo, stateDir: state });
    for (const name of readdirSync(second.directory)) {
      rmSync(join(second.directory, name), { recursive: true, force: true });
    }
    // No repository is offered, and none is needed.
    await worktreeRemove({ dir: second.directory, force: true, stateDir: state });
    expect(existsSync(second.directory)).toBe(false);
    // The sibling is a checkout of its own, and it is not touched.
    expect(existsSync(first.directory)).toBe(true);
  });

  test("a checkout git gave up on is still ours to remove", async () => {
    // What an older removal left behind: git dropped the registration, so
    // nothing in git names the checkout — only the folder is left.
    const repo = makeRepo();
    const state = tempDir();
    const wt = await worktreeAdd({ dir: repo, stateDir: state });
    const admin = join(repo, ".git", "worktrees");
    for (const name of readdirSync(admin)) {
      rmSync(join(admin, name), { recursive: true, force: true });
    }
    expect(git(repo, "worktree", "list", "--porcelain").stdout).not.toContain(wt.directory);
    // It is still listed, so the remove action can reach it…
    const listed = await withWorktrees([], state);
    const orphan = listed.find((w) => w.directory === wt.directory);
    expect(orphan?.worktree).toBeTruthy();
    // …and removing it works, even though git has forgotten it.
    await worktreeRemove({ dir: wt.directory, force: true, stateDir: state });
    expect(existsSync(wt.directory)).toBe(false);
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
