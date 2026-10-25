// Hands long-running commands to the shell's service.
//
// The agent has no way to start something that outlives a turn: the shell tool
// takes a timeout and kills the process tree when it expires. So a dev server
// gets started some other way, and the way a model knows is `Start-Process`,
// which detaches the child from anything that could stop it later. A hidden
// window is not the problem — `-WindowStyle Hidden` handles that — the problem is
// a process nothing owns.
//
// Four properties are deliberate, and each one exists because of a failure this
// plugin already had:
//
// 1. No imports. This file is installed into the user's own OpenCode config,
//    where `@opencode-ai/plugin` and `zod` are not resolvable. An import that
//    cannot resolve is a plugin that silently fails to load, and a plugin that
//    fails to load looks exactly like "the model ignores the tool".
//    Arguments are plain JSON Schema, which OpenCode accepts.
//
// 2. One export. OpenCode treats every export as a plugin, so a second named
//    export would register the tools twice.
//
// 3. Inert without the shell. This file runs inside every OpenCode the user
//    starts, including ones that have never heard of this app. When the service
//    is not there, the tools report that plainly and the Start-Process guard
//    stays out of the way — a guard with no alternative would only block work.
//
// 4. The again-here case. A server the shell did not start cannot be given an
//    environment variable, so it finds the service through a small handshake
//    file the shell writes next to this one and removes when it exits. A file
//    left behind by a crash is checked against `/health` before it is trusted.

/** Said when the shell is not running, so a model knows what is missing. */
const NO_SERVICE =
  "The desktop shell is not running, so there is no service to own this process. " +
  "Start the app, or run the command in the foreground."

let resolved = undefined

/**
 * Where the service is: the environment the shell sets on a server it starts,
 * or the handshake file it leaves for one it did not.
 */
async function serviceURL() {
  const fromEnv = process.env.STRATA_SERVICE_URL
  if (fromEnv) return fromEnv
  resolved ??= probeHandshake()
  const url = await resolved
  if (!url) throw new Error(NO_SERVICE)
  return url
}

/** The handshake file, if a live service is actually behind it. */
async function probeHandshake() {
  try {
    const [{ readFile }, { dirname, join }, { fileURLToPath }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:url"),
    ])
    // Resolved from this file, not from a guessed platform path: the handshake
    // sits beside the plugin that reads it, wherever the installer put them.
    // `<config>/plugin/dev-process.ts` → `<config>/strata-dev-process.json`.
    const here = fileURLToPath(import.meta.url)
    const file = join(dirname(dirname(here)), "strata-dev-process.json")
    const raw = await readFile(file, "utf8")
    const parsed = JSON.parse(raw)
    const url = parsed && typeof parsed.url === "string" ? parsed.url : ""
    if (!url) return undefined
    // A crash leaves the file behind. Only a service that answers is one this
    // plugin can hand a process to.
    const res = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(700) })
    if (!res.ok) return undefined
    return url
  } catch {
    return undefined
  }
}

/** Whether the shell is there right now. Never throws. */
async function available() {
  try {
    await serviceURL()
    return true
  } catch {
    return false
  }
}

async function call(path, init) {
  const response = await fetch(new URL(path, await serviceURL()), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let body
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    throw new Error("service answered " + response.status + ": " + text.slice(0, 200))
  }
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String(body.error)
        : "service answered " + response.status
    throw new Error(detail)
  }
  return body
}

/**
 * One line a person can read, without pretending a stopped process is running.
 *
 * The states are the four the table can be in, not two. A command that
 * vanished on its own is not the same as one that was stopped, and one that
 * was found running after a restart — an orphan, cleaned up — is neither.
 */
function describe(process) {
  const state =
    process.state === "lost"
      ? "lost"
      : process.state === "orphaned"
        ? "orphaned"
        : process.exit_code === null
          ? "running (pid " + (process.pid ?? "?") + ")"
          : process.stopped
            ? "stopped"
            : "exited " + process.exit_code
  const tail = process.last_line ? " — " + process.last_line.slice(0, 120) : ""
  return process.id + " [" + state + "] " + process.command + tail
}

/**
 * What the model is told before it reads the request.
 *
 * A tool description says what a tool does; it does not stop the model doing
 * what it already does. The habit here is `Start-Process`, and a habit loses
 * only to an instruction that names it.
 */
const GUIDANCE = `

## Long-running commands

A development server, a watcher, or anything else meant to keep running must be
started with the \`dev_start\` tool.

Do not use \`Start-Process\` (PowerShell), \`&\` (bash), \`nohup\`, \`start /b\`, or a
background job to start one. Hiding the window does not make the process owned:
its output never reaches the transcript, it holds its port after the app closes,
and stopping it means finding its pid by hand.

Pass \`port\` when you know it — \`dev_start\` then returns once the port answers,
so there is no need to sleep and guess.

A port that is already served is refused, with the reason. Stop what holds it
first; starting a second command on the same port only produces a failure that
looks like it belongs to the new command.

If \`dev_start\` reports that the shell is not running, say so and ask — do not
fall back to \`Start-Process\`.
`

/** Whether a command is an attempt to detach a process. */
function detaches(command) {
  return /\bStart-Process\b/i.test(command) || /\bnohup\b/i.test(command) || /\bstart\s+\/b\b/i.test(command)
}

export default async () => ({
  tool: {
    dev_start: {
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
        "with `dev_stop`.",
      ].join("\n"),
      args: {
        command: {
          type: "string",
          description: "The command to run, as a shell would take it",
        },
        port: {
          type: "number",
          description:
            "The port the command will serve on. When given, this call waits until it answers.",
        },
      },
      async execute(args, context) {
        let started
        try {
          started = await call("/dev", {
            method: "POST",
            body: JSON.stringify({
              session_id: context.sessionID,
              command: args.command,
              cwd: context.directory,
              port: args.port,
            }),
          })
        } catch (e) {
          // The service refused, and the reason is the whole answer: a port
          // that is already served, a command that could not start, a
          // directory that is not there. It is passed on rather than
          // swallowed, because the next thing to do depends on which of them
          // it is.
          return [
            "The command did not start: " + (e && e.message ? e.message : String(e)),
            "",
            "Read the message above before retrying — a missing binary, a wrong",
            "directory and a port that is already served are different problems.",
          ].join("\n")
        }
        if (started.error) {
          return [
            "The command did not start: " + started.error,
            "",
            "Read the message above before retrying — a missing binary and a wrong directory",
            "are different problems.",
          ].join("\n")
        }
        return [
          "Started " + started.id + " (pid " + (started.pid ?? "?") + ") in " + started.cwd + ".",
          started.ready === "yes"
            ? "Port " + started.port + " accepts connections" +
              (typeof started.ready_ms === "number" ? " (ready in " + started.ready_ms + "ms)." : ".")
            : started.ready === "no"
              ? "It is running, but no port answered yet. Check `dev_logs`."
              : "It is running.",
          "",
          "Use `dev_logs` to read it and `dev_stop` to end it.",
        ].join("\n")
      },
    },

    dev_logs: {
      description: [
        "Read the output of a process started with `dev_start`.",
        "",
        "A dev server usually needs a moment before it prints anything useful; read again",
        "rather than restarting it.",
      ].join("\n"),
      args: {
        process_id: {
          type: "string",
          description: "The id `dev_start` returned",
        },
      },
      async execute(args) {
        const result = await call("/dev/" + encodeURIComponent(args.process_id) + "/logs?tail=100")
        if (result.lines.length === 0) {
          return describe(result.process) + "\n\n(no output yet)"
        }
        const body = result.lines.map((line) => (line.stream === "err" ? "! " : "  ") + line.text).join("\n")
        return describe(result.process) + "\n\n" + body
      },
    },

    dev_stop: {
      description: [
        "Stop a process started with `dev_start`, and everything it started.",
        "",
        "The whole tree goes: a dev server's own children do not survive it.",
      ].join("\n"),
      args: {
        process_id: {
          type: "string",
          description: "The id `dev_start` returned",
        },
      },
      async execute(args) {
        let result
        try {
          result = await call("/dev/" + encodeURIComponent(args.process_id) + "/stop", { method: "POST" })
        } catch (e) {
          // Nothing to stop under that name. Saying so is more useful than
          // letting the failure look like a stop that did not work.
          return "There is no process called " + args.process_id + ": " +
            (e && e.message ? e.message : String(e))
        }
        if (result.clean) return "Stopped " + args.process_id + "."
        // A stop that could not prove the port is free is reported as what it
        // is. "Stopped" on its own would be a lie the next command pays for.
        const leftovers = []
        if (Array.isArray(result.residual) && result.residual.length > 0) {
          leftovers.push("still running: " + result.residual.join(", "))
        }
        if (result.port && result.port_free === false) {
          leftovers.push("port " + result.port + " is still held")
        }
        return [
          "Stopped " + args.process_id + ", but not cleanly.",
          leftovers.length > 0 ? leftovers.join("; ") + "." : "The command itself is gone.",
          "",
          "Something of it survived and may still hold its port. Find it by hand",
          "before starting it again, or the next start collides with it.",
        ].join("\n")
      },
    },

    dev_list: {
      description: [
        "List the commands this session left running.",
        "",
        "Check this before starting a dev server: one already listening on the port will make",
        "the next one fail with a confusing error.",
      ].join("\n"),
      args: {},
      async execute(_args, context) {
        const result = await call("/dev?session=" + encodeURIComponent(context.sessionID))
        if (result.processes.length === 0) return "No background processes for this session."
        return result.processes.map(describe).join("\n")
      },
    },
  },

  // The habit, caught where it starts. A `Start-Process` that survives becomes a
  // process nobody owns, so this refuses it rather than quietly adding a flag:
  // the window is only the visible half of what is wrong with it.
  //
  // Only while the shell is there. Blocking the habit with nothing to offer in
  // its place would stop work the reader asked for.
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "shell") return
    const command = output.args?.command
    if (typeof command !== "string" || !detaches(command)) return
    if (!(await available())) return
    throw new Error(
      [
        "Do not detach a process from the shell.",
        "",
        "`Start-Process`, `nohup`, and `start /b` leave a command that nothing owns: its output",
        "never reaches the transcript, it holds its port after the app closes, and nobody can",
        "stop it without hunting for its pid. Hiding the window does not fix any of that.",
        "",
        "Use the `dev_start` tool instead. It runs the command under the shell's supervision,",
        "keeps the output readable with `dev_logs`, and can stop the whole tree with `dev_stop`.",
      ].join("\n"),
    )
  },

  // The instruction half. A tool the model does not know it should prefer loses
  // to a habit it already has.
  "experimental.chat.system.transform": async (_input, output) => {
    if (!(await available())) return
    if (output.system.some((entry) => entry.includes("## Long-running commands"))) return
    output.system.push(GUIDANCE)
  },
})
