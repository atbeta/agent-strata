// Hands long-running commands to the shell's service.
//
// The agent has no way to start something that outlives a turn: the shell tool
// takes a timeout and kills the process tree when it expires. So a dev server
// gets started some other way, and the way a model knows is `Start-Process`,
// which opens a console window per child on Windows and detaches it from
// anything that could stop it later.
//
// This plugin gives it the missing tool. `dev_start` asks the service to own
// the process: no window, output captured, one handle that stops the tree.
// `dev_logs` and `dev_stop` are the rest of the contract, and `dev_list`
// answers "what is already running here" so a second session does not start a
// second server on the same port.
//
// It is a file plugin under `.opencode/plugin/`, which OpenCode loads on its
// own — no install step, no global config, and removing the file removes the
// capability.

import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

/**
 * Where the service is. Read at call time, not at module load: the host sets
 * it on the process it starts, and a plugin module can be imported before that
 * environment is in place.
 */
function serviceURL(): string {
  const url = process.env.STRATA_SERVICE_URL
  if (!url) {
    throw new Error(
      "STRATA_SERVICE_URL is not set: this plugin only works inside the Agent Strata desktop shell.",
    )
  }
  return url
}

type DevProcess = {
  id: string
  session_id: string
  command: string
  cwd: string
  pid?: number
  started_at: number
  exit_code: number | null
  stopped: boolean
  error?: string
  last_line?: string
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, serviceURL()), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let body: unknown
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    throw new Error(`service answered ${response.status}: ${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `service answered ${response.status}`
    throw new Error(detail)
  }
  return body as T
}

/** One line a person can read, without pretending a stopped process is running. */
function describe(process: DevProcess): string {
  const state =
    process.exit_code === null
      ? `running (pid ${process.pid ?? "?"})`
      : process.stopped
        ? "stopped"
        : `exited ${process.exit_code}`
  const tail = process.last_line ? ` — ${process.last_line.slice(0, 120)}` : ""
  return `${process.id} [${state}] ${process.command}${tail}`
}

export const DevProcessPlugin = async () => {
  return {
    tool: {
      dev_start: tool({
        description: [
          "Start a long-running command (a dev server, a watcher) under the shell's supervision.",
          "",
          "Use this instead of `Start-Process`, `&`, `nohup`, or any other way of detaching a",
          "process. The shell owns the process: it opens no window, it captures the output,",
          "and it can stop the whole tree again. A command started any other way is one nothing",
          "can stop, and on Windows it is one that puts a console window on the desktop.",
          "",
          "The command keeps running after this tool returns. Read it with `dev_logs`,",
          "end it with `dev_stop`.",
        ].join("\n"),
        args: {
          command: z.string().describe("The command to run, as a shell would take it"),
          cwd: z
            .string()
            .optional()
            .describe("Directory to run in. Defaults to the session's workspace."),
        },
        async execute(args, context) {
          const started = await call<DevProcess>("/dev", {
            method: "POST",
            body: JSON.stringify({
              session_id: context.sessionID,
              command: args.command,
              cwd: args.cwd,
            }),
          })
          if (started.error) {
            return [
              `The command did not start: ${started.error}`,
              "",
              "Read the message above before retrying — a missing binary and a wrong directory",
              "are different problems.",
            ].join("\n")
          }
          return [
            `Started ${started.id} (pid ${started.pid ?? "?"}) in ${started.cwd}.`,
            "",
            "It keeps running. Use `dev_logs` to read it and `dev_stop` to end it.",
          ].join("\n")
        },
      }),

      dev_logs: tool({
        description: [
          "Read the output of a process started with `dev_start`.",
          "",
          "A dev server usually needs a moment before it prints anything useful; read again",
          "rather than restarting it.",
        ].join("\n"),
        args: {
          process_id: z.string().describe("The id `dev_start` returned"),
          tail: z.number().int().min(1).max(5000).optional().describe("How many lines back to read (default 100)"),
        },
        async execute(args) {
          const tail = args.tail ?? 100
          const result = await call<{ process: DevProcess; lines: { at: number; stream: string; text: string }[] }>(
            `/dev/${encodeURIComponent(args.process_id)}/logs?tail=${tail}`,
          )
          if (result.lines.length === 0) {
            return `${describe(result.process)}\n\n(no output yet)`
          }
          const body = result.lines.map((line) => `${line.stream === "err" ? "!" : " "} ${line.text}`).join("\n")
          return `${describe(result.process)}\n\n${body}`
        },
      }),

      dev_stop: tool({
        description: [
          "Stop a process started with `dev_start`, and everything it started.",
          "",
          "The whole tree goes: a dev server's own children do not survive it.",
        ].join("\n"),
        args: {
          process_id: z.string().describe("The id `dev_start` returned"),
        },
        async execute(args) {
          await call<{ ok: boolean }>(`/dev/${encodeURIComponent(args.process_id)}/stop`, { method: "POST" })
          return `Stopped ${args.process_id}.`
        },
      }),

      dev_list: tool({
        description: [
          "List the processes this session started.",
          "",
          "Check this before starting a dev server: one already listening on the port will make",
          "the next one fail with a confusing error.",
        ].join("\n"),
        args: {},
        async execute(_args, context) {
          const result = await call<{ processes: DevProcess[] }>(
            `/dev?session=${encodeURIComponent(context.sessionID)}`,
          )
          if (result.processes.length === 0) return "No processes running for this session."
          return result.processes.map(describe).join("\n")
        },
      }),
    },

    // The one place the popup actually comes from. A model that reaches for
    // `Start-Process` out of habit is steered back to the tool above, and a
    // `Start-Process` that survives the rewrite is at least told not to open a
    // window.
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "shell") return
      const command = output.args?.command
      if (typeof command !== "string") return
      if (!/Start-Process/i.test(command)) return
      if (!/-NoNewWindow/i.test(command)) {
        output.args.command = command.replace(/Start-Process\s+/i, "Start-Process -NoNewWindow ")
      }
    },
  }
}
