// A browser the sessions can drive, owned by the service.
//
// Two kinds of page live behind one tab model:
//
// - The app's own Chrome: a persistent context launched on first use, with its
//   profile under the desktop data directory. Log in once — SSO, the intranet
//   wiki, the staging build — and every session that drives the browser after
//   that carries the same state. It also opens a DevTools port on loopback, so
//   a service that restarts can adopt the still-running window instead of
//   opening a second one.
// - Attached targets: anything that answers CDP on a port. An Electron app
//   started with --remote-debugging-port is the case this exists for — its
//   windows are Chromium pages like any other, and they show up here as tabs.
//   The service never closes a window it only attached to.
//
// The agent does not see selectors. A snapshot marks the interactive elements
// with data-strata-ref attributes and reads back a numbered list; actions
// address those refs. The list is only honest until the page changes, so every
// action answers with a fresh snapshot — the ref a click produced may already
// be gone, and an action that reuses it must fail with that said plainly.

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  /** "chrome" pages belong to the app's own window; "attached" belongs to whatever the port answered with. */
  source: "chrome" | "attached";
  current: boolean;
}

export interface BrowserState {
  /** Whether the app's own Chrome is up — "off" until the first chrome page exists. */
  chrome: "running" | "off";
  targets: BrowserTab[];
}

export interface SnapshotElement {
  ref: string;
  role: string;
  tag: string;
  name?: string;
  type?: string;
  disabled?: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** How many matching elements were dropped past the cap. */
  truncated: number;
  /** Pre-rendered lines the caller can hand straight to a reader. */
  text: string;
}

export interface ConsoleLine {
  at: number;
  kind: "console" | "pageerror" | "requestfailed";
  text: string;
}

export type BrowserAction = "click" | "fill" | "type" | "press" | "hover" | "select";

export interface BrowserManager {
  state(sessionID: string): BrowserState;
  navigate(sessionID: string, url: string): Promise<BrowserSnapshot>;
  attach(sessionID: string, port: number): Promise<BrowserState>;
  snapshot(sessionID: string): Promise<BrowserSnapshot>;
  act(sessionID: string, input: { ref: string; action: BrowserAction; text?: string; key?: string }): Promise<BrowserSnapshot>;
  evaluate(sessionID: string, js: string): Promise<string>;
  consoleLines(sessionID: string, tail?: number): ConsoleLine[];
  screenshot(sessionID: string): Promise<{ data: string; path: string }>;
  use(sessionID: string, target: string): Promise<BrowserState>;
  close(sessionID: string): Promise<number>;
  dispose(): Promise<void>;
}

export interface BrowserManagerOptions {
  /** The desktop data directory: profile, state file, and screenshots live under it. */
  stateDir: string;
  /** Test seam: replaces the persistent-context launch. */
  launch?: (userDataDir: string, port: number) => Promise<BrowserContext>;
  /** Test seam: replaces connectOverCDP. */
  connect?: (endpoint: string) => Promise<Browser>;
}

/** Snapshot rows after this many elements get cut — the list has to stay readable. */
const MAX_ELEMENTS = 160;
/** Tabs one session may hold. A runaway opener is a bug, not a workload. */
const MAX_TABS_PER_SESSION = 12;
/** Console output kept per page. */
const MAX_CONSOLE_LINES = 500;
/** How long an action may take before the element is called unworkable. */
const ACT_TIMEOUT_MS = 6_000;
/** How long navigation waits for DOM before answering with what is there. */
const NAV_TIMEOUT_MS = 20_000;
/** Pause after an action before the next snapshot — a DOM update needs a beat. */
const SETTLE_MS = 350;

const REF_ATTR = "data-strata-ref";
const REF = /^e\d{1,6}$/;

/** What a state file carries across a restart: the port to adopt the window by. */
interface PersistedBrowser {
  port?: number;
}

interface SessionBrowsing {
  pages: Map<string, Page>;
  source: Map<string, "chrome" | "attached">;
  current?: string;
  /** CDP connections this session opened; closing the session lets them go. */
  attached: Browser[];
}

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

async function portFree(port: number): Promise<boolean> {
  const free = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(400);
    socket.once("connect", () => done(false));
    socket.once("timeout", () => done(true));
    socket.once("error", () => done(true));
  });
  return free;
}

/** A ref the caller handed, checked before it is ever put in a selector. */
export function browserRef(input: unknown): string | undefined {
  return typeof input === "string" && REF.test(input) ? input : undefined;
}

/**
 * A URL the caller may drive to: http(s) only, with a bare host:port given the
 * http it almost certainly meant. `javascript:` and `file:` are not pages an
 * agent should be navigating to — eval is the escape hatch, not the address bar.
 */
export function browserUrl(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const text = input.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `http://${text}`);
  } catch {
    return undefined;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
}

/** Caller's fault — stale ref, missing page — not the browser's. Routes answer 400. */
export class BrowserClientError extends Error {}

/**
 * The snapshot as lines, one element each: `e5 button "提交"`.
 * Kept here rather than in the caller so the shape is the tested one.
 */
export function formatSnapshot(snap: Omit<BrowserSnapshot, "text">): string {
  const head = `${snap.title || "(untitled)"} — ${snap.url}`;
  const rows = snap.elements.map((el) => {
    const name = el.name ? ` "${el.name}"` : "";
    const flags = `${el.disabled ? " (disabled)" : ""}`;
    const type = el.type && el.tag === "input" ? `:${el.type}` : "";
    return `${el.ref} ${el.role}${type}${name}${flags}`;
  });
  const tail = snap.truncated > 0 ? `\n… ${snap.truncated} more elements not shown` : "";
  return [head, ...rows].join("\n") + tail;
}

/**
 * Runs inside the page. Self-contained on purpose: Playwright serialises the
 * function, so nothing here may close over module state.
 *
 * The pass clears the marks of the previous snapshot, then walks every
 * candidate selector. An element earns a ref when it is visible; the name is
 * the first of aria-label, labelled-by text, its own text, placeholder, title,
 * alt, or value — in that order, which is roughly how a reader would name it.
 */
function markPage(maxElements: number) {
  const REF_ATTR = "data-strata-ref";
  document.querySelectorAll(`[${REF_ATTR}]`).forEach((el) => el.removeAttribute(REF_ATTR));
  const SELECTOR = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[contenteditable=''],[contenteditable='true']",
    "[role]",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const TAG_ROLE: Record<string, string> = {
    a: "link",
    button: "button",
    select: "combobox",
    textarea: "textbox",
    summary: "button",
  };
  const INPUT_ROLE: Record<string, string> = {
    button: "button",
    checkbox: "checkbox",
    radio: "radio",
    range: "slider",
    submit: "button",
    reset: "button",
    search: "searchbox",
  };
  const roleOf = (el: Element): string => {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      return INPUT_ROLE[type] ?? "textbox";
    }
    return TAG_ROLE[tag] ?? "generic";
  };
  const nameOf = (el: Element): string => {
    const direct = el.getAttribute("aria-label");
    if (direct?.trim()) return direct.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      if (text) return text.slice(0, 120);
    }
    const own = (el as HTMLElement).innerText?.trim() || el.textContent?.trim() || "";
    if (own) return own.replace(/\s+/g, " ").slice(0, 120);
    for (const attr of ["placeholder", "title", "alt", "value", "name"]) {
      const v = el.getAttribute(attr);
      if (v?.trim()) return v.trim().slice(0, 120);
    }
    return "";
  };
  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const elements: {
    ref: string;
    role: string;
    tag: string;
    name?: string;
    type?: string;
    disabled?: boolean;
  }[] = [];
  let found = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
    found += 1;
    if (elements.length >= maxElements) continue;
    if (!visible(el)) continue;
    const ref = `e${elements.length + 1}`;
    el.setAttribute(REF_ATTR, ref);
    const tag = el.tagName.toLowerCase();
    const name = nameOf(el);
    const type = tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : undefined;
    const disabled =
      (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";
    elements.push({ ref, role: roleOf(el), tag, ...(name ? { name } : {}), ...(type ? { type } : {}), ...(disabled ? { disabled } : {}) });
  }
  return { url: location.href, title: document.title, elements, truncated: Math.max(0, found - elements.length) };
}

export function createBrowserManager(opts: BrowserManagerOptions): BrowserManager {
  const profileDir = join(opts.stateDir, "browser-profile");
  const shotsDir = join(opts.stateDir, "browser-shots");
  const stateFile = join(opts.stateDir, "browser-state.json");
  const sessions = new Map<string, SessionBrowsing>();
  const consoles = new Map<Page, ConsoleLine[]>();
  let counter = 0;
  /** The app's own Chrome context — launched or adopted, undefined until needed. */
  let contextPromise: Promise<BrowserContext> | undefined;
  /** The CDP handle when the context was adopted rather than launched. */
  let adopted: Browser | undefined;
  let chromeDead = false;
  /** The DevTools port the app-owned Chrome was launched with. */
  let launchedPort = 0;
  /** Which attach connection a foreign page arrived through, for clean-up. */
  const pageOwner = new Map<Page, Browser>();

  const sessionOf = (sessionID: string): SessionBrowsing => {
    let s = sessions.get(sessionID);
    if (!s) {
      s = { pages: new Map(), source: new Map(), attached: [] };
      sessions.set(sessionID, s);
    }
    return s;
  };

  const pushLine = (page: Page, kind: ConsoleLine["kind"], text: string) => {
    let lines = consoles.get(page);
    if (!lines) {
      lines = [];
      consoles.set(page, lines);
    }
    lines.push({ at: Date.now(), kind, text: text.slice(0, 500) });
    if (lines.length > MAX_CONSOLE_LINES) lines.splice(0, lines.length - MAX_CONSOLE_LINES);
  };

  const track = (
    session: SessionBrowsing,
    page: Page,
    source: "chrome" | "attached",
    owner?: Browser,
  ): string => {
    for (const [id, p] of session.pages) if (p === page) return id;
    const id = `pg${++counter}`;
    session.pages.set(id, page);
    session.source.set(id, source);
    if (owner) pageOwner.set(page, owner);
    if (!session.current) session.current = id;
    page.on("console", (msg) => pushLine(page, "console", `${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (err) => pushLine(page, "pageerror", err.message));
    page.on("requestfailed", (req) =>
      pushLine(page, "requestfailed", `${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "failed"}`),
    );
    page.on("close", () => {
      session.pages.delete(id);
      session.source.delete(id);
      consoles.delete(page);
      if (session.current === id) session.current = [...session.pages.keys()][0];
    });
    return id;
  };

  const launch = async (): Promise<BrowserContext> => {
    const port = randomPort();
    await portFree(port).then((free) => {
      if (!free) throw new Error(`port ${port} is held`);
    });
    launchedPort = port;
    if (opts.launch) return opts.launch(profileDir, port);
    mkdirSync(profileDir, { recursive: true });
    const attempt = (channel: "chrome" | "msedge" | "chromium") =>
      chromium.launchPersistentContext(profileDir, {
        channel,
        headless: false,
        args: [`--remote-debugging-port=${port}`],
      });
    try {
      return await attempt("chrome");
    } catch (first) {
      try {
        return await attempt("msedge");
      } catch {
        try {
          return await attempt("chromium");
        } catch {
          throw first instanceof Error ? first : new Error(String(first));
        }
      }
    }
  };

  /** Adopt the window a previous run left, if it is still answering. */
  const reconnect = async (): Promise<BrowserContext | undefined> => {
    let saved: PersistedBrowser = {};
    try {
      saved = JSON.parse(readFileSync(stateFile, "utf8")) as PersistedBrowser;
    } catch {
      return undefined;
    }
    const port = saved.port;
    if (!port) return undefined;
    try {
      const browser = await (opts.connect ?? ((e: string) => chromium.connectOverCDP(e)))(
        `http://127.0.0.1:${port}`,
      );
      const context = browser.contexts()[0];
      if (!context) {
        await browser.close().catch(() => {});
        return undefined;
      }
      adopted = browser;
      return context;
    } catch {
      rmSync(stateFile, { force: true });
      return undefined;
    }
  };

  const ensureContext = (): Promise<BrowserContext> => {
    if (chromeDead) {
      contextPromise = undefined;
      chromeDead = false;
    }
    contextPromise ??= (async () => {
      const revived = await reconnect();
      if (revived) return revived;
      const context = await launch();
      try {
        mkdirSync(opts.stateDir, { recursive: true });
        writeFileSync(stateFile, JSON.stringify({ port: launchedPort }), "utf8");
      } catch {
        // A state file that cannot be written only costs the reconnect next run.
      }
      context.on("close", () => {
        chromeDead = true;
        rmSync(stateFile, { force: true });
      });
      return context;
    })();
    contextPromise.catch(() => {
      contextPromise = undefined;
    });
    return contextPromise;
  };

  const newTab = async (session: SessionBrowsing): Promise<Page> => {
    if (session.pages.size >= MAX_TABS_PER_SESSION) {
      throw new BrowserClientError(`session already holds ${MAX_TABS_PER_SESSION} tabs — close some first`);
    }
    const context = await ensureContext();
    const page = await context.newPage();
    track(session, page, "chrome");
    return page;
  };

  const currentPage = (session: SessionBrowsing): Page => {
    const id = session.current;
    const page = id ? session.pages.get(id) : undefined;
    if (page) return page;
    const first = [...session.pages.values()][0];
    if (first) return first;
    throw new BrowserClientError("no page yet — call browser_navigate to open one, or browser_attach to an app");
  };

  const takeSnapshot = async (page: Page): Promise<BrowserSnapshot> => {
    const raw = await page.evaluate(markPage, MAX_ELEMENTS);
    return { ...raw, text: formatSnapshot(raw) };
  };

  /** Give a triggered navigation or DOM update a moment before reading the page back. */
  const settle = async (page: Page): Promise<void> => {
    await page
      .waitForLoadState("domcontentloaded", { timeout: 3_000 })
      .catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
  };

  const state = (sessionID: string): BrowserState => {
    const session = sessions.get(sessionID);
    const targets: BrowserTab[] = [];
    for (const [id, page] of session?.pages ?? []) {
      targets.push({
        id,
        url: page.url(),
        title: "",
        source: session!.source.get(id) ?? "chrome",
        current: session!.current === id,
      });
    }
    return { chrome: contextPromise !== undefined ? "running" : "off", targets };
  };

  return {
    state,

    async navigate(sessionID, url) {
      const session = sessionOf(sessionID);
      const page = session.pages.size > 0 ? currentPage(session) : await newTab(session);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      } catch {
        // A server that is slow or never finishes still has a page worth reading.
      }
      await settle(page);
      return takeSnapshot(page);
    },

    async attach(sessionID, port) {
      const session = sessionOf(sessionID);
      const browser = await (opts.connect ?? ((e: string) => chromium.connectOverCDP(e)))(
        `http://127.0.0.1:${port}`,
      );
      session.attached.push(browser);
      browser.on("disconnected", () => {
        for (const [id, page] of session.pages) {
          if (pageOwner.get(page) !== browser) continue;
          session.pages.delete(id);
          session.source.delete(id);
          pageOwner.delete(page);
          if (session.current === id) session.current = [...session.pages.keys()][0];
        }
      });
      let added = 0;
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          // DevTools windows show up as pages too; they are not the app.
          if (page.url().startsWith("devtools://")) continue;
          track(session, page, "attached", browser);
          added += 1;
        }
      }
      if (added === 0) {
        throw new BrowserClientError("the port answered but no page was there — nothing to drive");
      }
      return state(sessionID);
    },

    async snapshot(sessionID) {
      return takeSnapshot(currentPage(sessionOf(sessionID)));
    },

    async act(sessionID, input) {
      const session = sessionOf(sessionID);
      const page = currentPage(session);
      const ref = browserRef(input.ref);
      if (!ref) throw new BrowserClientError(`bad ref — refs look like e5, got ${JSON.stringify(input.ref)}`);
      const locator = page.locator(`[${REF_ATTR}="${ref}"]`).first();
      const found = await locator.count().catch(() => 0);
      if (found === 0) {
        throw new BrowserClientError(`${ref} is not on the page — it changed since the snapshot. Take a fresh snapshot first.`);
      }
      try {
        switch (input.action) {
          case "click":
            await locator.click({ timeout: ACT_TIMEOUT_MS });
            break;
          case "fill":
            await locator.fill(input.text ?? "", { timeout: ACT_TIMEOUT_MS });
            break;
          case "type":
            await locator.pressSequentially(input.text ?? "", { timeout: ACT_TIMEOUT_MS });
            break;
          case "press":
            await locator.press(input.key ?? "Enter", { timeout: ACT_TIMEOUT_MS });
            break;
          case "hover":
            await locator.hover({ timeout: ACT_TIMEOUT_MS });
            break;
          case "select":
            await locator.selectOption({ label: input.text ?? "" }, { timeout: ACT_TIMEOUT_MS });
            break;
        }
      } catch (err) {
        const why = err instanceof Error ? err.message.split("\n")[0]! : String(err);
        throw new BrowserClientError(`${input.action} on ${ref} did not work: ${why}`);
      }
      await settle(page);
      return takeSnapshot(page);
    },

    async evaluate(sessionID, js) {
      const page = currentPage(sessionOf(sessionID));
      const result = await page.evaluate(js);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return (text ?? String(result)).slice(0, 4_000);
    },

    consoleLines(sessionID, tail = 100) {
      const session = sessions.get(sessionID);
      if (!session) return [];
      const out: ConsoleLine[] = [];
      for (const page of session.pages.values()) {
        out.push(...(consoles.get(page) ?? []));
      }
      out.sort((a, b) => a.at - b.at);
      return out.slice(-Math.min(Math.max(tail, 1), MAX_CONSOLE_LINES));
    },

    async screenshot(sessionID) {
      const page = currentPage(sessionOf(sessionID));
      const png = await page.screenshot({ type: "png" });
      mkdirSync(shotsDir, { recursive: true });
      const path = join(shotsDir, `shot-${Date.now()}.png`);
      writeFileSync(path, png);
      return { data: png.toString("base64"), path };
    },

    async use(sessionID, target) {
      const session = sessionOf(sessionID);
      if (!session.pages.has(target)) {
        throw new BrowserClientError(`no tab ${target} — browser_tabs lists what this session holds`);
      }
      session.current = target;
      await session.pages.get(target)!.bringToFront().catch(() => {});
      return state(sessionID);
    },

    async close(sessionID) {
      const session = sessions.get(sessionID);
      if (!session) return 0;
      let closed = 0;
      for (const [id, page] of session.pages) {
        if (session.source.get(id) === "chrome") {
          await page.close().catch(() => {});
          closed += 1;
        }
      }
      for (const browser of session.attached) await browser.close().catch(() => {});
      session.pages.clear();
      session.source.clear();
      sessions.delete(sessionID);
      return closed;
    },

    async dispose() {
      for (const session of sessions.values()) {
        for (const browser of session.attached) await browser.close().catch(() => {});
      }
      sessions.clear();
      if (adopted) await adopted.close().catch(() => {});
      else if (contextPromise) {
        await contextPromise.then((c) => c.close()).catch(() => {});
      }
      adopted = undefined;
      contextPromise = undefined;
      consoles.clear();
      pageOwner.clear();
    },
  };
}
