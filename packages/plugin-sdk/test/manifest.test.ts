import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hostAllowed,
  loadManifest,
  parseHttpUrl,
  qualifiedToolName,
  satisfiesRange,
  splitToolName,
  STRATA_VERSION,
} from "../src/index";

describe("the plugin version this host reports", () => {
  test("matches the shell's version", () => {
    // The sidecar has no package.json beside it, so the constant is the only
    // copy of the version a manifest can be checked against. A drift here
    // makes every `engines.strata` check quietly wrong, so the two are pinned
    // together here rather than by memory.
    const conf = join(import.meta.dir, "../../../apps/desktop/src-tauri/tauri.conf.json");
    const tauri = JSON.parse(readFileSync(conf, "utf8")) as { version: string };
    expect(STRATA_VERSION).toBe(tauri.version);
  });
});

describe("engines ranges", () => {
  test("a bare minimum is the common case", () => {
    expect(satisfiesRange("0.28.0", ">=0.28.0").ok).toBe(true);
    expect(satisfiesRange("0.27.9", ">=0.28.0").ok).toBe(false);
    // The reason is what a reader sees in the log when a plugin is refused.
    expect(satisfiesRange("0.27.9", ">=0.28.0").reason).toContain("requires");
  });

  test("a bounded range has both ends", () => {
    expect(satisfiesRange("0.25.0", ">=0.24.0 <0.30.0").ok).toBe(true);
    expect(satisfiesRange("0.30.0", ">=0.24.0 <0.30.0").ok).toBe(false);
    expect(satisfiesRange("0.23.0", ">=0.24.0 <0.30.0").ok).toBe(false);
  });

  test("^ and ~ mean what they mean elsewhere", () => {
    expect(satisfiesRange("1.4.2", "^1.2.0").ok).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.2.0").ok).toBe(false);
    expect(satisfiesRange("1.2.9", "~1.2.3").ok).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.3").ok).toBe(false);
  });

  test("anything unreadable is a refusal, not a pass", () => {
    // "I could not read your requirement" is not "yes": a plugin that wanted a
    // range this host cannot judge must not be loaded on a guess.
    expect(satisfiesRange("1.0.0", "latest").ok).toBe(false);
    expect(satisfiesRange("1.0.0", "*").ok).toBe(true);
    expect(satisfiesRange("1.0.0", "").ok).toBe(true);
  });

  test("a prerelease compares as its release", () => {
    expect(satisfiesRange("0.28.0-beta.1", ">=0.28.0").ok).toBe(true);
  });
});

describe("tool names", () => {
  test("qualified names split on the first underscore", () => {
    expect(splitToolName("browser_navigate")).toEqual({ pluginId: "browser", tool: "navigate" });
    // An underscore inside the tool survives, which is why ids may not have one.
    expect(splitToolName("dev_start_now")).toEqual({ pluginId: "dev", tool: "start_now" });
    expect(splitToolName("navigate")).toBeUndefined();
    expect(splitToolName("_x")).toBeUndefined();
    expect(splitToolName("x_")).toBeUndefined();
  });

  test("the qualified name is what a plugin declares", () => {
    expect(qualifiedToolName("dev", "start")).toBe("dev_start");
  });
});

describe("manifest defaults", () => {
  test("the minimal manifest is valid and adds nothing surprising", () => {
    const manifest = loadManifest({ id: "min", name: "Min", version: "0.1.0", entry: { kind: "builtin" } });
    expect(manifest.provides).toEqual([]);
    expect(manifest.tools).toEqual([]);
    expect(manifest.permissions).toEqual({});
    expect(manifest.hooks).toBeUndefined();
  });

  test("engines is optional, and a refused version says why", () => {
    expect(() =>
      loadManifest({ id: "new", name: "N", version: "1", entry: { kind: "builtin" }, engines: { strata: ">=99.0.0" } }),
    ).not.toThrow();
    // The range is checked at load time by the host, not by the parser: a
    // manifest is a declaration, and "too new for this build" is not malformed.
    expect(satisfiesRange(STRATA_VERSION, ">=99.0.0").ok).toBe(false);
  });
});

describe("the one reading of a URL", () => {
  test("a bare host:port is the http URL it obviously meant", () => {
    // The tool description says "http(s) URL, or host:port"; a model types
    // exactly that, and driving a local dev server is the common case.
    expect(parseHttpUrl("localhost:3000")).toMatchObject({ host: "localhost:3000" });
    expect(parseHttpUrl("127.0.0.1:8080")?.url).toBe("http://127.0.0.1:8080/");
    expect(parseHttpUrl("example.com")?.host).toBe("example.com");
    expect(parseHttpUrl("example.com:8443/path?q=1")?.url).toBe("http://example.com:8443/path?q=1");
  });

  test("a scheme is only honoured with //, so host:port is not read as a scheme", () => {
    // `new URL("localhost:3000")` succeeds with `localhost:` as the scheme —
    // the old code then refused it as an unsupported protocol.
    expect(parseHttpUrl("localhost:3000")?.error).toBeUndefined();
    expect(parseHttpUrl("https://example.com")?.url).toBe("https://example.com/");
    expect(parseHttpUrl("ftp://example.com")?.error).toMatch(/unsupported scheme/);
    expect(parseHttpUrl("file:///etc/passwd")?.error).toMatch(/unsupported scheme/);
    expect(parseHttpUrl("javascript://alert(1)")?.error).toMatch(/unsupported scheme/);
  });

  test("the things an agent must not open stay refused", () => {
    // No `//`, so these are not read as schemes — and none of them is a valid
    // http URL either, which is the point: they fail as pages, not as schemes.
    // Each names the reason, because a refusal the model cannot read is a
    // refusal it retries.
    expect(parseHttpUrl("javascript:alert(1)")?.error).toMatch(/unsupported scheme javascript:/);
    expect(parseHttpUrl("data:text/html,x")?.error).toMatch(/unsupported scheme data:/);
    // A single slash is still a scheme: this used to be read as the host
    // `file` and fetched over the network.
    expect(parseHttpUrl("file:/etc/passwd")?.error).toMatch(/unsupported scheme file:/);
    expect(parseHttpUrl("file:///etc/passwd")?.error).toMatch(/unsupported scheme file:/);
    for (const bad of ["  ", ""]) expect(parseHttpUrl(bad)?.error).toBeDefined();
    expect(parseHttpUrl("http:example.com")?.error).toBeDefined();
    expect(parseHttpUrl("http://user:pass@example.com")?.error).toMatch(/credentials/);
    expect(parseHttpUrl(42)?.error).toBeDefined();
  });

  test("an allowlist reads hosts, wildcards and ports", () => {
    expect(hostAllowed("example.com", ["*"])).toBe(true);
    expect(hostAllowed("example.com:443", ["example.com"])).toBe(true);
    expect(hostAllowed("api.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("evil-example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("localhost:3000", ["localhost:3000"])).toBe(true);
    expect(hostAllowed("localhost:3001", ["localhost:3000"])).toBe(false);
    expect(hostAllowed("example.com", [])).toBe(false);
    expect(hostAllowed("example.com", undefined)).toBe(false);
  });
});
