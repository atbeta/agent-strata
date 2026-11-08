// A browser the sessions can drive, owned by the browser plugin.
//
// Two kinds of page live behind one tab model:
//
// - The app's own Chrome: launched on first use with a persistent profile
//   under the plugin's data directory. Log in once — SSO, the intranet wiki,
//   the staging build — and every session that drives the browser afterwards
//   carries the same state. It opens a DevTools port on loopback, so a plugin
//   that restarts can adopt the still-running window instead of opening a
//   second one.
// - Attached targets: anything that answers CDP on a port. An Electron app
//   started with --remote-debugging-port is the case this exists for — its
//   windows are Chromium pages like any other, and they show up here as tabs.
//   The plugin never closes a window it only attached to.
//
// The agent does not see selectors. A snapshot marks the interactive elements
// with `data-strata-ref` attributes and reads back a numbered list; actions
// address those refs. The list is only honest until the page changes, so every
// action answers with a fresh snapshot — the ref a click produced may already
// be gone, and an action that reuses it must fail with that said plainly.
//
// Transport is raw CDP (`cdp.ts`), not Playwright: Playwright's bundle cannot
// be compiled into the sidecar, and the four things it would buy here —
// snapshot, ref actions, tabs, screenshots — are a few hundred lines of
// protocol. See `cdp.ts` for what is given up by not using it.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { parseHttpUrl } from "@agent-strata/plugin-sdk";
import { CdpConnection, CdpError, CdpPage } from "./cdp";
import {
  boxExpression,
  fillExpression,
  focusExpression,
  hoverExpression,
  selectExpression,
  snapshotExpression,
} from "./snapshot";

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
  /**
   * Start pushing frames for this session's current tab.
   *
   * One screencast per session: asking twice replaces the first, because two
   * viewers of one tab is a panel bug and the older timer would keep taking
   * screenshots nobody sees.
   */
  screencast(
    sessionID: string,
    opts?: { fps?: number; width?: number; height?: number },
  ): Promise<BrowserState>;
  stopScreencast(sessionID: string): void;
  /** Give up whatever this session holds; called when it ends or the plugin stops. */
  releaseSession(sessionID: string): Promise<void>;
  /** The current page, for the panel's input route. Undefined when there is none. */
  pageOf(sessionID: string): CdpPage | undefined;
  dispose(): Promise<void>;
}

export interface BrowserManagerOptions {
  /**
   * The plugin's data directory: profile, state file, and screenshots.
   *
   * The profile is the only way a headless browser gets past a login page, so
   * it is persistent and belongs to the plugin (`<data>/browser-profile`).
   * A session started by hand can point `STRATA_BROWSER_PROFILE` elsewhere —
   * that is how a reader signs in once without the browser being visible.
   */
  stateDir: string;
  /**
   * Called for every frame the screencast produces.
   *
   * The panel is a viewer, not a controller: frames go one way. Input comes
   * back through the plugin's own route, which is why the two directions do
   * not need a shared object.
   */
  onFrame?: (frame: { session_id: string; tab: string; url: string; mime: string; data: string }) => void;
  /** Test seam: replaces the browser launch. */
  launch?: (profileDir: string, port: number) => { pid?: number; kill?: () => void } | Promise<{ pid?: number; kill?: () => void }>;
  /** Test seam: a browser binary to launch. */
  executable?: string;
}

/** Snapshot rows after this many elements get cut — the list has to stay readable. */
const MAX_ELEMENTS = 160;
/** Tabs one session may hold. A runaway opener is a bug, not a workload. */
const MAX_TABS_PER_SESSION = 12;
/** Console output kept per page. */
const MAX_CONSOLE_LINES = 500;
/** How long navigation waits for DOM before answering with what is there. */
const NAV_TIMEOUT_MS = 20_000;
/** Pause after an action before the next snapshot — a DOM update needs a beat. */
const SETTLE_MS = 350;

const REF = /^e\d{1,6}$/;

/** What a state file carries across a restart: the port to adopt the window by. */
interface PersistedBrowser {
  port?: number;
}

interface SessionBrowsing {
  pages: Map<string, Tab>;
  current?: string;
  /** CDP connections this session opened; closing the session lets them go. */
  attached: CdpConnection[];
}

/** One tab: the page handle, its connection, and where it came from. */
interface Tab {
  page: CdpPage;
  connection: CdpConnection;
  source: "chrome" | "attached";
  title: string;
  /** The last URL this tab reported. Kept in step by every snapshot. */
  url: string;
}

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

async function portFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
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
}

/** A ref the caller handed, checked before it is ever put in a selector. */
export function browserRef(input: unknown): string | undefined {
  return typeof input === "string" && REF.test(input) ? input : undefined;
}

/**
 * A URL the caller may drive to.
 *
 * The parse is the SDK's, not this file's: the host's `net` guard runs first
 * and uses the same function, so a documented `host:port` is accepted by both
 * instead of being refused by the guard before this ever runs.
 */
export function browserUrl(input: unknown): string | undefined {
  const parsed = parseHttpUrl(input);
  return parsed.error ? undefined : parsed.url;
}

/** Caller's fault — stale ref, missing page — not the browser's. */
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

/** Which executable to launch when the caller did not name one. */
function chromeExecutable(): string | undefined {
  if (process.platform === "darwin") {
    for (const app of [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]) {
      if (existsSync(app)) return app;
    }
    return undefined;
  }
  if (process.platform === "win32") {
    for (const base of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]]) {
      if (!base) continue;
      const candidate = join(base, "Google", "Chrome", "Application", "chrome.exe");
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    for (const dir of (process.env["PATH"] ?? "").split(":")) {
      if (!dir) continue;
      const candidate = join(dir, bin);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Wait for the DevTools endpoint a launched browser publishes. */
async function waitForDevtools(port: number, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
      }
    } catch {
      // not up yet
    }
    await Bun.sleep(120);
  }
  throw new CdpError(`no DevTools endpoint on port ${port} after ${timeoutMs}ms`);
}

export function createBrowserManager(opts: BrowserManagerOptions): BrowserManager {
  const profileDir = process.env.STRATA_BROWSER_PROFILE || join(opts.stateDir, "browser-profile");
  const shotsDir = join(opts.stateDir, "browser-shots");
  const stateFile = join(opts.stateDir, "browser-state.json");
  const sessions = new Map<string, SessionBrowsing>();
  const consoles = new Map<string, ConsoleLine[]>();
  let counter = 0;
  /** The app's own browser, launched or adopted, undefined until needed. */
  let chromeConnection: Promise<CdpConnection> | undefined;
  /** The process this plugin started, if it started one. */
  let chromeChild: { pid?: number; kill?: () => void } | undefined;
  let chromeDead = false;

  const sessionOf = (sessionID: string): SessionBrowsing => {
    let s = sessions.get(sessionID);
    if (!s) {
      s = { pages: new Map(), attached: [] };
      sessions.set(sessionID, s);
    }
    return s;
  };

  const pushLine = (key: string, kind: ConsoleLine["kind"], text: string) => {
    let lines = consoles.get(key);
    if (!lines) {
      lines = [];
      consoles.set(key, lines);
    }
    lines.push({ at: Date.now(), kind, text: text.slice(0, 500) });
    if (lines.length > MAX_CONSOLE_LINES) lines.splice(0, lines.length - MAX_CONSOLE_LINES);
  };

  /** Listen to one tab's console, errors and failed requests, once. */
  const watch = (tab: Tab, sessionId: string) => {
    const key = `${sessionId}:${tab.page.targetId}`;
    const connection = tab.connection;
    const session = tab.page.sessionId;
    connection.on("Runtime.consoleAPICalled", (event) => {
      if (event.sessionId !== session) return;
      const params = event.params as { type?: string; args?: { value?: unknown; description?: string }[] };
      const text = (params.args ?? [])
        .map((arg) =>
          arg.value !== undefined
            ? typeof arg.value === "string"
              ? arg.value
              : JSON.stringify(arg.value)
            : (arg.description ?? ""),
        )
        .join(" ");
      pushLine(key, "console", `${params.type ?? "log"}: ${text}`);
    });
    connection.on("Runtime.exceptionThrown", (event) => {
      if (event.sessionId !== session) return;
      const params = event.params as { exceptionDetails?: { exception?: { description?: string }; text?: string } };
      const text = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "page error";
      pushLine(key, "pageerror", text);
    });
    connection.on("Network.loadingFailed", (event) => {
      if (event.sessionId !== session) return;
      const params = event.params as { type?: string; errorText?: string; requestId?: string };
      // An aborted request is the page's own decision, not a failure worth
      // showing; a cancelled navigation in particular is normal here.
      if (params.errorText === "net::ERR_ABORTED") return;
      pushLine(key, "requestfailed", `${params.type ?? "request"} ${params.requestId ?? ""} — ${params.errorText ?? "failed"}`);
    });
    void connection.send("Runtime.enable", {}, session).catch(() => {});
    void connection.send("Network.enable", {}, session).catch(() => {});
  };

  /** Attach to a page target and wire it up. */
  const openTab = async (
    connection: CdpConnection,
    sessionId: string,
    targetId: string,
    source: "chrome" | "attached",
  ): Promise<Tab> => {
    const attached = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const page = new CdpPage(connection, attached.sessionId, targetId);
    const tab: Tab = { page, connection, source, title: "", url: "" };
    await connection.send("Page.enable", {}, attached.sessionId).catch(() => {});
    tab.title = await page.title();
    tab.url = await page.url();
    watch(tab, sessionId);
    return tab;
  };

  const track = async (
    session: SessionBrowsing,
    connection: CdpConnection,
    targetId: string,
    source: "chrome" | "attached",
    sessionId: string,
  ): Promise<string> => {
    for (const [id, tab] of session.pages) if (tab.page.targetId === targetId) return id;
    const id = `pg${++counter}`;
    session.pages.set(id, await openTab(connection, sessionId, targetId, source));
    if (!session.current) session.current = id;
    return id;
  };

  const launch = async (): Promise<CdpConnection> => {
    let port = randomPort();
    while (!(await portFree(port))) port = randomPort();
    const executable = opts.executable ?? chromeExecutable();
    if (opts.launch) {
      chromeChild = await opts.launch(profileDir, port);
    } else {
      if (!executable) {
        throw new BrowserClientError(
          "no Chrome, Chromium or Edge found on this machine — install one, or start a browser with --remote-debugging-port and use browser_attach",
        );
      }
      mkdirSync(profileDir, { recursive: true });
      const proc = Bun.spawn(
        [
          executable,
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          // The browser is never a window the reader has to manage: the rail
          // hosts it. Headless is what makes that honest — a visible Chrome
          // beside a panel showing the same page is two places to look, and
          // the reader picked one.
          "--headless=new",
          // A desktop page, so a site serves its normal layout rather than a
          // mobile one. The panel scales the frame; the page keeps its size.
          "--window-size=1280,800",
          "about:blank",
        ],
        { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
      );
      chromeChild = { pid: proc.pid, kill: () => proc.kill() };
    }
    const wsUrl = await waitForDevtools(port);
    const connection = await CdpConnection.connect(wsUrl);
    try {
      mkdirSync(opts.stateDir, { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ port }), "utf8");
    } catch {
      // A state file that cannot be written only costs the adoption next run.
    }
    connection.on("close", () => {
      chromeDead = true;
      rmSync(stateFile, { force: true });
    });
    return connection;
  };

  /** Adopt the window a previous run left, if it is still answering. */
  const reconnect = async (): Promise<CdpConnection | undefined> => {
    let saved: PersistedBrowser = {};
    try {
      saved = JSON.parse(readFileSync(stateFile, "utf8")) as PersistedBrowser;
    } catch {
      return undefined;
    }
    const port = saved.port;
    if (!port) return undefined;
    try {
      const wsUrl = await waitForDevtools(port, 1_500);
      return await CdpConnection.connect(wsUrl);
    } catch {
      rmSync(stateFile, { force: true });
      return undefined;
    }
  };

  const ensureChrome = (): Promise<CdpConnection> => {
    if (chromeDead) {
      chromeConnection = undefined;
      chromeDead = false;
    }
    chromeConnection ??= (async () => {
      const revived = await reconnect();
      if (revived) return revived;
      return launch();
    })();
    chromeConnection.catch(() => {
      chromeConnection = undefined;
    });
    return chromeConnection;
  };

  const newTab = async (session: SessionBrowsing, sessionId: string): Promise<Tab> => {
    if (session.pages.size >= MAX_TABS_PER_SESSION) {
      throw new BrowserClientError(`session already holds ${MAX_TABS_PER_SESSION} tabs — close some first`);
    }
    const connection = await ensureChrome();
    const created = await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const id = await track(session, connection, created.targetId, "chrome", sessionId);
    const tab = session.pages.get(id)!;
    const size = panelSize.get(sessionId);
    if (size) await tab.page.setViewport(size.width, size.height).catch(() => {});
    return tab;
  };

  const currentTab = (session: SessionBrowsing): Tab => {
    const id = session.current;
    const tab = id ? session.pages.get(id) : undefined;
    if (tab) return tab;
    const first = [...session.pages.values()][0];
    if (first) return first;
    throw new BrowserClientError("no page yet — call browser_navigate to open one, or browser_attach to an app");
  };

  const takeSnapshot = async (tab: Tab): Promise<BrowserSnapshot> => {
    const raw = await tab.page.evaluate<{
      url: string;
      title: string;
      elements: SnapshotElement[];
      truncated: number;
    }>(snapshotExpression(MAX_ELEMENTS));
    const snap = { ...raw, text: "" };
    // The tab remembers where it is, so a state read does not have to ask the
    // page — `browser_tabs` is a read of the session's bookkeeping, not a
    // round trip per tab.
    tab.url = raw.url;
    tab.title = raw.title;
    return { ...snap, text: formatSnapshot(snap) };
  };

  /** Give a triggered navigation or DOM update a moment before reading back. */
  const settle = async (tab: Tab): Promise<void> => {
    await Bun.sleep(SETTLE_MS);
    await tab.page.evaluate("document.readyState").catch(() => {});
  };

  /** A ref's centre in page pixels, or a client error naming the ref. */
  const boxOf = async (tab: Tab, ref: string): Promise<{ x: number; y: number }> => {
    const box = await tab.page.evaluate<{ x: number; y: number } | null>(boxExpression(ref));
    if (!box) {
      throw new BrowserClientError(`${ref} is not on the page — it changed since the snapshot. Take a fresh snapshot first.`);
    }
    return box;
  };

  const state = (sessionID: string): BrowserState => {
    const session = sessions.get(sessionID);
    const targets: BrowserTab[] = [];
    for (const [id, tab] of session?.pages ?? []) {
      targets.push({
        id,
        url: tab.url,
        title: tab.title,
        source: tab.source,
        current: session!.current === id,
      });
    }
    return { chrome: chromeConnection !== undefined ? "running" : "off", targets };
  };

  /**
   * A screenshot loop for one session.
   *
   * CDP has `Page.startScreencast`, but it needs a listener per tab and an
   * ack per frame, and the panel is a glance, not a stream: ~3 fps of JPEG is
   * enough to watch a page fill in and costs one request per frame.
   */
  const casts = new Map<string, ReturnType<typeof setInterval>>();
  const stopCast = (sessionID: string) => {
    const timer = casts.get(sessionID);
    if (timer) clearInterval(timer);
    casts.delete(sessionID);
  };

  /** The size each session's panel asked for, applied to its page. */
  const panelSize = new Map<string, { width: number; height: number }>();

  const shoot = async (sessionID: string) => {
    const session = sessions.get(sessionID);
    if (!session) {
      stopCast(sessionID);
      return;
    }
    const id = session.current;
    const tab = id ? session.pages.get(id) : undefined;
    if (!tab) {
      stopCast(sessionID);
      return;
    }
    try {
      const jpeg = await tab.page.screenshot("jpeg", 55);
      opts.onFrame?.({
        session_id: sessionID,
        tab: id ?? "",
        url: tab.url,
        mime: "image/jpeg",
        data: Buffer.from(jpeg).toString("base64"),
      });
    } catch {
      // A page mid-navigation cannot be screenshotted for a moment; the next
      // frame catches it. Only a dead session stops the loop.
    }
  };

  /** Close this session's own tabs, and let go of the targets it attached to. */
  const closeSession = async (sessionID: string): Promise<number> => {
    const session = sessions.get(sessionID);
    if (!session) return 0;
    let closed = 0;
    for (const [, tab] of session.pages) {
      if (tab.source === "chrome") {
        await tab.page.close().catch(() => {});
        closed += 1;
      }
      consoles.delete(`${sessionID}:${tab.page.targetId}`);
    }
    for (const connection of session.attached) connection.close();
    session.pages.clear();
    sessions.delete(sessionID);
    return closed;
  };

  return {
    state,

    pageOf(sessionID) {
      const session = sessions.get(sessionID);
      const id = session?.current;
      return id ? session?.pages.get(id)?.page : undefined;
    },

    async navigate(sessionID, url) {
      const session = sessionOf(sessionID);
      const tab = session.pages.size > 0 ? currentTab(session) : await newTab(session, sessionID);
      try {
        await tab.page.navigate(url, NAV_TIMEOUT_MS);
      } catch {
        // A server that is slow or never finishes still has a page worth reading.
      }
      await settle(tab);
      return takeSnapshot(tab);
    },

    async attach(sessionID, port) {
      const session = sessionOf(sessionID);
      let connection: CdpConnection;
      try {
        const wsUrl = await waitForDevtools(port, 5_000);
        connection = await CdpConnection.connect(wsUrl);
      } catch (e) {
        throw new BrowserClientError(
          `nothing answered CDP on port ${port} — is the app running with --remote-debugging-port=${port}? (${e instanceof Error ? e.message : String(e)})`,
        );
      }
      session.attached.push(connection);
      connection.on("close", () => {
        for (const [id, tab] of session.pages) {
          if (tab.connection !== connection) continue;
          session.pages.delete(id);
          if (session.current === id) session.current = [...session.pages.keys()][0];
        }
      });
      const targets = await connection.send<{ targetInfos?: { targetId: string; type: string; url: string }[] }>(
        "Target.getTargets",
      );
      let added = 0;
      for (const target of targets.targetInfos ?? []) {
        // DevTools windows and extensions show up as targets too; they are not
        // the app the reader meant to drive.
        if (target.type !== "page") continue;
        if (target.url.startsWith("devtools://") || target.url.startsWith("chrome-extension://")) continue;
        await track(session, connection, target.targetId, "attached", sessionID);
        added += 1;
      }
      if (added === 0) throw new BrowserClientError("the port answered but no page was there — nothing to drive");
      return state(sessionID);
    },

    async snapshot(sessionID) {
      return takeSnapshot(currentTab(sessionOf(sessionID)));
    },

    async act(sessionID, input) {
      const session = sessionOf(sessionID);
      const tab = currentTab(session);
      const ref = browserRef(input.ref);
      if (!ref) throw new BrowserClientError(`bad ref — refs look like e5, got ${JSON.stringify(input.ref)}`);
      // Every action starts by proving the ref is still there: a click that
      // quietly lands on whatever replaced the button is the failure this whole
      // ref scheme exists to prevent.
      const box = await boxOf(tab, ref);
      try {
        switch (input.action) {
          case "click":
            await tab.page.click(box.x, box.y);
            break;
          case "fill": {
            const answer = await tab.page.evaluate<{ ok: boolean; why?: string }>(
              fillExpression(ref, input.text ?? ""),
            );
            if (!answer.ok) throw new BrowserClientError(answer.why ?? "could not fill");
            break;
          }
          case "type": {
            await tab.page.evaluate(focusExpression(ref));
            await tab.page.typeText(input.text ?? "");
            break;
          }
          case "press": {
            await tab.page.evaluate(focusExpression(ref));
            await tab.page.key(input.key ?? "Enter");
            break;
          }
          case "hover": {
            const answer = await tab.page.evaluate<{ ok: boolean; why?: string }>(hoverExpression(ref));
            if (!answer.ok) throw new BrowserClientError(answer.why ?? "could not hover");
            break;
          }
          case "select": {
            const answer = await tab.page.evaluate<{ ok: boolean; why?: string }>(
              selectExpression(ref, input.text ?? ""),
            );
            if (!answer.ok) throw new BrowserClientError(answer.why ?? "could not select");
            break;
          }
        }
      } catch (e) {
        if (e instanceof BrowserClientError) throw e;
        const why = e instanceof Error ? e.message.split("\n")[0]! : String(e);
        throw new BrowserClientError(`${input.action} on ${ref} did not work: ${why}`);
      }
      await settle(tab);
      return takeSnapshot(tab);
    },

    async evaluate(sessionID, js) {
      const tab = currentTab(sessionOf(sessionID));
      // A bare expression is the common case; a statement list is the second.
      // Trying the body form first keeps `1 + 1` from being parsed as a block.
      const result = await tab.page
        .evaluate<unknown>(`(async () => { return (${js}); })()`)
        .catch(() => tab.page.evaluate<unknown>(`(async () => { ${js} })()`));
      const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
      return (text ?? String(result)).slice(0, 4_000);
    },

    consoleLines(sessionID, tail = 100) {
      const session = sessions.get(sessionID);
      if (!session) return [];
      const out: ConsoleLine[] = [];
      for (const tab of session.pages.values()) {
        out.push(...(consoles.get(`${sessionID}:${tab.page.targetId}`) ?? []));
      }
      out.sort((a, b) => a.at - b.at);
      return out.slice(-Math.min(Math.max(tail, 1), MAX_CONSOLE_LINES));
    },

    async screenshot(sessionID) {
      const tab = currentTab(sessionOf(sessionID));
      const png = await tab.page.screenshot("png");
      mkdirSync(shotsDir, { recursive: true });
      const path = join(shotsDir, `shot-${Date.now()}.png`);
      writeFileSync(path, png);
      return { data: Buffer.from(png).toString("base64"), path };
    },

    async use(sessionID, target) {
      const session = sessionOf(sessionID);
      const tab = session.pages.get(target);
      if (!tab) throw new BrowserClientError(`no tab ${target} — browser_tabs lists what this session holds`);
      session.current = target;
      await tab.page.front();
      return state(sessionID);
    },

    close: closeSession,

    async screencast(sessionID, options = {}) {
      const session = sessionOf(sessionID);
      if (session.pages.size === 0) return state(sessionID);
      // The panel says how big it is; the page is laid out at that size so the
      // frame is the page, not a shrunk desktop. Applied before the first
      // frame, so the panel never shows the old shape.
      if (options.width && options.height) {
        panelSize.set(sessionID, { width: options.width, height: options.height });
        const id = session.current;
        const tab = id ? session.pages.get(id) : undefined;
        await tab?.page.setViewport(options.width, options.height).catch(() => {});
      }
      stopCast(sessionID);
      const fps = Math.min(Math.max(options.fps ?? 3, 1), 10);
      const timer = setInterval(() => void shoot(sessionID), Math.round(1000 / fps));
      if (typeof timer === "object" && timer !== null && "unref" in timer) {
        (timer as unknown as { unref(): void }).unref();
      }
      casts.set(sessionID, timer);
      void shoot(sessionID);
      return state(sessionID);
    },

    stopScreencast(sessionID) {
      stopCast(sessionID);
    },

    async releaseSession(sessionID) {
      stopCast(sessionID);
      await closeSession(sessionID);
    },

    async dispose() {
      for (const id of [...casts.keys()]) stopCast(id);
      for (const session of sessions.values()) {
        for (const connection of session.attached) connection.close();
      }
      sessions.clear();
      consoles.clear();
      const connection = chromeConnection;
      chromeConnection = undefined;
      if (connection) {
        const live = await connection.catch(() => undefined);
        live?.close();
      }
      // Only a browser this plugin started is killed; an adopted one is the
      // reader's, and closing it would take their session with it.
      chromeChild?.kill?.();
      chromeChild = undefined;
      // The state file names a window that is about to be gone.
      rmSync(stateFile, { force: true });
    },
  };
}
