import type {
  PluginContext,
  PluginManifest,
  PluginSocket,
  ResourceRequest,
  ResourceResult,
  StrataPlugin,
  ToolCallRequest,
  ToolCallResult,
} from "@agent-strata/plugin-sdk";
import { PtyManager } from "./manager";
import { terminalText } from "./output";
import { listShells, shellArgv, shellByName, terminalSize, terminalTitle } from "./shells";
import type { PtyInfo, PtyReadPage } from "./types";
import { pathInside, resolveWorkdir } from "./workspace";

export const manifest: PluginManifest = {
  id: "terminal",
  name: "Interactive terminals",
  version: "1.0.0",
  description: "Persistent interactive PTYs shared by the agent and the user panel.",
  entry: { kind: "builtin" },
  provides: ["tools", "resources", "panel"],
  permissions: { shell: true },
  tools: [
    {
      name: "create",
      description: [
        "Create an interactive pseudo-terminal only when the program needs terminal input,",
        "such as a REPL, SSH, or an interactive prompt. For a one-shot non-interactive",
        "command, use the regular shell. For a dev server or watcher, use `dev_start`.",
        "The terminal survives panel and socket disconnects until terminal_close or session cleanup.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          command: { type: "string", description: "Interactive command to run. Omit for the default shell." },
          workdir: { type: "string", description: "Directory relative to the session workspace." },
          title: { type: "string" },
          rows: { type: "number" },
          cols: { type: "number" },
        },
      },
      policy: { default: "allow", risk: "exec" },
      guards: { workdir: "workspace" },
      timeout_ms: 30_000,
    },
    {
      name: "write",
      description: "Write text or control keys to an interactive terminal. Use terminal_read afterwards for new output.",
      input: {
        type: "object",
        properties: {
          terminal_id: { type: "string" },
          data: { type: "string", description: "Raw terminal input; include a newline to submit a command." },
        },
        required: ["terminal_id", "data"],
      },
      policy: { default: "allow", risk: "exec" },
      timeout_ms: 30_000,
    },
    {
      name: "read",
      description: [
        "Read terminal output after a byte offset, with ANSI display controls removed.",
        "For a process_id created by `dev_start`, use `dev_logs` instead.",
        "Pass next_offset from the previous read. When no new output is available,",
        "wait_ms waits for more and quiet_ms settles a burst. output_idle only means",
        "no PTY output arrived in that window; it is not a command-completion signal.",
        "An interactive shell has no portable command boundary. For a long command,",
        "increase wait_ms; for process exit, inspect terminal.status and exit_code.",
        "The result is a linear text stream, not a screen snapshot. Use non-interactive",
        "batch modes for TUI programs and an explicit echo of $? when an exit code is",
        "needed. Separate sections with printable markers, not the clear command.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          terminal_id: { type: "string" },
          offset: { type: "number", description: "Pass next_offset from the previous read." },
          max_bytes: { type: "number" },
          wait_ms: { type: "number", description: "Maximum wait for new output; default 1000, maximum 30000." },
          quiet_ms: { type: "number", description: "Quiet window after new output; default 200." },
        },
        required: ["terminal_id"],
      },
      policy: { default: "allow", risk: "read" },
      timeout_ms: 45_000,
    },
    {
      name: "list",
      description: "List interactive terminals owned by this session.",
      input: { type: "object", properties: {} },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "close",
      description: "Close a terminal and terminate its process tree.",
      input: {
        type: "object",
        properties: { terminal_id: { type: "string" } },
        required: ["terminal_id"],
      },
      policy: { default: "allow" },
      timeout_ms: 30_000,
    },
  ],
  resources: [{ key: "terminals", mime: "application/json", scope: "session" }],
  panel: { id: "terminal", title: "Terminal", kind: "component", icon: "terminal", resource: "terminals" },
  ui: {
    toolRenderers: {
      create: { kind: "terminal", icon: "terminal" },
      write: { kind: "terminal", icon: "terminal" },
      read: { kind: "terminal", icon: "terminal" },
      list: { kind: "terminal", icon: "terminal" },
      close: { kind: "terminal", icon: "terminal" },
    },
  },
};

const TOOLS = new Set(["create", "write", "read", "list", "close"]);

export interface TerminalPluginOptions {
  workspaceOf(sessionId: string): string | undefined;
  manager?: PtyManager;
}

export function createTerminalPlugin(options: TerminalPluginOptions): StrataPlugin {
  let terminals: PtyManager | undefined;
  let contextResolver: (given: string) => string = (given) => given;

  const manager = (): PtyManager => {
    if (!terminals) throw new Error("the terminal plugin was called before it initialized");
    return terminals;
  };

  const workspace = (sessionId: string): string => {
    const directory = options.workspaceOf(sessionId);
    if (!directory) throw new Error("this session has no workspace, so there is nowhere to open a terminal");
    return directory;
  };

  const create = (
    sessionId: string,
    input: { command?: string; workdir?: string; shell?: unknown; title?: unknown; rows?: unknown; cols?: unknown },
    origin: "agent" | "user",
  ): PtyInfo => {
    const shells = listShells();
    const shell = shellByName(shells, input.shell);
    if (!shell) throw new Error("unknown shell");
    const cwd = resolveWorkdir(workspace(sessionId), input.workdir);
    const command = typeof input.command === "string" && input.command.trim() ? input.command : undefined;
    const size = terminalSize(input.rows ?? 24, input.cols ?? 80);
    return manager().create({
      sessionId,
      title: terminalTitle(input.title) ?? command?.slice(0, 40) ?? shell.name,
      argv: shellArgv(shell, command, process.platform, { profile: origin === "user" }),
      command: command ?? shell.path,
      cwd,
      ...size,
      ...(origin === "agent" ? { env: { ENV: "" } } : {}),
    });
  };

  return {
    async initialize(context: PluginContext) {
      contextResolver = context.resolveSession;
      terminals = options.manager ?? new PtyManager();
      terminals.onChange((info) => {
        context.emit({
          type: "terminal.changed",
          data: { session_id: info.session_id, terminal_id: info.id, status: info.status },
        });
      });
    },

    listTools() {
      return manifest.tools.map((tool) => ({ name: tool.name, description: tool.description, input: tool.input }));
    },

    async callTool(req: ToolCallRequest): Promise<ToolCallResult> {
      if (!TOOLS.has(req.tool)) return { output: `unknown tool ${req.tool}`, isError: true };
      try {
        if (req.tool === "create") {
          const info = create(req.sessionId, {
            command: typeof req.input.command === "string" ? req.input.command : undefined,
            workdir: typeof req.input.workdir === "string" ? req.input.workdir : undefined,
            title: req.input.title,
            rows: req.input.rows,
            cols: req.input.cols,
          }, "agent");
          return { output: JSON.stringify({ terminal: info, next_offset: manager().read(req.sessionId, info.id).next_offset }) };
        }
        if (req.tool === "list") return { output: JSON.stringify({ terminals: manager().list(req.sessionId) }) };
        const id = typeof req.input.terminal_id === "string" ? req.input.terminal_id : "";
        if (!id) throw new Error("terminal_id is required");
        manager().get(req.sessionId, id);
        if (req.tool === "write") {
          if (typeof req.input.data !== "string") throw new Error("data must be a string");
          if (req.input.data.length > 64 * 1024) throw new Error("terminal input is too large");
          const written = manager().write(req.sessionId, id, req.input.data);
          return { output: `Wrote ${written} bytes to ${id}.` };
        }
        if (req.tool === "read") {
          const offset = optionalInteger(req.input.offset, "offset");
          const maxBytes = optionalInteger(req.input.max_bytes, "max_bytes") ?? 16 * 1024;
          const waitMs = Math.min(optionalInteger(req.input.wait_ms, "wait_ms") ?? 1000, 30_000);
          const quietMs = Math.min(optionalInteger(req.input.quiet_ms, "quiet_ms") ?? 200, waitMs);
          const page = await readWithWait(
            manager(),
            req.sessionId,
            id,
            offset,
            Math.min(Math.max(maxBytes, 1), 64 * 1024),
            waitMs,
            quietMs,
            req.signal,
          );
          return {
            output: JSON.stringify({
              terminal: manager().get(req.sessionId, id),
              output: terminalText(page.data),
              next_offset: page.next_offset,
              dropped: page.dropped,
              new_output: page.new_output,
              output_idle: page.output_idle,
              timed_out: page.timed_out,
            }),
          };
        }
        if (req.tool === "close") {
          await manager().close(req.sessionId, id);
          return { output: `Closed ${id}.` };
        }
        throw new Error(`unknown tool ${req.tool}`);
      } catch (error) {
        return { output: error instanceof Error ? error.message : String(error), isError: true };
      }
    },

    async route(req: Request, subpath: string): Promise<Response | undefined> {
      const url = new URL(req.url);
      const requested = url.searchParams.get("session");
      if (!requested) return Response.json({ error: "session required" }, { status: 400 });
      let sessionId: string;
      try {
        sessionId = resolveSession(requested);
      } catch {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const one = /^\/terminals\/([\w.-]+)(?:\/size)?$/.exec(subpath);
      try {
        if (subpath === "/terminals" && req.method === "GET") {
          return Response.json({ sessions: manager().list(sessionId), shells: listShells() });
        }
        if (subpath === "/terminals" && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { shell?: unknown; title?: unknown };
          return Response.json(create(sessionId, { shell: body.shell, title: body.title }, "user"));
        }
        if (!one) return undefined;
        const id = one[1]!;
        if (subpath === `/terminals/${id}` && req.method === "DELETE") {
          await manager().close(sessionId, id);
          return Response.json({ ok: true });
        }
        if (subpath === `/terminals/${id}/size` && req.method === "POST") {
          const body = (await req.json().catch(() => ({}))) as { rows?: unknown; cols?: unknown };
          const size = terminalSize(body.rows, body.cols);
          manager().resize(sessionId, id, size.rows, size.cols);
          return Response.json({ ok: true });
        }
        return Response.json({ error: "method not allowed" }, { status: 405 });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
    },

    async upgrade(req: Request, subpath: string) {
      const hit = /^\/terminals\/([\w.-]+)\/connect$/.exec(subpath);
      if (!hit) return undefined;
      const requested = new URL(req.url).searchParams.get("session");
      if (!requested) return Response.json({ error: "session required" }, { status: 400 });
      let sessionId: string;
      try {
        sessionId = resolveSession(requested);
      } catch {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const id = hit[1]!;
      try {
        manager().get(sessionId, id);
      } catch {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      let unsubscribe: (() => void) | undefined;
      return {
        handlers: {
          open(ws: PluginSocket) {
            const attached = manager().attach(sessionId, id, (event) => {
              if (event.type === "data") ws.send(event.data);
              else ws.close();
            });
            unsubscribe = attached.unsubscribe;
            if (attached.replay.byteLength > 0) ws.send(attached.replay);
            if (attached.info.status === "exited") ws.close();
          },
          message(_ws: PluginSocket, message: string | Uint8Array) {
            manager().write(sessionId, id, message);
          },
          close() {
            unsubscribe?.();
          },
        },
      };
    },

    async readResource(req: ResourceRequest): Promise<ResourceResult> {
      if (req.key !== "terminals" || !req.sessionId) throw new Error("no such resource");
      return {
        mime: "application/json",
        body: JSON.stringify({ sessions: manager().list(req.sessionId) }),
      };
    },

    async sessionEnded(sessionId) {
      await terminals?.closeSession(sessionId);
    },

    async releaseDirectory(directory) {
      await terminals?.closeInside(directory, pathInside);
    },

    async shutdown() {
      await terminals?.closeAll();
      terminals = undefined;
    },
  };

  function resolveSession(given: string): string {
    return contextResolver(given);
  }
}

interface ReadResult extends PtyReadPage {
  new_output: boolean;
  output_idle: boolean;
  timed_out: boolean;
}

async function readWithWait(
  manager: PtyManager,
  sessionId: string,
  id: string,
  offset: number | undefined,
  maxBytes: number,
  waitMs: number,
  quietMs: number,
  signal: AbortSignal,
): Promise<ReadResult> {
  const info = manager.get(sessionId, id);
  const immediate = manager.read(sessionId, id, offset, maxBytes);
  if (offset === undefined || waitMs === 0 || info.status === "exited") {
    return {
      ...immediate,
      new_output: immediate.data.byteLength > 0,
      output_idle: immediate.data.byteLength === 0 || info.status === "exited",
      timed_out: false,
    };
  }

  return new Promise<ReadResult>((resolve) => {
    let finished = false;
    let sawData = false;
    let lastDataAt = 0;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};

    const finish = (timedOut: boolean) => {
      if (finished) return;
      finished = true;
      if (deadline) clearTimeout(deadline);
      if (quiet) clearTimeout(quiet);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      const page = manager.read(sessionId, id, offset, maxBytes);
      resolve({
        ...page,
        new_output: page.data.byteLength > 0,
        output_idle: !sawData || info.status === "exited" || Date.now() - lastDataAt >= quietMs,
        timed_out: timedOut,
      });
    };
    const onAbort = () => finish(false);
    const armQuiet = () => {
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => finish(false), quietMs);
    };
    const attached = manager.attach(sessionId, id, (event) => {
      if (event.type === "exit") {
        finish(false);
        return;
      }
      sawData = true;
      lastDataAt = Date.now();
      armQuiet();
    });
    unsubscribe = attached.unsubscribe;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      finish(false);
      return;
    }
    const afterAttach = manager.read(sessionId, id, offset, maxBytes);
    if (afterAttach.data.byteLength > 0) {
      sawData = true;
      lastDataAt = Date.now();
      armQuiet();
    }
    if (attached.info.status === "exited") {
      finish(false);
      return;
    }
    deadline = setTimeout(() => finish(true), waitMs);
  });
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return numeric;
}

export { PtyManager } from "./manager";
export { OutputRing, terminalText } from "./output";
export { listShells, shellArgv, shellByName, terminalSize, terminalTitle } from "./shells";
export type { PtyEvent, PtyInfo, PtyProcess, PtyReadPage, PtyShell, PtySpawnInput } from "./types";
export { pathInside, resolveWorkdir } from "./workspace";
export default createTerminalPlugin;
