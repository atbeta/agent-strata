import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { checkPath, checkPaths, expandHome } from "../src/paths";
import { startService } from "../src/index";

/**
 * The rules a path has to pass before the app will open it.
 *
 * They are checked in bulk, because that is how the reader's window asks:
 * "which of the paths in this paragraph are real?" — a paragraph of model
 * prose is full of paths that were never on this machine.
 */
describe("checking a local path", () => {
  test("a file inside an allowed folder is accepted", () => {
    const root = mkdtempSync(join(tmpdir(), "strata-paths-"));
    const file = join(root, "a.txt");
    writeFileSync(file, "a");
    const check = checkPath(file, [root]);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.path).toBe(file);
      expect(check.dir).toBe(false);
    }
    const dir = checkPath(root, [root]);
    expect(dir.ok && dir.dir).toBe(true);
  });

  test("the failure carries a code the other side can translate", () => {
    const root = mkdtempSync(join(tmpdir(), "strata-paths-"));
    const other = mkdtempSync(join(tmpdir(), "strata-paths-out-"));
    const file = join(other, "a.txt");
    writeFileSync(file, "a");
    expect(checkPath(file, [root])).toMatchObject({ ok: false, code: "outside" });
    expect(checkPath(join(root, "nope.txt"), [root])).toMatchObject({ ok: false, code: "missing" });
    expect(checkPath("a/b.txt", [root])).toMatchObject({ ok: false, code: "not-absolute" });
    expect(checkPath(42, [root])).toMatchObject({ ok: false, code: "not-a-string" });
  });

  test("a batch answers every path it was given", () => {
    const root = mkdtempSync(join(tmpdir(), "strata-paths-"));
    const file = join(root, "a.txt");
    writeFileSync(file, "a");
    const checks = checkPaths([file, join(root, "nope.txt"), "relative", 7], [root]);
    expect(checks.map((c) => (c.ok ? "ok" : c.code))).toEqual([
      "ok",
      "missing",
      "not-absolute",
      "not-a-string",
    ]);
  });

  test("~ expands against the service's home, with either separator", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/notes")).toBe(`${homedir()}/notes`);
    expect(expandHome("~\\notes")).toBe(`${homedir()}\\notes`);
    expect(expandHome("/tmp/a")).toBe("/tmp/a");
  });

  test("a home-relative path is found through the home folder", () => {
    // The service owns HOME, so `~` resolves here and nowhere else.
    expect(checkPath("~", [homedir()]).ok).toBe(true);
    expect(checkPath("~/definitely-not-here", [homedir()])).toMatchObject({
      ok: false,
      code: "missing",
    });
  });
});

/**
 * The route the reader's window asks.
 *
 * One call carries every path in a paragraph of prose, and the answer is a
 * verdict per path: which of them the app may open, and why not for the
 * others.
 */
describe("the path probe route", () => {
  test("answers every path it was given", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    try {
      const base = `http://127.0.0.1:${svc.port}`;
      const root = mkdtempSync(join(tmpdir(), "strata-probe-"));
      const file = join(root, "a.txt");
      writeFileSync(file, "a");
      // A session's workspace is one of the folders a path may land in.
      svc.store.append([
        makeEvent({
          session_id: "opencode:s1",
          type: "session.started",
          ts: "2026-01-01T00:00:00Z",
          source: { backend: "opencode" },
          data: { title: "seed", workspace: root },
        } as EventInput),
      ]);
      const res = await fetch(`${base}/desktop/paths`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          paths: [file, join(root, "nope.txt"), "relative", 7],
        }),
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { paths: { path: string; ok: boolean; code?: string }[] };
      expect(body.paths.map((p) => (p.ok ? "ok" : p.code))).toEqual([
        "ok",
        "missing",
        "not-absolute",
        "not-a-string",
      ]);
    } finally {
      svc.stop();
    }
  });

  test("a body that is not a list of paths answers with an empty list", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    try {
      const base = `http://127.0.0.1:${svc.port}`;
      const res = await fetch(`${base}/desktop/paths`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: "not a list" }),
      });
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ paths: [] });
    } finally {
      svc.stop();
    }
  });
});
