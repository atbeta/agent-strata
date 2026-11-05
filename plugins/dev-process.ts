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
 * Where the service is, and the token that says we are allowed to ask.
 *
 * The shell that started the service hands the token on in the environment,
 * and leaves it in the handshake file for a server it did not start. A plugin
 * without one is talking to a service that asks for nothing.
 */
async function serviceTarget() {
  const fromEnv = process.env.STRATA_SERVICE_URL
  if (fromEnv) return { url: fromEnv, token: process.env.STRATA_API_TOKEN || "" }
  resolved ??= probeHandshake()
  const target = await resolved
  if (!target) throw new Error(NO_SERVICE)
  return target
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
    const token = parsed && typeof parsed.token === "string" ? parsed.token : ""
    return { url, token }
  } catch {
    return undefined
  }
}

/** Whether the shell is there right now. Never throws. */
async function available() {
  try {
    await serviceTarget()
    return true
  } catch {
    return false
  }
}

async function call(path, init) {
  const target = await serviceTarget()
  const headers = { "content-type": "application/json", ...init?.headers }
  // The service may want the token the shell gave it. The handshake is the
  // fallback for a server this shell did not start.
  if (target.token) headers["authorization"] = "Bearer " + target.token
  const response = await fetch(new URL(path, target.url), {
    ...init,
    headers,
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
/**
 * What "lost" is leaving behind, in one sentence.
 *
 * The state alone does not say whether the process is still the one that was
 * started, or whether its port is still taken. Both are in the record.
 */
function lostText(process) {
  const detail = process.lost
  const proc =
    detail && detail.process === "reused"
      ? "pid " + (process.pid ?? "?") + " belongs to another process"
      : "process is not running"
  if (!detail || detail.port_held === undefined || process.port === undefined) {
    return "lost (" + proc + "; no port was recorded)"
  }
  if (!detail.port_held) return "lost (" + proc + "; port " + process.port + " is free)"
  const who =
    Array.isArray(detail.port_holders) && detail.port_holders.length > 0
      ? " by pid " + detail.port_holders.join(", ")
      : ""
  return "lost (" + proc + "; port " + process.port + " is still held" + who + ")"
}

function describe(process) {
  const state =
    process.state === "lost"
      ? lostText(process)
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

Pass \`workdir\` when the command belongs in a subdirectory of the session
workspace. Do not \`cd\`, \`Set-Location\`, or \`pushd\` inside the command. The
working directory is \`workdir\`, and a command that changes directory itself
fails when the shell is not already there.

A port that is already served is refused, with the reason. Stop what holds it
first; starting a second command on the same port only produces a failure that
looks like it belongs to the new command.

\`dev_logs\` takes \`offset\`. Pass the \`next_offset\` from the previous read so
only new lines come back. Do not re-read the whole log.

A row marked lost says whether the process is still the one that was started
and whether its port is still held. Read that sentence.

Use \`dev_restart\` to run the same command again under the same id. Do not
\`dev_stop\` and then \`dev_start\`: that mints a new id and throws away the one
already written down.

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
        "with `dev_stop`, or run it again under the same id with `dev_restart`.",
        "",
        "Pass `workdir` for a subdirectory of the session workspace. Do not `cd` or",
        "`Set-Location` inside the command.",
      ].join("\n"),
      args: {
        command: {
          type: "string",
          description: "The command to run, as a shell would take it. Do not cd or Set-Location in it.",
        },
        workdir: {
          type: "string",
          description:
            "Directory to run in, relative to the session workspace. Omit to use the workspace itself. Must stay inside it.",
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
              workdir: args.workdir,
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
        "Pass `offset` from the previous reply's `next_offset` to read only lines written",
        "since then. Omit it the first time. `since` is a timestamp in milliseconds for the",
        "same job when there is no offset.",
        "",
        "A dev server usually needs a moment before it prints anything useful; read again",
        "rather than restarting it.",
      ].join("\n"),
      args: {
        process_id: {
          type: "string",
          description: "The id `dev_start` returned",
        },
        offset: {
          type: "number",
          description: "Return only lines after this cursor. Pass the next_offset from the previous read.",
        },
        since: {
          type: "number",
          description: "Return only lines written after this timestamp, in milliseconds. Prefer offset.",
        },
      },
      async execute(args) {
        const query = new URLSearchParams()
        if (typeof args.offset === "number") query.set("offset", String(args.offset))
        else if (typeof args.since === "number") query.set("since", String(args.since))
        else query.set("tail", "100")
        const suffix = query.toString()
        const queryText = suffix.length > 0 ? "?" + suffix : ""
        const result = await call("/dev/" + encodeURIComponent(args.process_id) + "/logs" + queryText)
        const cursor = "next_offset: " + result.next_offset
        const dropped = result.dropped ? "\nEarlier lines were discarded; this is what is still kept." : ""
        if (result.lines.length === 0) {
          return describe(result.process) + "\n" + cursor + dropped + "\n\n(no new output)"
        }
        const body = result.lines
          .map((line) => (line.marker ? "— " + line.text : (line.stream === "err" ? "! " : "  ") + line.text))
          .join("\n")
        return describe(result.process) + "\n" + cursor + dropped + "\n\n" + body
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

    dev_restart: {
      description: [
        "Stop a process started with `dev_start` and start the same command again, under the same id.",
        "",
        "Use this instead of `dev_stop` followed by `dev_start`. The id stays the one already",
        "written down, and the reply says whether the new process is up.",
      ].join("\n"),
      args: {
        process_id: {
          type: "string",
          description: "The id `dev_start` returned",
        },
      },
      async execute(args) {
        let started
        try {
          started = await call("/dev/" + encodeURIComponent(args.process_id) + "/restart", { method: "POST" })
        } catch (e) {
          return [
            "Did not restart " + args.process_id + ": " + (e && e.message ? e.message : String(e)),
            "",
            "The id is unchanged. If the port is still held, the command was not started again.",
          ].join("\n")
        }
        if (started.error) {
          return "Restarted " + started.id + ", but it failed: " + started.error
        }
        return [
          "Restarted " + started.id + " (pid " + (started.pid ?? "?") + ") in " + started.cwd + ".",
          started.ready === "yes"
            ? "Port " + started.port + " accepts connections" +
              (typeof started.ready_ms === "number" ? " (ready in " + started.ready_ms + "ms)." : ".")
            : started.ready === "no"
              ? "It is running, but no port answered yet. Check `dev_logs`."
              : "It is running.",
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
