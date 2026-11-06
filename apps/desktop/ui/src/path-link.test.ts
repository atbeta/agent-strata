import { describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmPaths, findPaths, resolveTarget } from "./path-link";

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

  test("a long unbroken token is scanned in linear time", () => {
    // A base64 blob in a code fence: one token, no separator. The bare
    // relative arm used to backtrack through it from every start position —
    // quadratic. 100k characters took seconds and froze the transcript while
    // a reply streamed in, because the tail re-scans on every frame.
    const blob = "A".repeat(100_000);
    const started = performance.now();
    expect(raws(blob)).toEqual([]);
    // A real path after the blob is still found.
    expect(raws(`${blob} and src/a.ts`)).toEqual(["src/a.ts"]);
    expect(performance.now() - started).toBeLessThan(2000);
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

  test("windows forms: backslash relatives, drive workspace, UNC", () => {
    const dws = "C:\\proj";
    // Backslash-separated tokens detect the same as their / cousins.
    expect(raws("edited src\\main.ts and src\\components\\ today")).toEqual([
      "src\\main.ts",
      "src\\components",
    ]);
    expect(raws("either and\\or works")).toEqual([]);
    expect(raws("share at \\\\srv\\pub\\dir")).toEqual(["\\\\srv\\pub\\dir"]);
    // Relatives anchor on a drive workspace too — this was silently broken.
    expect(resolveTarget("src\\main.ts", dws)).toEqual({
      rel: "src/main.ts",
      abs: "C:\\proj\\src\\main.ts",
    });
    expect(resolveTarget("src/main.ts", dws)).toEqual({
      rel: "src/main.ts",
      abs: "C:\\proj\\src\\main.ts",
    });
    expect(resolveTarget("..\\outside\\f.md", dws)).toEqual({ abs: "C:\\outside\\f.md" });
    expect(resolveTarget("\\\\srv\\pub", dws)).toEqual({ abs: "\\\\srv\\pub" });
    expect(resolveTarget("src\\a.ts", undefined)).toEqual({});
  });

  test("drive paths join a drive workspace and lose their backslashes", () => {
    expect(resolveTarget("C:\\proj\\src\\a.ts", "C:\\proj")).toEqual({ rel: "src/a.ts", abs: "C:\\proj\\src\\a.ts" });
    expect(resolveTarget("C:\\other\\a.ts", ws)).toEqual({ abs: "C:\\other\\a.ts" });
  });
});

/**
 * A path is a candidate until the service says it is a path.
 *
 * The model writes paths that were never on this machine, and it writes paths
 * outside the folders the reader may open. A link that cannot be opened is
 * worse than no link, so the verdict comes from the service — which owns HOME
 * and the list of allowed folders — and the token stays text until it does.
 */
describe("confirming a path before it becomes a link", () => {
  test("only the paths the service confirms are confirmed here", async () => {
    const asked: string[][] = [];
    const probe = async (paths: string[]) => {
      asked.push(paths);
      return paths.map((p) => ({ path: p, ok: p === "/real/a.ts" }));
    };
    const ok = await confirmPaths(["/real/a.ts", "/gone/b.ts"], probe);
    expect([...ok]).toEqual(["/real/a.ts"]);
    // One round-trip for the whole batch, not one per path.
    expect(asked).toEqual([["/real/a.ts", "/gone/b.ts"]]);
  });

  test("a path that exists is not asked about twice", async () => {
    let calls = 0;
    const probe = async (paths: string[]) => {
      calls += 1;
      return paths.map((p) => ({ path: p, ok: true }));
    };
    await confirmPaths(["/twice/a.ts"], probe);
    await confirmPaths(["/twice/a.ts"], probe);
    expect(calls).toBe(1);
  });

  test("a path that is not there is believed for a while, then asked again", async () => {
    let calls = 0;
    const probe = async (paths: string[]) => {
      calls += 1;
      return paths.map((p) => ({ path: p, ok: false }));
    };
    await confirmPaths(["/stale/c.ts"], probe);
    // Still believed: the file may have been created a moment ago.
    await confirmPaths(["/stale/c.ts"], probe);
    expect(calls).toBe(1);
    // Half a minute later the answer is stale and the service is asked again.
    setSystemTime(new Date(Date.now() + 60_000));
    try {
      await confirmPaths(["/stale/c.ts"], probe);
      expect(calls).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  test("a service that cannot be reached confirms nothing", async () => {
    const probe = async () => {
      throw new Error("Load failed");
    };
    const ok = await confirmPaths(["/maybe/a.ts"], probe);
    expect([...ok]).toEqual([]);
  });

  test("a path the service did not answer for is not confirmed", async () => {
    const probe = async () => [];
    const ok = await confirmPaths(["/silent/a.ts"], probe);
    expect([...ok]).toEqual([]);
  });
});

/**
 * The places that decide when a path is asked about.
 *
 * These are the ratchets that keep the work off the frames a reader can see:
 * a block still being written is not a finished sentence, and a reader who is
 * scrolling is not waiting for a round-trip.
 */
describe("when a path is asked about", () => {
  const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

  test("a block that is still being written is not asked about", () => {
    const src = read("md.tsx");
    // The live block is parsed again on every token; asking the service about
    // a path that may still change would be asking twice for one answer.
    expect(src).toContain("if (!finished) return [...frag.childNodes];");
    expect(src).toContain("markPathCandidates(frag)");
  });

  test("the service is asked in one batch, never one call per path", () => {
    const src = read("path-link.ts");
    expect(src).toContain("await probeBatch(unknown.slice(i, i + PROBE_BATCH), probe)");
  });

  test("the reader scrolling keeps the service from being asked", () => {
    const src = read("path-link.ts");
    expect(src).toContain("if (api.blocked?.()) {");
    const view = read("transcript-view.tsx");
    expect(view).toContain("blocked: () => gesturing()");
    // The gate opens when the gesture ends, and whatever waited runs.
    expect(view).toContain("for (const fn of waiting) fn();");
  });

  test("a candidate is text until the service says otherwise", () => {
    const src = read("path-link.ts");
    // The candidate is a span, not a button: nothing to click, nothing that
    // promises an action it cannot deliver.
    expect(src).toContain("span.className = \"path-candidate\"");
    expect(src).toContain("el.replaceWith(button)");
    // And the button only appears for a confirmed path.
    expect(src).toContain("if (confirmed.has(c.abs!)) upgradePathCandidate(c);");
  });

  test("a path earns its link when it comes into view", () => {
    const src = read("path-link.ts");
    // Only the paths on the reader's screen are turned into links; the rest
    // stay text until the reader scrolls to them.
    expect(src).toContain("if (!onScreen(c.el, scrollers)) continue;");
    expect(src).toContain("function onScreen(el: HTMLElement, scrollers: Map<Element, Bounds>): boolean {");
    // And only those are asked about: a long session holds thousands of
    // path-shaped tokens, and the service has no budget to answer for a page
    // the reader is not looking at.
    expect(src).toContain("const paths = [...new Set(shown.map((c) => c.abs!))];");
    // A row that scrolled away is released, so it does not keep its subtree.
    expect(src).toContain("p.candidates = p.candidates.filter((c) => c.el.parentNode !== null);");
  });

  test("the failure the reader sees is chosen by the code, in their language", () => {
    const src = read("errors.ts");
    expect(src).toContain('missing: "path.err.missing"');
    expect(src).toContain('outside: "path.err.outside"');
    const zh = readFileSync(join(import.meta.dir, "locales/zh/session.ts"), "utf8");
    const en = readFileSync(join(import.meta.dir, "locales/en/session.ts"), "utf8");
    for (const key of ["missing", "outside", "notAbsolute", "notAString", "notLocal"]) {
      expect(zh).toContain(`"path.err.${key}"`);
      expect(en).toContain(`"path.err.${key}"`);
    }
  });
});
