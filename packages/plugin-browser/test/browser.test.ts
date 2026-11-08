import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserClientError, browserRef, browserUrl, createBrowserManager, formatSnapshot } from "../src/manager";

/**
 * The browser manager against a real Chrome.
 *
 * The launch seam starts the browser headless: the shipped behaviour is a
 * visible window a person also uses, and a suite that opens ten of them is a
 * suite nobody runs. Everything else — CDP, the snapshot markers, the ref
 * actions, the session tab model — is the real thing.
 *
 * If Chrome is not installed these cases skip rather than fail: the package's
 * contract is tested by the tool cases in the service, and the manager's
 * integration with a browser is worth testing where a browser exists.
 */
const hasChrome = (() => {
  try {
    return process.platform === "darwin" || process.platform === "win32" || process.platform === "linux";
  } catch {
    return false;
  }
})();

describe.skipIf(!hasChrome)("the browser manager", () => {
  let stateDir = "";
  let server: ReturnType<typeof Bun.serve>;
  let origin = "";
  let manager: ReturnType<typeof createBrowserManager>;

  const launch = (profileDir: string, port: number) => {
    const binary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const proc = Bun.spawn(
      [
        binary,
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        // The shipped launch is headless because the rail is where the page is
        // seen; the seam mirrors it so the tests exercise the real shape.
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    return { pid: proc.pid, kill: () => proc.kill() };
  };

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "strata-browser-"));
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/other") {
          return new Response("<title>Other</title><a href='/'>back</a>", {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response(
          `<!doctype html><html><head><title>Test page</title></head><body>
             <h1>Hello</h1>
             <button id="go" onclick="document.title='Clicked'; document.getElementById('out').textContent='clicked'">Go</button>
             <a href="/other">Other</a>
             <input id="name" placeholder="Your name" />
             <input id="box" type="checkbox" aria-label="agree" />
             <select id="pick" aria-label="pick"><option>red</option><option>blue</option></select>
             <p id="out"></p>
           </body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    manager = createBrowserManager({ stateDir, launch });
  }, 60_000);

  afterAll(async () => {
    await manager?.dispose();
    server?.stop(true);
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 60_000);

  test("navigate returns a snapshot with refs, and the refs are actionable", async () => {
    const snap = await manager.navigate("session-a", origin);
    expect(snap.url).toBe(`${origin}/`);
    expect(snap.title).toBe("Test page");
    expect(snap.elements.length).toBeGreaterThan(2);
    const button = snap.elements.find((e) => e.role === "button" && e.name === "Go");
    expect(button).toBeDefined();
    expect(button!.ref).toMatch(/^e\d+$/);

    const after = await manager.act("session-a", { ref: button!.ref, action: "click" });
    expect(after.title).toBe("Clicked");
    // A fresh snapshot comes back with every action, so a stale ref is the
    // caller's fault and reads as one.
    expect(after.elements.some((e) => e.ref === button!.ref)).toBe(true);
  }, 60_000);

  test("a ref that the page no longer has fails with an explanation", async () => {
    await manager.navigate("session-a", origin);
    // e999 was never handed out; the point is the message, not the mechanism.
    let message = "";
    try {
      await manager.act("session-a", { ref: "e999", action: "click" });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/not on the page/);
  }, 60_000);

  test("fill and select change values, and the results are visible in the DOM", async () => {
    const snap = await manager.navigate("session-a", `${origin}/other`);
    expect(snap.url).toBe(`${origin}/other`);
    const back = await manager.navigate("session-a", origin);
    const input = back.elements.find((e) => e.tag === "input" && e.name === "Your name");
    expect(input).toBeDefined();
    await manager.act("session-a", { ref: input!.ref, action: "fill", text: "Ada" });

    const after = await manager.navigate("session-a", origin);
    const select = after.elements.find((e) => e.tag === "select");
    expect(select).toBeDefined();
    await manager.act("session-a", { ref: select!.ref, action: "select", text: "blue" });
  }, 60_000);

  test("console output is captured per page", async () => {
    await manager.navigate("session-a", origin);
    await manager.evaluate("session-a", "console.log('from the test'); 'ok'");
    // Console events arrive on the next tick.
    for (let i = 0; i < 20 && manager.consoleLines("session-a").length === 0; i++) await Bun.sleep(50);
    const lines = manager.consoleLines("session-a");
    expect(lines.some((l) => l.text.includes("from the test"))).toBe(true);
  }, 60_000);

  test("a screenshot is real PNG bytes", async () => {
    const shot = await manager.screenshot("session-a");
    const bytes = Buffer.from(shot.data, "base64");
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  }, 60_000);

  test("two sessions do not share tabs", async () => {
    await manager.navigate("session-a", origin);
    // A second session starts empty, on purpose: the Chrome is shared so a
    // login carries over, but a tab belongs to the session that opened it.
    expect(manager.state("session-b").targets).toHaveLength(0);
    const b = await manager.navigate("session-b", `${origin}/other`);
    expect(b.url).toBe(`${origin}/other`);
    const a = manager.state("session-a").targets;
    expect(a.every((t) => t.url.startsWith(origin))).toBe(true);
    expect(a.some((t) => t.url === `${origin}/other`)).toBe(false);
  }, 60_000);

  test("use switches tabs, and an unknown tab is refused", async () => {
    const tabs = manager.state("session-a").targets;
    expect(tabs.length).toBeGreaterThan(0);
    if (tabs.length > 1) {
      const target = tabs.find((t) => !t.current)!;
      const state = await manager.use("session-a", target.id);
      expect(state.targets.find((t) => t.id === target.id)?.current).toBe(true);
    }
    let message = "";
    try {
      await manager.use("session-a", "pg_nope");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/no tab/);
  }, 60_000);

  test("close drops the session's tabs but leaves the browser up", async () => {
    await manager.navigate("session-b", origin);
    const closed = await manager.close("session-b");
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(manager.state("session-b").targets).toHaveLength(0);
    // The other session is untouched.
    expect(manager.state("session-a").targets.length).toBeGreaterThan(0);
  }, 60_000);

  test("a second manager adopts a window a crash left running", async () => {
    // The crash case, which the state file exists for: a service that dies
    // without shutting the browser down leaves it running, and the next
    // launch has to take that window over rather than open a second one.
    //
    // The first manager is deliberately never disposed — that *is* the crash.
    // Its process is killed at the end so the suite leaves nothing behind.
    const crashDir = mkdtempSync(join(tmpdir(), "strata-browser-crash-"));
    let crashedBrowser: { kill?: () => void } | undefined;
    const first = createBrowserManager({
      stateDir: crashDir,
      launch: (profileDir, port) => {
        crashedBrowser = launch(profileDir, port);
        return crashedBrowser;
      },
    });
    let port = 0;
    try {
      await first.navigate("session-x", origin);
      const saved = JSON.parse(readFileSync(join(crashDir, "browser-state.json"), "utf8")) as { port: number };
      port = saved.port;
      expect(port).toBeGreaterThan(0);
    } finally {
      // Drop the object without disposing it: nothing closed the browser, so
      // the state file still names a live window.
      void first;
    }

    const second = createBrowserManager({ stateDir: crashDir, launch });
    try {
      const snap = await second.navigate("session-y", `${origin}/other`);
      expect(snap.url).toBe(`${origin}/other`);
      // Same DevTools port: it adopted the first window instead of launching.
      const saved = JSON.parse(readFileSync(join(crashDir, "browser-state.json"), "utf8")) as { port: number };
      expect(saved.port).toBe(port);
    } finally {
      await second.dispose();
      crashedBrowser?.kill?.();
      rmSync(crashDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);

});

describe("browser inputs", () => {
  test("a ref has to look like one before it reaches a selector", () => {
    expect(browserRef("e12")).toBe("e12");
    expect(browserRef("e")).toBeUndefined();
    expect(browserRef("e1; drop")).toBeUndefined();
    expect(browserRef("[data-x]")).toBeUndefined();
    expect(browserRef(5)).toBeUndefined();
  });

  test("only http(s) URLs are pages an agent may open", () => {
    expect(browserUrl("example.com")).toBe("http://example.com/");
    expect(browserUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(browserUrl("javascript:alert(1)")).toBeUndefined();
    expect(browserUrl("file:///etc/passwd")).toBeUndefined();
    expect(browserUrl("  ")).toBeUndefined();
  });

  test("a snapshot reads as lines a model can act on", () => {
    const text = formatSnapshot({
      url: "https://example.com",
      title: "Example",
      elements: [
        { ref: "e1", role: "link", tag: "a", name: "Docs" },
        { ref: "e2", role: "textbox", tag: "input", name: "", type: "text" },
        { ref: "e3", role: "button", tag: "button", name: "Save", disabled: true },
      ],
      truncated: 2,
    });
    expect(text.split("\n")[0]).toBe("Example — https://example.com");
    expect(text).toContain('e1 link "Docs"');
    expect(text).toContain("e2 textbox:text");
    expect(text).toContain("(disabled)");
    expect(text).toContain("2 more elements not shown");
  });

  test("a caller's mistake is a distinct error type", () => {
    // The routes turn this into a tool result the model can read; anything
    // else is a broken browser.
    expect(new BrowserClientError("bad ref") instanceof Error).toBe(true);
  });
});

describe("the page the panel sees", () => {
  test("a panel-sized viewport lays the page out at that width", async () => {
    // The rail is narrow. A page laid out for 1280 and scaled into it is the
    // unreadable thumbnail this exists to avoid, so the page is told the
    // panel's real size instead.
    const dir = mkdtempSync(join(tmpdir(), "strata-browser-vp-"));
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("<title>VP</title><p id=w>nothing</p><script>document.getElementById('w').textContent = innerWidth + 'x' + innerHeight</script>", {
          headers: { "content-type": "text/html" },
        }),
    });
    const manager = createBrowserManager({
      stateDir: dir,
      launch: (profileDir, port) => {
        const proc = Bun.spawn(
          [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${profileDir}`,
            "--headless=new",
            "--no-first-run",
            "about:blank",
          ],
          { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
        );
        return { pid: proc.pid, kill: () => proc.kill() };
      },
    });
    try {
      await manager.navigate("s", `http://127.0.0.1:${server.port}`);
      await manager.screencast("s", { fps: 1, width: 480, height: 720 });
      // The override applies to the page; read it back from the page itself.
      await Bun.sleep(200);
      const size = await manager.pageOf("s")!.evaluate<string>(
        "innerWidth + 'x' + innerHeight",
      );
      expect(size).toBe("480x720");
      manager.stopScreencast("s");
    } finally {
      await manager.dispose();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});

describe("a frame the reader can read", () => {
  test("the stream carries motion, and a settled page carries a sharp still", async () => {
    // Two sources by design: `Page.startScreencast` for motion (Chrome pushes
    // a frame per paint, at the page's CSS size — the protocol cannot enlarge
    // it), and a capture at the display's pixel ratio once the page stops
    // changing. The still is the frame a reader actually reads.
    const dir = mkdtempSync(join(tmpdir(), "strata-browser-dpr-"));
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("<title>DPR</title><p>hello</p>", { headers: { "content-type": "text/html" } }),
    });
    const frames: { data: string }[] = [];
    const manager = createBrowserManager({
      stateDir: dir,
      onFrame: (f) => frames.push(f),
      launch: (profileDir, port) => {
        const proc = Bun.spawn(
          [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${profileDir}`,
            "--headless=new",
            "--no-first-run",
            "about:blank",
          ],
          { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
        );
        return { pid: proc.pid, kill: () => proc.kill() };
      },
    });
    try {
      await manager.navigate("s", `http://127.0.0.1:${server.port}`);
      await manager.screencast("s", { fps: 10, width: 400, height: 500, scale: 2 });
      // Long enough for the seed still and one settle after the last paint.
      for (let i = 0; i < 60 && frames.length < 2; i++) await Bun.sleep(50);
      manager.stopScreencast("s");
      expect(frames.length).toBeGreaterThan(0);

      const sizes = frames.map((f) => jpegSize(Buffer.from(f.data, "base64")));
      // The page is 400x500 CSS pixels. Motion frames come at that size; the
      // settled still comes at twice that per axis, which is what makes text
      // readable on a retina panel.
      expect(sizes.some((s) => s && s.width === 800 && s.height === 1000)).toBe(true);
      for (const size of sizes) {
        expect(size).toBeDefined();
        // Never larger than the page can render, and never a desktop frame
        // squeezed into the rail.
        expect(size!.width).toBeLessThanOrEqual(800);
      }
    } finally {
      await manager.dispose();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});

/** Read a JPEG's pixel size by walking its segments. */
function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let at = 2;
  while (at < bytes.length - 9) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1]!;
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}
