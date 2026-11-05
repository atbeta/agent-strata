import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("worktree creation feedback", () => {
  const app = readFileSync(join(import.meta.dir, "App.tsx"), "utf8");
  const sidebar = readFileSync(join(import.meta.dir, "sidebar.tsx"), "utf8");

  test("the two real stages are visible and a second click cannot double-create", () => {
    expect(app).toContain("if (worktreeJob()) return;");
    expect(app).toContain('setWorktreeJob({ dir: base, stage: "worktree" })');
    expect(app).toContain('setWorktreeJob({ dir: base, stage: "session" })');
    expect(app).toContain("finally {\n      setWorktreeJob(undefined);");
    expect(sidebar).toContain('"worktree.creating"');
    expect(sidebar).toContain('"worktree.creatingSession"');
    expect(sidebar).toContain("disabled={props.worktreeJob() !== undefined}");
  });

  test("linked checkouts start in a collapsed section with their own count", () => {
    expect(sidebar).toContain("createSignal(false)");
    expect(sidebar).toContain("partitionWorktreeGroups(");
    expect(sidebar).toContain("{worktreeGroups().length}");
    expect(sidebar).toContain("<For each={worktreeKeys()}>{renderGroup}</For>");
  });

  test("the fork button only appears where git claims the directory", () => {
    expect(sidebar).toContain("props.ws.repoOf(group().dir)");
  });
});
