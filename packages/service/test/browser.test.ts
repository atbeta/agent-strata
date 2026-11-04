import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  BrowserClientError,
  browserRef,
  browserUrl,
  createBrowserManager,
  formatSnapshot,
} from "../src/browser";

function stateDir() {
  return mkdtempSync(join(tmpdir(), "strata-browser-test-"));
}

/**
 * The smallest Page the manager's code paths touch.
 *
 * `evaluate` never actually runs the function it is handed — `markPage` needs a
 * DOM — it answers a canned snapshot instead. A string argument is the eval
 * tool's raw JavaScript, and gets a marker string back.
 */
function fakePage(url = "about:blank", locatorCount = 1) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const closed = { value: false };
  const page = {
    url: () => url,
    on: (event: string, fn: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return page;
    },
    close: async () => {
      closed.value = true;
      for (const fn of listeners.get("close") ?? []) fn();
    },
    goto: async () => null,
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    viewportSize: () => ({ width: 1280, height: 720 }),
    evaluate: async (fn: unknown) => {
      if (typeof fn === "string") return "eval-result";
      return {
        url,
        title: "Fake",
        elements: [{ ref: "e1", role: "button", tag: "button", name: "Go" }],
        truncated: 0,
      };
    },
    locator: () => {
      const self = {
        first: () => self,
        count: async () => locatorCount,
        click: async () => {},
        fill: async () => {},
        pressSequentially: async () => {},
        press: async () => {},
        hover: async () => {},
        selectOption: async () => {},
      };
      return self;
    },
    screenshot: async () => Buffer.from("png-bytes"),
    mouse: {
      calls: [] as unknown[],
      click: async (...a: unknown[]) => void page.mouse.calls.push(["click", ...a]),
      move: async (...a: unknown[]) => void page.mouse.calls.push(["move", ...a]),
      down: async (...a: unknown[]) => void page.mouse.calls.push(["down", ...a]),
      up: async (...a: unknown[]) => void page.mouse.calls.push(["up", ...a]),
      wheel: async (...a: unknown[]) => void page.mouse.calls.push(["wheel", ...a]),
    },
    keyboard: {
      calls: [] as unknown[],
      press: async (...a: unknown[]) => void page.keyboard.calls.push(["press", ...a]),
      type: async (...a: unknown[]) => void page.keyboard.calls.push(["type", ...a]),
    },
    context: () => ({
      newCDPSession: async () => cdp,
    }),
  };
  const cdp = {
    sent: [] as unknown[],
    frames: [] as ((ev: { data: string; sessionId: number }) => void)[],
    on: (name: string, fn: (ev: { data: string; sessionId: number }) => void) => {
      if (name === "Page.screencastFrame") cdp.frames.push(fn);
    },
    send: async (method: string, params?: unknown) => {
      cdp.sent.push([method, params]);
    },
    detach: async () => {
      cdp.detached = true;
    },
    detached: false,
    fire: (data: string) => {
      for (const fn of cdp.frames) fn({ data, sessionId: 1 });
    },
  };
  return { page: page as unknown as Page, closed, listeners, cdp };
}

function fakeContext(pages: Page[] = []) {
  const created: Page[] = [];
  return {
    newPage: async () => {
      const { page } = fakePage();
      created.push(page);
      return page;
    },
    pages: () => [...pages, ...created],
    on: () => {},
    close: async () => {},
    browser: () => null,
  } as unknown as BrowserContext;
}

describe("caller input at the edge", () => {
  test("a ref is e-digits and nothing else", () => {
    expect(browserRef("e5")).toBe("e5");
    expect(browserRef("e0")).toBe("e0");
    expect(browserRef("x5")).toBeUndefined();
    expect(browserRef("e")).toBeUndefined();
    expect(browserRef('e5"]')).toBeUndefined();
    expect(browserRef(5)).toBeUndefined();
  });

  test("bare hosts get http; anything not http(s) is refused", () => {
    expect(browserUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(browserUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(browserUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
    expect(browserUrl("file:///etc/passwd")).toBeUndefined();
    expect(browserUrl("javascript:alert(1)")).toBeUndefined();
    expect(browserUrl("")).toBeUndefined();
    expect(browserUrl(42)).toBeUndefined();
  });
});

describe("the snapshot as text", () => {
  test("one line per element, inputs carry their type, disabled is marked", () => {
    const text = formatSnapshot({
      url: "http://localhost:3000/",
      title: "App",
      truncated: 0,
      elements: [
        { ref: "e1", role: "link", tag: "a", name: "Home" },
        { ref: "e2", role: "textbox", tag: "input", type: "search", name: "Find" },
        { ref: "e3", role: "button", tag: "button", name: "Save", disabled: true },
        { ref: "e4", role: "generic", tag: "div" },
      ],
    });
    expect(text).toBe(
      [
        "App — http://localhost:3000/",
        'e1 link "Home"',
        'e2 textbox:search "Find"',
        'e3 button "Save" (disabled)',
        "e4 generic",
      ].join("\n"),
    );
  });

  test("a cut list says how much was dropped", () => {
    const text = formatSnapshot({
      url: "u",
      title: "t",
      truncated: 40,
      elements: [{ ref: "e1", role: "link", tag: "a", name: "x" }],
    });
    expect(text.endsWith("… 40 more elements not shown")).toBe(true);
  });
});

describe("a session's tabs", () => {
  test("navigate opens a chrome tab and the snapshot comes back rendered", async () => {
    const dir = stateDir();
    const manager = createBrowserManager({
      stateDir: dir,
      launch: async () => fakeContext(),
    });
    const snap = await manager.navigate("s1", "http://localhost:3000/");
    expect(snap.text).toContain("Fake");
    expect(snap.text).toContain('e1 button "Go"');
    const st = manager.state("s1");
    expect(st.targets).toHaveLength(1);
    expect(st.targets[0]!.source).toBe("chrome");
    expect(st.chrome).toBe("running");
    await manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a malformed ref is the caller's 400, a missing element is too", async () => {
    const dir = stateDir();
    const manager = createBrowserManager({
      stateDir: dir,
      launch: async () => fakeContext([fakePage("http://x/", 0).page]),
    });
    await manager.navigate("s1", "http://x/");
    try {
      await manager.act("s1", { ref: "bogus", action: "click" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BrowserClientError);
    }
    await manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  test("pages that do not exist yet are named, not crashed on", async () => {
    const dir = stateDir();
    const manager = createBrowserManager({ stateDir: dir });
    await expect(manager.snapshot("nobody")).rejects.toThrow(/no page yet/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("closing lets foreign windows go but keeps none of the tabs", async () => {
    const dir = stateDir();
    const { page: foreign } = fakePage("electron://app");
    const foreignBrowser = {
      contexts: () => [{ pages: () => [foreign] }],
      on: () => {},
      close: async () => {},
    } as unknown as Browser;
    const manager = createBrowserManager({
      stateDir: dir,
      connect: async () => foreignBrowser,
    });
    const st = await manager.attach("s1", 9222);
    expect(st.targets[0]!.source).toBe("attached");
    const closed = await manager.close("s1");
    expect(closed).toBe(0);
    expect(manager.state("s1").targets).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a launch failure is retried cleanly on the next call", async () => {
    const dir = stateDir();
    let calls = 0;
    const manager = createBrowserManager({
      stateDir: dir,
      launch: async () => {
        calls += 1;
        if (calls === 1) throw new Error("no chrome");
        return fakeContext();
      },
    });
    await expect(manager.navigate("s1", "http://x/")).rejects.toThrow("no chrome");
    const snap = await manager.navigate("s1", "http://x/");
    expect(snap.text).toContain("Fake");
    await manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a watcher sees the current page and its screencast", async () => {
    const dir = stateDir();
    const seen: { type: string; page?: string; data?: string }[] = [];
    // about:blank gets adopted as the session's first tab, like a real
    // persistent context's initial page.
    const { page, cdp } = fakePage("about:blank");
    const manager = createBrowserManager({
      stateDir: dir,
      launch: async () => fakeContext([page]),
    });
    await manager.navigate("s1", "http://a/");
    const stop = manager.watch("s1", (ev) => {
      seen.push(ev.type === "meta" ? { type: "meta", page: ev.meta.page } : { type: "frame", data: ev.data });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen[0]).toEqual({ type: "meta", page: "pg1" });
    expect(cdp.sent).toContainEqual(["Page.startScreencast", expect.anything()]);
    cdp.fire("jpeg-bytes");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContainEqual({ type: "frame", data: "jpeg-bytes" });
    stop();
    await manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an empty session's watcher hears the empty meta, not a crash", async () => {
    const dir = stateDir();
    const manager = createBrowserManager({ stateDir: dir });
    const seen: string[] = [];
    manager.watch("ghost", (ev) => seen.push(ev.type));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["meta"]);
    await manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  test("input lands on the current page's mouse and keyboard", async () => {
    const dir = stateDir();
    const { page } = fakePage("about:blank");
    const manager = createBrowserManager({
      stateDir: dir,
      launch: async () => fakeContext([page]),
    });
    await manager.navigate("s1", "http://a/");
    const mouse = (page as unknown as { mouse: { calls: unknown[] } }).mouse;
    const keyboard = (page as unknown as { keyboard: { calls: unknown[] } }).keyboard;
    await manager.input("s1", { kind: "click", x: 10, y: 20 });
    await manager.input("s1", { kind: "wheel", x: 5, y: 5, dx: 0, dy: 120 });
    await manager.input("s1", { kind: "key", key: "Enter" });
    await manager.input("s1", { kind: "type", text: "hi" });
    expect(mouse.calls).toEqual([
      ["click", 10, 20, { button: "left" }],
      ["move", 5, 5],
      ["wheel", 0, 120],
    ]);
    expect(keyboard.calls).toEqual([
      ["press", "Enter"],
      ["type", "hi"],
    ]);
    await manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
});
