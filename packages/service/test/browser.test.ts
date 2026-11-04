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
  };
  return { page: page as unknown as Page, closed, listeners };
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
});
