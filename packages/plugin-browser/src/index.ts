// browser_* as the first real capability plugin.
//
// The manager (`manager.ts`) is the historical service-side implementation,
// moved behind the plugin interface. What did not move is the interesting
// part: no `browser_*` route exists in the service, no `browser` branch in the
// UI build, and nothing in the shim knows what a tab is. This package declares
// its tools in a manifest and answers them.
//
// The panel is the one place with an interaction shape of its own: frames go
// out on the plugin's event stream, input comes back through a private route.
// Both are namespaced by the host, and neither touches CASF — a screencast is
// not a transcript.

import type {
  PluginContext,
  PluginManifest,
  ResourceResult,
  StrataPlugin,
  ToolCallRequest,
  ToolCallResult,
} from "@agent-strata/plugin-sdk";
import {
  BrowserClientError,
  browserRef,
  browserUrl,
  createBrowserManager,
  type BrowserManager,
  type BrowserSnapshot,
  type BrowserState,
} from "./manager";

export const manifest: PluginManifest = {
  id: "browser",
  name: "Browser",
  version: "1.0.0",
  description: "A Chrome the sessions share: navigate, read, click, screenshot.",
  entry: { kind: "builtin" },
  provides: ["tools", "resources", "panel"],
  permissions: { browser: true, net: ["*"], fs: [], shell: false },
  hooks: { beforeTool: [], systemPrompt: false },
  tools: [
    {
      name: "navigate",
      description:
        "Open a URL in this session's browser tab (opening one if needed) and return what is on the page.\n\n" +
        "The answer lists the interactive elements with short refs (`e5`). Pass a ref to\n" +
        "browser_click/browser_fill/browser_type/browser_press/browser_hover/browser_select.\n" +
        "A ref is only valid until the page changes; every action answers with a fresh list.",
      input: {
        type: "object",
        properties: { url: { type: "string", description: "http(s) URL, or host:port" } },
        required: ["url"],
      },
      // `allow` is the floor, not the answer. Opening a page is how the
      // browser is used at all, and a session on "stop asking me" has to stop
      // asking for it — a floor of `ask` survives that stance by design, and a
      // prompt on every navigation is the reason someone turns the stance on.
      // What still stands: the `net` guard (scheme, credentials, allowlist) and
      // whatever the policy document says, including its default of `ask` when
      // there is no document at all.
      policy: { default: "allow", risk: "network" },
      guards: { url: "net" },
      timeout_ms: 45_000,
    },
    {
      name: "attach",
      description:
        "Attach to a browser another program is already running, over its CDP port.\n\n" +
        "Use it for an Electron app started with --remote-debugging-port, or a Chrome\n" +
        "started by hand. The windows become tabs in this session. The app is never\n" +
        "closed by this plugin: attaching borrows the pages, it does not own them.",
      input: {
        type: "object",
        properties: { port: { type: "number", description: "The remote debugging port" } },
        required: ["port"],
      },
      policy: { default: "ask", risk: "exec" },
    },
    {
      name: "snapshot",
      description: "Re-read the current page and list its interactive elements with fresh refs.",
      input: { type: "object", properties: {} },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "click",
      description: "Click the element with this ref. Answers with a fresh snapshot.",
      input: {
        type: "object",
        properties: {
          ref: { type: "string", description: "A ref from the latest snapshot, like e5" },
          action: { type: "string", description: "Kept for the historical single-tool shape; omit." },
          text: { type: "string", description: "Unused for click." },
        },
        required: ["ref"],
      },
      policy: { default: "allow" },
    },
    {
      name: "fill",
      description:
        "Replace the value of an input with this text, in one go. Use browser_type when the page\n" +
        "reacts to keystrokes (a search box that clears on each key, a masked field).",
      input: {
        type: "object",
        properties: {
          ref: { type: "string", description: "A ref from the latest snapshot" },
          text: { type: "string", description: "The value to set" },
        },
        required: ["ref", "text"],
      },
      policy: { default: "allow" },
    },
    {
      name: "type",
      description: "Type this text into the element one key at a time, as a person would.",
      input: {
        type: "object",
        properties: {
          ref: { type: "string", description: "A ref from the latest snapshot" },
          text: { type: "string", description: "The text to type" },
        },
        required: ["ref", "text"],
      },
      policy: { default: "allow" },
    },
    {
      name: "press",
      description: "Press a key (Enter, Tab, Escape, ArrowDown…) in the element with this ref.",
      input: {
        type: "object",
        properties: {
          ref: { type: "string", description: "A ref from the latest snapshot" },
          key: { type: "string", description: "A key name, like Enter" },
        },
        required: ["ref", "key"],
      },
      policy: { default: "allow" },
    },
    {
      name: "hover",
      description: "Move the pointer over the element with this ref.",
      input: {
        type: "object",
        properties: { ref: { type: "string", description: "A ref from the latest snapshot" } },
        required: ["ref"],
      },
      policy: { default: "allow" },
    },
    {
      name: "select",
      description: "Choose the option with this label in the <select> with this ref.",
      input: {
        type: "object",
        properties: {
          ref: { type: "string", description: "A ref from the latest snapshot" },
          text: { type: "string", description: "The option's label" },
        },
        required: ["ref", "text"],
      },
      policy: { default: "allow" },
    },
    {
      name: "eval",
      description:
        "Evaluate JavaScript in the page and return the result.\n\n" +
        "This runs with the page's own privileges, so it can read cookies and call\n" +
        "same-origin endpoints. Prefer snapshot and the ref actions when they can do it.",
      input: {
        type: "object",
        properties: { source: { type: "string", description: "JavaScript to evaluate" } },
        required: ["source"],
      },
      policy: { default: "ask", risk: "exec" },
    },
    {
      name: "console",
      description: "Read the page's console output, page errors and failed requests.",
      input: {
        type: "object",
        properties: { tail: { type: "number", description: "How many recent lines (default 100)" } },
      },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "screenshot",
      description:
        "Take a PNG of the current page. It is attached to the result, so a reader sees it in the transcript.",
      input: { type: "object", properties: {} },
      policy: { default: "allow" },
      timeout_ms: 30_000,
    },
    {
      name: "tabs",
      description: "List this session's tabs. Every tab in the list is one this session may drive.",
      input: { type: "object", properties: {} },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "use",
      description:
        "Make one of this session's tabs the current one. Only tabs this session holds can be chosen.",
      input: {
        type: "object",
        properties: { tab: { type: "string", description: "A tab id from browser_tabs" } },
        required: ["tab"],
      },
      policy: { default: "allow" },
    },
    {
      name: "close",
      description:
        "Close this session's tabs and let go of any target it attached to. Attached windows stay open.",
      input: { type: "object", properties: {} },
      policy: { default: "allow" },
    },
  ],
  resources: [
    { key: "screenshot", mime: "image/png", description: "The current page, as a picture." },
    { key: "console", mime: "application/json", description: "Console, page errors, failed requests." },
    { key: "tabs", mime: "application/json", description: "This session's tabs." },
  ],
  panel: { id: "browser", title: "Browser", kind: "screencast", icon: "globe" },
  ui: {
    toolRenderers: {
      navigate: { kind: "web", icon: "globe" },
      attach: { kind: "web", icon: "globe" },
      snapshot: { kind: "web", icon: "globe" },
      click: { kind: "web", icon: "globe" },
      fill: { kind: "web", icon: "globe" },
      type: { kind: "web", icon: "globe" },
      press: { kind: "web", icon: "globe" },
      hover: { kind: "web", icon: "globe" },
      select: { kind: "web", icon: "globe" },
      eval: { kind: "terminal", icon: "code" },
      console: { kind: "read", icon: "list" },
      screenshot: { kind: "read", icon: "image" },
      tabs: { kind: "read", icon: "list" },
      use: { kind: "read", icon: "globe" },
      close: { kind: "read", icon: "globe" },
    },
  },
};

const ACTION_TOOLS = new Set(["click", "fill", "type", "press", "hover", "select"]);

export interface BrowserPluginOptions {
  /** Where the profile, screenshots and the adoption file live. */
  dataDir: string;
}

export function createBrowserPlugin(options: BrowserPluginOptions): StrataPlugin {
  let manager: BrowserManager | undefined;
  let emit: ((event: { type: string; data?: unknown }) => void) | undefined;
  /** Installed by initialize: panel routes name sessions the way tools do. */
  let resolveSession: (given: string) => string = (given) => given;

  const m = (): BrowserManager => {
    if (!manager) throw new Error("the browser plugin was called before it initialized");
    return manager;
  };

  const snapshotText = (snap: BrowserSnapshot): string => snap.text;

  return {
    async initialize(ctx: PluginContext) {
      emit = (event) => ctx.emit(event);
      resolveSession = (given) => ctx.resolveSession(given);
      manager = createBrowserManager({
        stateDir: options.dataDir,
        onFrame: (frame) => {
          // Frames are the panel's whole data plane. They are events, not tool
          // results: nothing about watching a page belongs in a transcript.
          emit?.({ type: "frame", data: frame });
        },
      });
    },

    listTools() {
      return manifest.tools.map((t) => ({ name: t.name, description: t.description, input: t.input }));
    },

    async callTool(req: ToolCallRequest): Promise<ToolCallResult> {
      try {
        return await run(req);
      } catch (e) {
        if (e instanceof BrowserClientError) return { output: e.message, isError: true };
        return { output: e instanceof Error ? e.message : String(e), isError: true };
      }
    },

    async readResource(req): Promise<ResourceResult> {
      if (req.key === "tabs") {
        return { mime: "application/json", body: JSON.stringify(m().state(req.sessionId)) };
      }
      if (req.key === "console") {
        const lines = m().consoleLines(req.sessionId, 200);
        return { mime: "application/json", body: JSON.stringify({ lines }) };
      }
      if (req.key === "screenshot") {
        const shot = await m().screenshot(req.sessionId);
        return { mime: "image/png", body: Uint8Array.from(Buffer.from(shot.data, "base64")) };
      }
      throw new Error(`no resource ${req.key}`);
    },

    /**
     * The panel's input path.
     *
     * `/plugins/browser/panel/input` receives one pointer, wheel or key event
     * per frame the reader produces. Coordinates are fractions of the frame,
     * not pixels: the panel is displayed at whatever size the rail is, and a
     * click has to land on the same element in the page.
     */
    async route(req: Request, subpath: string): Promise<Response | undefined> {
      if (subpath === "/panel/state" && req.method === "GET") {
        const requested = new URL(req.url).searchParams.get("session");
        if (!requested) return Response.json({ error: "session required" }, { status: 400 });
        const state = m().state(resolveSession(requested));
        return Response.json(state);
      }
      if (subpath === "/panel/cast" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          session?: unknown;
          fps?: unknown;
          width?: unknown;
          height?: unknown;
          scale?: unknown;
        } | null;
        if (typeof body?.session !== "string") return Response.json({ error: "session required" }, { status: 400 });
        const session = resolveSession(body.session);
        const fps = typeof body.fps === "number" ? body.fps : undefined;
        // The panel's pixel size, clamped: a page laid out at 40px wide is a
        // page whose own CSS has given up, and a huge one costs a bigger
        // screenshot per frame for nothing.
        const clamp = (v: unknown) =>
          typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 320), 1920) : undefined;
        const width = clamp(body.width);
        const height = clamp(body.height);
        // The panel's `devicePixelRatio`, kept to the two factors a display
        // actually uses: more is memory for no visible gain.
        const scale =
          typeof body.scale === "number" && Number.isFinite(body.scale)
            ? Math.min(Math.max(body.scale, 1), 2)
            : undefined;
        const state = await m().screencast(session, {
          ...(fps === undefined ? {} : { fps }),
          ...(width === undefined || height === undefined ? {} : { width, height }),
          ...(scale === undefined ? {} : { scale }),
        });
        return Response.json(state);
      }
      if (subpath === "/panel/stop" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as { session?: unknown } | null;
        if (typeof body?.session === "string") m().stopScreencast(resolveSession(body.session));
        return Response.json({ ok: true });
      }
      if (subpath === "/panel/input" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          session?: unknown;
          kind?: unknown;
          x?: unknown;
          y?: unknown;
          key?: unknown;
          text?: unknown;
          delta?: unknown;
          /** alt 1, ctrl 2, meta 4, shift 8 — the protocol's own bitmask. */
          modifiers?: unknown;
          /** "left" | "right" | "middle", for the mouse kinds. */
          button?: unknown;
          /** A move that belongs to a drag, so the page sees a button held. */
          dragging?: unknown;
        } | null;
        if (typeof body?.session !== "string") return Response.json({ error: "session required" }, { status: 400 });
        const page = m().pageOf(resolveSession(body.session));
        if (!page) return Response.json({ error: "no page" }, { status: 404 });
        const fx = typeof body.x === "number" ? Math.min(Math.max(body.x, 0), 1) : 0.5;
        const fy = typeof body.y === "number" ? Math.min(Math.max(body.y, 0), 1) : 0.5;
        const size = await page.viewport();
        const x = Math.round(fx * size.width);
        const y = Math.round(fy * size.height);
        const button: "left" | "right" | "middle" =
          body.button === "right" || body.button === "middle" ? body.button : "left";
        const modifiers =
          typeof body.modifiers === "number" && Number.isFinite(body.modifiers)
            ? body.modifiers & 0b1111
            : 0;
        try {
          if (body.kind === "click") await page.click(x, y, button);
          // A drag is down, moves, up — three messages rather than one, because
          // the page decides what a gesture means as it happens.
          else if (body.kind === "down") await page.mouseDown(x, y, button);
          else if (body.kind === "up") await page.mouseUp(x, y, button);
          else if (body.kind === "move") await page.move(x, y, body.dragging === true ? 1 : 0);
          else if (body.kind === "wheel") await page.wheel(x, y, typeof body.delta === "number" ? body.delta : 200);
          else if (body.kind === "key" && typeof body.key === "string") {
            await page.key(body.key, modifiers);
          } else if (body.kind === "text" && typeof body.text === "string") {
            // One call for the whole insert: an IME hands over composed text at
            // once, and per-character insertion would break the composition.
            await page.insertText(body.text);
          } else return Response.json({ error: `unknown input ${String(body.kind)}` }, { status: 400 });
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
        }
        // The reader typed into a page the agent is also driving; the next
        // frame shows it, so no answer payload is needed.
        return Response.json({ ok: true });
      }
      return undefined;
    },

    async sessionEnded(sessionId) {
      m().stopScreencast(sessionId);
      await m().releaseSession(sessionId);
    },

    async shutdown() {
      await manager?.dispose();
      manager = undefined;
      emit = undefined;
    },
  };

  async function run(req: ToolCallRequest): Promise<ToolCallResult> {
    const sessionId = req.sessionId;
    const input = req.input;
    const signal = req.signal;
    const tool = req.tool;
    if (signal.aborted) throw new BrowserClientError("cancelled");

    if (tool === "navigate") {
      const url = browserUrl(input.url);
      if (!url) throw new BrowserClientError(`not a URL an agent may open: ${JSON.stringify(input.url)}`);
      req.progress?.({ message: `navigating to ${url}` });
      const snap = await m().navigate(sessionId, url);
      // The page is up; the snapshot is next. Saying so is what makes a slow
      // site readable as "still loading" rather than "stuck".
      req.progress?.({ message: "reading the page", percent: 70 });
      return { output: snapshotText(snap) };
    }

    if (tool === "attach") {
      const port = typeof input.port === "number" ? input.port : Number.NaN;
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new BrowserClientError("port must be an integer between 1 and 65535");
      }
      const state = await m().attach(sessionId, port);
      return { output: describeState(state) };
    }

    if (tool === "snapshot") {
      return { output: snapshotText(await m().snapshot(sessionId)) };
    }

    if (ACTION_TOOLS.has(tool)) {
      // A click that triggers a request can take a moment; the row says which
      // element is being acted on before the page changes underneath it.
      req.progress?.({ message: `${tool} ${String(input.ref ?? "")}`, percent: 40 });
      const ref = browserRef(input.ref);
      if (!ref) throw new BrowserClientError(`bad ref — refs look like e5, got ${JSON.stringify(input.ref)}`);
      const action = tool as "click" | "fill" | "type" | "press" | "hover" | "select";
      const text = typeof input.text === "string" ? input.text : undefined;
      const key = typeof input.key === "string" ? input.key : undefined;
      const snap = await m().act(sessionId, { ref, action, ...(text === undefined ? {} : { text }), ...(key === undefined ? {} : { key }) });
      return { output: snapshotText(snap) };
    }

    if (tool === "eval") {
      const source = typeof input.source === "string" ? input.source : "";
      if (source.trim().length === 0) throw new BrowserClientError("source is required");
      return { output: await m().evaluate(sessionId, source) };
    }

    if (tool === "console") {
      const tail = typeof input.tail === "number" ? input.tail : 100;
      const lines = m().consoleLines(sessionId, tail);
      if (lines.length === 0) return { output: "Nothing on the console for this session." };
      const text = lines
        .map((line) => `${line.kind === "console" ? " " : "!"} ${line.text}`)
        .join("\n");
      return { output: text };
    }

    if (tool === "screenshot") {
      req.progress?.({ message: "capturing", percent: 30 });
      const shot = await m().screenshot(sessionId);
      const state = m().state(sessionId);
      return {
        output: `Screenshot of ${state.targets.find((t) => t.current)?.url ?? "the current page"}.`,
        attachments: [{ type: "image", mime: "image/png", data: shot.data }],
      };
    }

    if (tool === "tabs") return { output: describeState(m().state(sessionId)) };

    if (tool === "use") {
      if (typeof input.tab !== "string") throw new BrowserClientError("tab is required");
      return { output: describeState(await m().use(sessionId, input.tab)) };
    }

    if (tool === "close") {
      const closed = await m().close(sessionId);
      m().stopScreencast(sessionId);
      return { output: `Closed ${closed} tab(s). Attached windows were left open.` };
    }

    throw new BrowserClientError(`the browser plugin has no tool "${tool}"`);
  }
}

/** Tabs, as a model reads them. */
function describeState(state: BrowserState): string {
  if (state.targets.length === 0) {
    return "No tabs in this session. Use browser_navigate to open one, or browser_attach to an app's debug port.";
  }
  const rows = state.targets.map(
    (tab) => `${tab.current ? "*" : " "} ${tab.id} [${tab.source}] ${tab.url}`,
  );
  return [`Chrome: ${state.chrome}`, ...rows].join("\n");
}
