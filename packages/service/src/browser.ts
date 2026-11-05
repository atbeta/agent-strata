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
  type CDPSession,
  type Page,
} from "playwright-core";
import { mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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
  /** The navigation error, when the last goto never reached its target. */
  error?: string;
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
  watch(sessionID: string, sink: (ev: WatchEvent) => void): () => void;
  input(sessionID: string, action: BrowserInput): Promise<void>;
  close(sessionID: string): Promise<number>;
  dispose(): Promise<void>;
}

/** What a watcher sees first: which page the frames belong to and how big they are. */
export interface WatchMeta {
  page: string;
  url: string;
  w: number;
  h: number;
}

export type WatchEvent =
  | { type: "meta"; meta: WatchMeta }
  | { type: "frame"; data: string };

/** What the pane's pointer and keys become, in viewport CSS pixels. */
export type BrowserInput =
  | { kind: "click" | "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right" }
  | { kind: "wheel"; x: number; y: number; dx: number; dy: number }
  | { kind: "key"; key: string }
  | { kind: "type"; text: string };

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

/** What a state file carries across a restart: enough to adopt the window back. */
interface PersistedBrowser {
  port?: number;
  pid?: number;
}

interface SessionBrowsing {
  id: string;
  pages: Map<string, Page>;
  source: Map<string, "chrome" | "attached">;
  current?: string;
  /** CDP connections this session opened; closing the session lets them go. */
  attached: Browser[];
}

/** One pane watching one session's current page. */
interface Watcher {
  sink: (ev: WatchEvent) => void;
  pageId?: string;
  cdp?: CDPSession;
  /** Screenshot fallback: interval while polling, timeout while arming the watchdog. */
  timer?: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>;
  /** True while the watchdog fell back to screenshot polling. */
  polling?: boolean;
  stopped: boolean;
}

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The command line of a live pid, when the OS will tell us. */
const cmdlineOf = (pid: number): string | undefined => {
  try {
    if (process.platform === "win32") {
      const out = Bun.spawnSync([
        "powershell", "-NoProfile", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ]);
      return out.exitCode === 0 ? out.stdout.toString() : undefined;
    }
    const out = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
    return out.exitCode === 0 ? out.stdout.toString() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Chrome writes its singleton lock as a symlink named for the pid that holds
 * it — POSIX only; Windows keeps the mutex in kernel space instead.
 */
const singletonPid = (profileDir: string): number | undefined => {
  if (process.platform === "win32") return undefined;
  try {
    const target = readlinkSync(join(profileDir, "SingletonLock"));
    const pid = Number(target.slice(target.lastIndexOf("-") + 1));
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
};

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
  /** The DevTools port and pid of the app-owned Chrome, for adopt-back. */
  let launchedPort = 0;
  let launchedPid = 0;
  /** Which attach connection a foreign page arrived through, for clean-up. */
  const pageOwner = new Map<Page, Browser>();
  /** Live pane watchers per session, for retarget on current-page changes. */
  const watchers = new Map<string, Set<Watcher>>();

  const sessionOf = (sessionID: string): SessionBrowsing => {
    let s = sessions.get(sessionID);
    if (!s) {
      s = { id: sessionID, pages: new Map(), source: new Map(), attached: [] };
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
    notifyWatchers(session);
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
      notifyWatchers(session);
    });
    return id;
  };

  /**
   * Point a watcher at the session's current page, starting or restarting the
   * screencast when the page underneath it changed. A session with no pages
   * gets an empty meta — the pane clears instead of showing a stale frame.
   */
  const retarget = async (w: Watcher, session: SessionBrowsing): Promise<void> => {
    if (w.stopped) return;
    const id = session.current;
    const page = id ? session.pages.get(id) : undefined;
    if (page && w.pageId === id) return;
    await w.cdp?.detach().catch(() => {});
    if (w.timer) clearInterval(w.timer);
    w.cdp = undefined;
    w.timer = undefined;
    w.polling = false;
    w.pageId = id;
    if (!page || !id) {
      w.sink({ type: "meta", meta: { page: "", url: "", w: 0, h: 0 } });
      return;
    }
    const vp = page.viewportSize();
    let lastW = vp?.width ?? 0;
    let lastH = vp?.height ?? 0;
    w.sink({
      type: "meta",
      meta: { page: id, url: page.url(), w: lastW, h: lastH },
    });
    // Screencast is not on every CDP target, and a headed window that is
    // occluded or off the screen stops producing frames at all. The stream
    // then falls back to polling a screenshot instead of the pane waiting on
    // a frame that will never come — fromSurface:false asks for the page's
    // own surface, which exists even when the window's does not.
    const shoot = async (): Promise<string> => {
      try {
        const cdp = w.cdp ?? (w.cdp = await page.context().newCDPSession(page));
        const shot = (await cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 60,
          fromSurface: false,
        })) as { data: string };
        return shot.data;
      } catch {
        const buf = await page.screenshot({ type: "jpeg", quality: 60 });
        return buf.toString("base64");
      }
    };
    const poll = () => {
      if (w.stopped || w.pageId !== id || w.polling) return;
      w.polling = true;
      w.timer = setInterval(() => {
        void shoot()
          .then((data) => {
            if (!w.stopped) w.sink({ type: "frame", data });
          })
          .catch(() => {});
      }, 600);
    };
    // Any screencast frame resets the wait; silence past the timeout polls,
    // and a frame arriving while polling means screencast is alive again.
    const arm = () => {
      w.polling = false;
      if (w.timer) clearInterval(w.timer as ReturnType<typeof setInterval>);
      w.timer = setTimeout(poll, 2_500);
    };
    try {
      const cdp = await page.context().newCDPSession(page);
      if (w.stopped || w.pageId !== id) {
        await cdp.detach().catch(() => {});
        return;
      }
      w.cdp = cdp;
      cdp.on(
        "Page.screencastFrame",
        (ev: {
          data: string;
          sessionId: number;
          metadata?: { deviceWidth?: number; deviceHeight?: number };
        }) => {
          if (w.stopped) return;
          const dw = ev.metadata?.deviceWidth ?? 0;
          const dh = ev.metadata?.deviceHeight ?? 0;
          // Attached targets report no viewportSize; the frames themselves
          // carry the real dims — and a resize lands here as a meta change.
          if (dw && dh && (dw !== lastW || dh !== lastH)) {
            lastW = dw;
            lastH = dh;
            w.sink({ type: "meta", meta: { page: id, url: page.url(), w: dw, h: dh } });
          }
          w.sink({ type: "frame", data: ev.data });
          cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
          arm();
        },
      );
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 65,
        everyNthFrame: 1,
      });
      arm();
    } catch {
      poll();
    }
  };

  const notifyWatchers = (session: SessionBrowsing): void => {
    const set = watchers.get(session.id);
    if (!set) return;
    for (const w of set) void retarget(w, session);
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

  const saveState = () => {
    try {
      mkdirSync(opts.stateDir, { recursive: true });
      writeFileSync(
        stateFile,
        JSON.stringify({ port: launchedPort, pid: launchedPid } satisfies PersistedBrowser),
        "utf8",
      );
    } catch {
      // A state file that cannot be written only costs the reconnect next run.
    }
  };

  /** One connectOverCDP attempt; a context means the window was adopted. */
  const tryConnect = async (port: number): Promise<BrowserContext | undefined> => {
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
      return undefined;
    }
  };

  /**
   * Adopt the window a previous run left, if it is still answering.
   *
   * The saved port is the fast path. When it is gone — a state file deleted on
   * a bad day, or a Chrome started before this code — the live instance still
   * names its port on its own command line, which the pid from the state file
   * or the profile's SingletonLock leads back to. A same-profile instance we
   * cannot name a port for gets killed outright: the profile is ours alone,
   * and a windowless leftover blocks every future launch through the
   * singleton lock.
   */
  const reconnect = async (): Promise<BrowserContext | undefined> => {
    let saved: PersistedBrowser = {};
    try {
      saved = JSON.parse(readFileSync(stateFile, "utf8")) as PersistedBrowser;
    } catch {
      saved = {};
    }
    const candidates = new Set<number>();
    if (saved.port) candidates.add(saved.port);
    try {
      // Chromium's own record, when it bothers to write one (absent under
      // playwright's --remote-debugging-pipe, worth the read anyway).
      const line = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8")
        .split("\n")[0]?.trim();
      const port = Number(line);
      if (Number.isInteger(port) && port > 0) candidates.add(port);
    } catch {}
    for (const port of candidates) {
      const context = await tryConnect(port);
      if (context) {
        launchedPort = port;
        launchedPid = saved.pid ?? 0;
        saveState();
        return context;
      }
    }
    const stray = saved.pid && pidAlive(saved.pid) ? saved.pid : singletonPid(profileDir);
    if (stray) {
      const port = Number(cmdlineOf(stray)?.match(/--remote-debugging-port=(\d+)/)?.[1]);
      if (port) {
        const context = await tryConnect(port);
        if (context) {
          launchedPort = port;
          launchedPid = stray;
          saveState();
          return context;
        }
      }
      try {
        process.kill(stray);
      } catch {}
      for (let i = 0; i < 20 && pidAlive(stray); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    rmSync(stateFile, { force: true });
    return undefined;
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
      // Playwright does not hand out the child pid; the profile's singleton
      // lock names it instead. Give the file a moment to appear.
      for (let i = 0; i < 10 && !launchedPid; i++) {
        launchedPid = singletonPid(profileDir) ?? 0;
        if (!launchedPid) await new Promise((r) => setTimeout(r, 100));
      }
      saveState();
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
    // A persistent context always opens on an about:blank tab, and a relaunch
    // adopts whatever the old run left. Reuse a blank one before adding
    // another, or the window fills with stray New Tabs nobody is driving.
    const page =
      context.pages().find((p) => p.url() === "about:blank") ??
      (await context.newPage());
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
      let error: string | undefined;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      } catch (err) {
        error = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      }
      await settle(page);
      const snap = await takeSnapshot(page);
      // goto does not always throw on a refused host, and page.url() keeps
      // reporting the previous good address. The page itself knows the truth.
      if (!error && snap.url.startsWith("chrome-error://")) {
        error = `the browser could not reach ${url}`;
      }
      if (!error) return snap;
      return { ...snap, error, text: `navigation failed: ${error}\n\n${snap.text}` };
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
      const fresh: string[] = [];
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          // DevTools windows show up as pages too; they are not the app.
          if (page.url().startsWith("devtools://")) continue;
          fresh.push(track(session, page, "attached", browser));
          added += 1;
        }
      }
      if (added === 0) {
        throw new BrowserClientError("the port answered but no page was there — nothing to drive");
      }
      // An Electron app keeps hidden BrowserWindows around (tray, background
      // pages); they answer CDP exactly like a real one. "Current" belongs to
      // the window a person can actually see.
      for (const id of fresh) {
        const page = session.pages.get(id);
        if (!page) continue;
        const vis = await page.evaluate(() => document.visibilityState).catch(() => "hidden");
        if (vis === "visible") {
          session.current = id;
          break;
        }
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
      notifyWatchers(session);
      return state(sessionID);
    },

    watch(sessionID, sink) {
      const session = sessionOf(sessionID);
      const w: Watcher = { sink, stopped: false };
      let set = watchers.get(sessionID);
      if (!set) {
        set = new Set();
        watchers.set(sessionID, set);
      }
      set.add(w);
      void retarget(w, session);
      return () => {
        w.stopped = true;
        set.delete(w);
        void w.cdp?.detach().catch(() => {});
        if (w.timer) clearInterval(w.timer);
      };
    },

    async input(sessionID, action) {
      const page = currentPage(sessionOf(sessionID));
      switch (action.kind) {
        case "click":
          await page.mouse.click(action.x, action.y, { button: action.button ?? "left" });
          return;
        case "move":
          await page.mouse.move(action.x, action.y);
          return;
        case "down":
          await page.mouse.down({ button: action.button ?? "left" });
          return;
        case "up":
          await page.mouse.up({ button: action.button ?? "left" });
          return;
        case "wheel":
          await page.mouse.move(action.x, action.y);
          await page.mouse.wheel(action.dx, action.dy);
          return;
        case "key":
          await page.keyboard.press(action.key);
          return;
        case "type":
          await page.keyboard.type(action.text);
          return;
      }
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
      const set = watchers.get(sessionID);
      if (set) {
        watchers.delete(sessionID);
        for (const w of set) {
          w.stopped = true;
          void w.cdp?.detach().catch(() => {});
          if (w.timer) clearInterval(w.timer);
        }
      }
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
