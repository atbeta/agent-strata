import { describe, expect, test } from "bun:test";
import { findPaths, resolveTarget } from "./path-link";

const raws = (text: string) => findPaths(text).map((m) => m.raw);

describe("finding local paths in prose", () => {
  test("absolute, home, dot-relative and extension-carrying relatives link", () => {
    expect(raws("see /Users/b/src/a.ts and ~/proj/b.md plus ./c/d.tsx and ../e/f.rs"))
      .toEqual(["/Users/b/src/a.ts", "~/proj/b.md", "./c/d.tsx", "../e/f.rs"]);
    expect(raws("edited src/foo.ts then packages/service/src/index.ts"))
      .toEqual(["src/foo.ts", "packages/service/src/index.ts"]);
  });

  test("trailing sentence punctuation stays outside the link", () => {
    expect(raws("open /tmp/a.ts, then /tmp/b.md.")).toEqual(["/tmp/a.ts", "/tmp/b.md"]);
    expect(raws("in src/a.ts: the bug")).toEqual(["src/a.ts"]);
  });

  test("a trailing slash marks a directory", () => {
    const [m] = findPaths("under src/components/ sits the form");
    expect(m?.raw).toBe("src/components");
    expect(m?.dir).toBe(true);
  });

  test("urls, bare words, and non-file slugs stay text", () => {
    for (const text of [
      "https://example.com/a/b.ts",
      "see http://x.io/f.md for docs",
      "file:///etc/hosts",
      "either and/or works",
      "the strata/ember-otter branch",
      "mailto:a/b.c",
    ]) {
      expect(raws(text)).toEqual([]);
    }
  });

  test("api routes stay text — they are shaped like extension-less absolute paths", () => {
    for (const text of [
      "`/` 200、`/zh` 200、`/docs/getting-started` 200",
      "POST /api/users/42 then GET /v1/status",
      "proxy /admin/settings to the app",
    ]) {
      expect(raws(text)).toEqual([]);
    }
    // …while real roots and extension-carrying paths still link.
    expect(raws("/Users/b/proj and /etc/hosts and /api/v2.json"))
      .toEqual(["/Users/b/proj", "/etc/hosts", "/api/v2.json"]);
  });

  test("code and emphasis still count", () => {
    expect(raws("error at `/var/log/x.log`")).toEqual(["/var/log/x.log"]);
    expect(raws("**src/main.rs** broke")).toEqual(["src/main.rs"]);
  });
});

describe("resolving a path against the session workspace", () => {
  const ws = "/Users/b/proj";

  test("absolute paths inside the workspace become relative", () => {
    expect(resolveTarget("/Users/b/proj/src/a.ts", ws)).toEqual({ rel: "src/a.ts", abs: "/Users/b/proj/src/a.ts" });
    expect(resolveTarget(ws, ws)).toEqual({ rel: "", abs: ws });
  });

  test("absolute paths outside stay absolute", () => {
    expect(resolveTarget("/etc/hosts", ws)).toEqual({ abs: "/etc/hosts" });
  });

  test("home paths wait for the service to expand them", () => {
    expect(resolveTarget("~/proj/a.ts", ws)).toEqual({ abs: "~/proj/a.ts" });
  });

  test("relatives anchor on the workspace; .. that escapes stays absolute", () => {
    expect(resolveTarget("src/a.ts", ws)).toEqual({ rel: "src/a.ts", abs: "/Users/b/proj/src/a.ts" });
    expect(resolveTarget("./x/y.ts", ws)).toEqual({ rel: "x/y.ts", abs: "/Users/b/proj/x/y.ts" });
    expect(resolveTarget("../outside/f.md", ws)).toEqual({ abs: "/Users/b/outside/f.md" });
  });

  test("without a workspace only absolute forms resolve", () => {
    expect(resolveTarget("src/a.ts", undefined)).toEqual({});
    expect(resolveTarget("/tmp/a.ts", undefined)).toEqual({ abs: "/tmp/a.ts" });
  });

  test("drive paths join a drive workspace and lose their backslashes", () => {
    expect(resolveTarget("C:\\proj\\src\\a.ts", "C:\\proj")).toEqual({ rel: "src/a.ts", abs: "C:/proj/src/a.ts" });
    expect(resolveTarget("C:\\other\\a.ts", ws)).toEqual({ abs: "C:\\other\\a.ts" });
  });
});
