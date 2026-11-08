// dev_* as a builtin plugin.
//
// This was `plugins/dev-process.ts`: one file installed into the user's own
// OpenCode config, talking to the service over flat `/dev` routes with the
// shell's global token. It is the plugin system's first real tenant, and the
// move is deliberately behaviour-preserving:
//
// - the manager (`DevManager`) lives here now and is owned by the instance;
// - the tools are declared in the manifest and executed through
//   `POST /plugins/dev/tools/<tool>`, so policy and the ask card happen in
//   the service;
// - the Start-Process guard became `beforeToolCall`, and the guidance became
//   `systemPrompt`. Both still come from this package, and the shim only
//   forwards.
//
// The plugin id is `dev`, which makes the exposed names `dev_start`,
// `dev_logs`, `dev_stop`, `dev_restart`, `dev_list` — exactly what the tools
// were called before. That is not cosmetic: `dev_start` is in the policy
// engine's shell-tool list, so a shell-shaped command routed through it is
// still analysed as a shell command and the reader's existing rules keep
// applying.

import type {
  PluginContext,
  PluginManifest,
  ResourceRequest,
  ResourceResult,
  StrataPlugin,
  ToolCallRequest,
  ToolCallResult,
} from "@agent-strata/plugin-sdk";
import { createDevManager, resolveWorkdir, stopInside, type DevEvent, type DevManager, type DevProcess } from "./dev-process";
import { GUIDANCE, detaches } from "./guidance";

/**
 * The manifest, in code rather than JSON.
 *
 * The tool table is typed here, so a rename cannot leave a stale string in a
 * route; the service still validates it with `loadManifest` like any other, so
 * being in-process buys type checking rather than an exemption.
 */
export const manifest: PluginManifest = {
  id: "dev",
  name: "Long-running commands",
  version: "1.0.0",
  description: "Owns dev servers and watchers a session started, instead of detaching them.",
  entry: { kind: "builtin" },
  provides: ["tools", "resources"],
  permissions: { shell: false },
  hooks: { beforeTool: ["shell"], systemPrompt: true },
  tools: [
    {
      name: "start",
      description: [
        "Start a long-running command (a dev server, a watcher) under the shell's supervision.",
        "",
        "Use this instead of `Start-Process`, `&`, `nohup`, or any other way of detaching a",
        "process. The shell owns it: the output reaches this transcript, the process appears in",
        "the app, and one call stops the whole tree.",
        "",
        "Pass `port` when you know it. The call then returns once that port accepts a",
        "connection, so you do not need to sleep and guess before the first request.",
        "",
        "The command keeps running after this tool returns. Read it with `dev_logs`, end it",
        "with `dev_stop`, or run it again under the same id with `dev_restart`.",
        "",
        "Pass `workdir` for a subdirectory of the session workspace. Do not `cd` or",
        "`Set-Location` inside the command.",
        "",
        "A `$` in the command is expanded by the outer shell before it runs. `$true`",
        "arrives as `True`. Escape a dollar that must survive (a backtick in PowerShell,",
        "a backslash in bash), or avoid it (`while(1)` rather than `while($true)`).",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The command to run, as a shell would take it. Do not cd or Set-Location in it. A $ is expanded by the outer shell before this tool sees it: $true arrives as True. Escape a dollar that must survive (a backtick in PowerShell, a backslash in bash).",
          },
          workdir: {
            type: "string",
            description:
              "Directory to run in, relative to the session workspace. Omit to use the workspace itself. Must stay inside it.",
          },
          port: {
            type: "number",
            description: "The port the command will serve on. When given, this call waits until it answers.",
          },
        },
        required: ["command"],
      },
      // `allow` is the floor, not the answer: a background command is a shell
      // command, so the engine's own analysis and the reader's rules decide,
      // exactly as they did before the move. Declaring `ask` here would make
      // every command prompt even where a rule already allowed it — the floor
      // can only harden an answer nobody gave, never overrule one they did.
      policy: { default: "allow", risk: "exec" },
      guards: { workdir: "workspace" },
      timeout_ms: 120_000,
    },
    {
      name: "logs",
      description: [
        "Read the output of a process started with `dev_start`.",
        "",
        "Pass `offset` from the previous reply's `next_offset` to read only lines written",
        "since then. Omit it the first time. `since` is a timestamp in milliseconds for the",
        "same job when there is no offset.",
        "",
        "A dev server usually needs a moment before it prints anything useful; read again",
        "rather than restarting it.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          process_id: { type: "string", description: "The id `dev_start` returned" },
          offset: {
            type: "number",
            description: "Return only lines after this cursor. Pass the next_offset from the previous read.",
          },
          since: {
            type: "number",
            description: "Return only lines written after this timestamp, in milliseconds. Prefer offset.",
          },
        },
        required: ["process_id"],
      },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "stop",
      description: [
        "Stop a process started with `dev_start`, and everything it started.",
        "",
        "The whole tree goes: a dev server's own children do not survive it.",
      ].join("\n"),
      input: {
        type: "object",
        properties: { process_id: { type: "string", description: "The id `dev_start` returned" } },
        required: ["process_id"],
      },
      policy: { default: "allow" },
    },
    {
      name: "restart",
      description: [
        "Stop a process started with `dev_start` and start the same command again, under the same id.",
        "",
        "Use this instead of `dev_stop` followed by `dev_start`. The id stays the one already",
        "written down, and the reply says whether the new process is up.",
      ].join("\n"),
      input: {
        type: "object",
        properties: { process_id: { type: "string", description: "The id `dev_start` returned" } },
        required: ["process_id"],
      },
      policy: { default: "allow" },
    },
    {
      name: "list",
      description: [
        "List the commands this session left running.",
        "",
        "Check this before starting a dev server: one already listening on the port will make",
        "the next one fail with a confusing error.",
      ].join("\n"),
      input: { type: "object", properties: {} },
      policy: { default: "allow", risk: "read" },
    },
  ],
  resources: [
    { key: "processes", mime: "application/json", description: "Every command this session left running." },
  ],
};

const TOOLS = new Set(["start", "logs", "stop", "restart", "list"]);

/** One line a person can read, without pretending a stopped process is running. */
function stateText(process: DevProcess): string {
  if (process.state === "lost") {
    const detail = process.lost;
    const proc =
      detail && detail.process === "reused"
        ? `pid ${process.pid ?? "?"} belongs to another process`
        : "process is not running";
    if (!detail || detail.port_held === undefined || process.port === undefined) {
      return `lost (${proc}; no port was recorded)`;
    }
    if (!detail.port_held) return `lost (${proc}; port ${process.port} is free)`;
    const who =
      Array.isArray(detail.port_holders) && detail.port_holders.length > 0
        ? ` by pid ${detail.port_holders.join(", ")}`
        : "";
    return `lost (${proc}; port ${process.port} is still held${who})`;
  }
  if (process.state === "orphaned") return "orphaned";
  if (process.exit_code === null) return `running (pid ${process.pid ?? "?"})`;
  return process.stopped ? "stopped" : `exited ${process.exit_code}`;
}

function describe(process: DevProcess): string {
  const tail = process.last_line ? ` — ${process.last_line.slice(0, 120)}` : "";
  return `${process.id} [${stateText(process)}] ${process.command}${tail}`;
}

function readiness(info: DevProcess): string {
  if (info.ready === "yes") {
    const ms = typeof info.ready_ms === "number" ? ` (ready in ${info.ready_ms}ms).` : ".";
    return `Port ${info.port} accepts connections${ms}`;
  }
  if (info.ready === "no") return "It is running, but no port answered yet. Check `dev_logs`.";
  return "It is running.";
}

export interface DevPluginOptions {
  /** Where the live process table is written; the service data directory. */
  pidFile?: string;
  /** Where to read a session's workspace from. */
  workspaceOf: (sessionId: string) => string | undefined;
}

export function createDevPlugin(options: DevPluginOptions): StrataPlugin {
  let dev: DevManager | undefined;
  /** Installed by initialize; the panel's routes translate session ids through it. */
  let resolveSession: (given: string) => string = (given) => given;

  /** The manager, once initialize has run. A call before that is a bug, not a race. */
  const manager = (): DevManager => {
    if (!dev) throw new Error("the dev plugin was called before it initialized");
    return dev;
  };

  const workspace = (sessionId: string): string => {
    const dir = options.workspaceOf(sessionId);
    if (!dir) throw new Error("this session has no workspace, so there is nowhere to run a command");
    return dir;
  };

  /** Read one command the session owns. Another session's id is not a lookup failure to leak. */
  const owned = (sessionId: string, id: unknown): DevProcess => {
    if (typeof id !== "string" || id.length === 0) throw new Error("process_id is required");
    const info = manager().get(id);
    if (!info) throw new Error(`there is no process called ${id}`);
    if (info.session_id !== sessionId) {
      // Not "found but forbidden": that would confirm an id belonging to
      // somebody else. From this session's point of view it does not exist.
      throw new Error(`there is no process called ${id}`);
    }
    return info;
  };

  return {
    async initialize(context: PluginContext) {
      resolveSession = (given) => context.resolveSession(given);
      dev = createDevManager({ pidFile: options.pidFile });
      dev.subscribe((event: DevEvent) => {
        // The UI already listens for `dev.*` on /stream. Forwarding keeps that
        // contract while the manager lives behind a plugin boundary.
        context.emit({ type: "stream", data: event });
      });
      const reaped = await dev.reapStale();
      if (reaped > 0) context.logger.info(`stopped ${reaped} dev process(es) left by a previous run`);
    },

    listTools() {
      return manifest.tools.map((t) => ({ name: t.name, description: t.description, input: t.input }));
    },

    async callTool(req: ToolCallRequest): Promise<ToolCallResult> {
      if (!TOOLS.has(req.tool)) return { output: `unknown tool ${req.tool}`, isError: true };
      try {
        return { output: await call(req) };
      } catch (e) {
        return { output: e instanceof Error ? e.message : String(e), isError: true };
      }
    },

    /**
     * The UI's side of the same table.
     *
     * These are private endpoints, not service routes: the background panel
     * reads and stops commands through them, and adding another one (a new
     * action on a row) costs a branch here rather than a route in the service.
     * The tool surface and this surface are deliberately separate — a model
     * gets `dev_logs`, a panel gets a JSON page of lines.
     */
    async route(req: Request, subpath: string): Promise<Response | undefined> {
      const url = new URL(req.url);
      const json = (data: unknown, status = 200) => Response.json(data, { status });
      const sessionOf = (): string | undefined => {
        const requested = url.searchParams.get("session");
        return requested === null ? undefined : resolveSession(requested);
      };
      const one = /^\/processes\/([A-Za-z0-9_]+)(?:\/(logs|stop|restart))?$/.exec(subpath);

      if (subpath === "/processes" && req.method === "GET") {
        const sessionId = sessionOf();
        return json({ processes: manager().list(sessionId) });
      }
      if (!one) return undefined;
      const id = one[1]!;
      const action = one[2];
      const info = manager().get(id);
      if (!info) return json({ error: "not found" }, 404);
      // A panel is looking at one session's rows. Showing another session's by
      // id would let a click stop somebody else's server.
      const scoped = sessionOf();
      if (scoped !== undefined && info.session_id !== scoped) return json({ error: "not found" }, 404);

      if (!action && req.method === "GET") return json(info);
      if (!action && req.method === "DELETE") {
        try {
          return json({ removed: manager().forget(id) });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      if (action === "logs" && req.method === "GET") {
        const numberParam = (name: string) => {
          const raw = url.searchParams.get(name);
          if (raw === null || raw.length === 0) return undefined;
          const value = Number(raw);
          return Number.isFinite(value) ? value : undefined;
        };
        const tail = numberParam("tail");
        const page = manager().readLogs(id, {
          tail: tail === undefined ? undefined : Math.min(Math.max(Math.floor(tail), 1), 5000),
          since: numberParam("since"),
          offset: numberParam("offset"),
        });
        return json({ process: info, ...page });
      }
      if (action === "restart" && req.method === "POST") {
        try {
          const started = await manager().restart(id);
          return json(started, started.error ? 502 : 200);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      }
      if (action === "stop" && req.method === "POST") {
        // The answer says what is left, not just that a stop was asked for: a
        // stop that leaves the port held has to be reported as the failure it
        // is, or the next command collides with it and nobody knows why.
        const result = await manager().stop(id);
        return json({ ...result, ok: result.stopped && result.clean });
      }
      return json({ error: "method not allowed" }, 405);
    },

    async readResource(req: ResourceRequest): Promise<ResourceResult> {
      if (req.key !== "processes") throw new Error(`no resource ${req.key}`);
      return {
        mime: "application/json",
        body: JSON.stringify({ processes: manager().list(req.sessionId) }),
      };
    },

    async beforeToolCall(req) {
      if (req.tool !== "shell") return { allow: true };
      const command = req.input.command ?? req.input.cmd;
      if (typeof command !== "string" || !detaches(command)) return { allow: true };
      return { allow: false, message: DETACH_REFUSAL };
    },

    async systemPrompt() {
      return GUIDANCE;
    },

    async sessionEnded(sessionId) {
      await dev?.stopSession(sessionId);
    },

    async releaseDirectory(dir) {
      // A dev server standing in a folder that has to go is why the app's own
      // programs are stopped before a checkout is removed.
      if (dev) await stopInside(dev, dir);
    },

    async shutdown() {
      await dev?.stopAll();
      dev = undefined;
    },
  };

  async function call(req: ToolCallRequest): Promise<string> {
    const tool = req.tool;
    const sessionId = req.sessionId;
    const input = req.input;
    const signal = req.signal;

    if (tool === "start") {
      const command = typeof input.command === "string" ? input.command : "";
      const cwd = resolveWorkdir(workspace(sessionId), typeof input.workdir === "string" ? input.workdir : undefined);
      const port = typeof input.port === "number" ? input.port : undefined;
      if (signal.aborted) throw new Error("cancelled");
      // Starting a server and waiting for its port is the slowest thing this
      // plugin does, and the wait is the part a reader stares at. Saying what
      // it is waiting for is the difference between "working" and "stuck".
      req.progress?.({
        message: port === undefined ? "starting" : `waiting for port ${port}`,
        ...(port === undefined ? {} : { percent: 20 }),
      });
      const started = await manager().start({ session_id: sessionId, command, cwd, port });
      if (started.error) {
        return [
          `The command did not start: ${started.error}`,
          "",
          "Read the message above before retrying — a missing binary, a wrong",
          "directory and a port that is already served are different problems.",
        ].join("\n");
      }
      return [
        `Started ${started.id} (pid ${started.pid ?? "?"}) in ${started.cwd}.`,
        readiness(started),
        "",
        "Use `dev_logs` to read it and `dev_stop` to end it.",
      ].join("\n");
    }

    if (tool === "logs") {
      const info = owned(sessionId, input.process_id);
      const offset = typeof input.offset === "number" ? input.offset : undefined;
      const since = typeof input.since === "number" ? input.since : undefined;
      const page = manager().readLogs(info.id, {
        ...(offset !== undefined ? { offset } : since !== undefined ? { since } : { tail: 100 }),
      });
      const cursor = `next_offset: ${page.next_offset}`;
      const dropped = page.dropped ? "\nEarlier lines were discarded; this is what is still kept." : "";
      if (page.lines.length === 0) return `${describe(info)}\n${cursor}${dropped}\n\n(no new output)`;
      const body = page.lines
        .map((line) => (line.marker ? `— ${line.text}` : `${line.stream === "err" ? "!" : " "} ${line.text}`))
        .join("\n");
      return `${describe(info)}\n${cursor}${dropped}\n\n${body}`;
    }

    if (tool === "stop") {
      const info = owned(sessionId, input.process_id);
      const result = await manager().stop(info.id);
      if (result.clean) return `Stopped ${info.id}.`;
      const leftovers: string[] = [];
      if (Array.isArray(result.residual) && result.residual.length > 0) {
        leftovers.push(`still running: ${result.residual.join(", ")}`);
      }
      if (result.port !== undefined && result.port_free === false) {
        leftovers.push(`port ${result.port} is still held`);
      }
      return [
        `Stopped ${info.id}, but not cleanly.`,
        leftovers.length > 0 ? `${leftovers.join("; ")}.` : "The command itself is gone.",
        "",
        "Something of it survived and may still hold its port. Find it by hand",
        "before starting it again, or the next start collides with it.",
      ].join("\n");
    }

    if (tool === "restart") {
      const info = owned(sessionId, input.process_id);
      const started = await manager().restart(info.id);
      if (started.error) return `Restarted ${started.id}, but it failed: ${started.error}`;
      return [
        `Restarted ${started.id} (pid ${started.pid ?? "?"}) in ${started.cwd}.`,
        readiness(started),
      ].join("\n");
    }

    if (tool === "list") {
      const all = manager().list(sessionId);
      if (all.length === 0) return "No background processes for this session.";
      return all.map(describe).join("\n");
    }

    throw new Error(`unknown tool ${tool}`);
  }
}

/**
 * What the model is told when it reaches for a detached process.
 *
 * The window is only the visible half of what is wrong with `Start-Process`:
 * the process outlives everything that could stop it, and its output goes
 * nowhere. Naming the alternative is what makes the refusal useful.
 */
const DETACH_REFUSAL = [
  "Do not detach a process from the shell.",
  "",
  "`Start-Process`, `nohup`, and `start /b` leave a command that nothing owns: its output",
  "never reaches the transcript, it holds its port after the app closes, and nobody can",
  "stop it without hunting for its pid. Hiding the window does not fix any of that.",
  "",
  "Use the `dev_start` tool instead. It runs the command under the shell's supervision,",
  "keeps the output readable with `dev_logs`, and can stop the whole tree with `dev_stop`.",
].join("\n");

export default createDevPlugin;
