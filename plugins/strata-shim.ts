// The service's plugin shim for OpenCode.
//
// One file, installed into every OpenCode on the machine. It knows nothing
// about any capability: it asks the service what tools exist and registers
// them, forwards calls, and stands aside when there is no service. Adding a
// capability never comes back here — that is the whole point of the plugin
// system, and this file is where the discipline is easiest to break.
//
// Five properties are deliberate, each from a failure the previous version had:
//
// 1. No imports. This runs inside the user's own OpenCode config, where
//    `@opencode-ai/plugin` and `zod` are not resolvable. A plugin that fails
//    to import fails to load, and a plugin that fails to load looks exactly
//    like "the model ignores the tool".
//
// 2. One export. OpenCode treats every export as a plugin, so a second named
//    export would register everything twice.
//
// 3. Inert without the shell. This runs in every OpenCode the user starts,
//    including ones that never heard of this app. No service means no tools
//    and no hooks — never a tool that fails on use, and never a guard that
//    blocks work with nothing to offer in its place.
//
// 4. A file, plus the environment. The shell names this file through
//    `OPENCODE_CONFIG_CONTENT` for a server it started, and leaves a
//    handshake beside the file for a server it did not.
//
// 5. No session at load time. The tool table is registered once, without a
//    session; `context.sessionID` arrives with each execute and is what the
//    call forwards. A table that varied by session could not be registered
//    here at all.

const TOOLS_PATH = "/plugins/tools"
const HANDSHAKE = "strata-service.json"

/** Said when the shell is not running, so a model knows what is missing. */
const NO_SERVICE =
  "The desktop shell is not running, so there is no service behind the " +
  "strata tools. Start the app, or use the tools this OpenCode already has."

let resolved

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
  return resolved
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
    // `<config>/plugin/strata-shim.ts` → `<config>/strata-service.json`.
    const here = fileURLToPath(import.meta.url)
    const file = join(dirname(join(here, "..")), HANDSHAKE)
    const raw = await readFile(file, "utf8")
    const parsed = JSON.parse(raw)
    const url = parsed && typeof parsed.url === "string" ? parsed.url : ""
    if (!url) return undefined
    // A crash leaves the file behind. Only a service that answers is one this
    // plugin can hand work to.
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
    const target = await serviceTarget()
    return target !== undefined
  } catch {
    return false
  }
}

async function call(path, init) {
  const target = await serviceTarget()
  if (!target) throw new Error(NO_SERVICE)
  const headers = { "content-type": "application/json", ...init?.headers }
  // The service may want the token the shell gave it. The handshake is the
  // fallback for a server this shell did not start.
  if (target.token) headers["authorization"] = "Bearer " + target.token
  const response = await fetch(new URL(path, target.url), { ...init, headers })
  const text = await response.text()
  let body
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    throw new Error("service answered " + response.status + ": " + text.slice(0, 200))
  }
  if (!response.ok) {
    const detail =
      body && typeof body === "object" && "error" in body ? String(body.error) : "service answered " + response.status
    throw new Error(detail)
  }
  return body
}

/**
 * The tool table, once per plugin load.
 *
 * A failure here is not fatal: OpenCode starts on machines with no shell, and
 * a shim that throws would take the user's other plugins with it.
 */
async function toolTable() {
  try {
    const table = await call(TOOLS_PATH)
    return Array.isArray(table?.tools) ? table.tools : []
  } catch {
    return []
  }
}

/**
 * One OpenCode tool from one table row.
 *
 * The description carries a line naming the plugin: a model looking at
 * `browser_navigate` should be able to tell it is not a builtin, because the
 * permission card for it names the plugin too.
 */
function opencodeTool(tool) {
  return {
    description: tool.description + "\n\n(Provided by the \"" + tool.plugin_id + "\" plugin.)",
    args: tool.input && typeof tool.input === "object" ? tool.input : { type: "object", properties: {} },
    async execute(args, context) {
      const body = {
        session_id: context.sessionID,
        input: args && typeof args === "object" ? args : {},
      }
      // A backend that names its call id can be joined to the CASF row; one
      // that cannot is left for the host to match up. `id` is the field a
      // stable OpenCode sets on a tool's context; `callID` is the name in the
      // shim's own history and in some forks, so both are read.
      const callID =
        typeof context.id === "string" && context.id.length > 0
          ? context.id
          : typeof context.callID === "string" && context.callID.length > 0
            ? context.callID
            : undefined
      if (callID) body.call_id = callID
      let result
      try {
        result = await call(
          "/plugins/" + encodeURIComponent(tool.plugin_id) + "/tools/" + encodeURIComponent(tool.tool),
          { method: "POST", body: JSON.stringify(body), signal: context.abort },
        )
      } catch (e) {
        // A cancellation is not a tool failure the model should retry; say so
        // plainly and let the turn end.
        if (context.abort && context.abort.aborted) return "Cancelled."
        return "The " + tool.plugin_id + " plugin's " + tool.tool + " did not run: " + (e && e.message ? e.message : String(e))
      }
      if (result && result.is_error) {
        return typeof result.output === "string" && result.output.length > 0
          ? result.output
          : "The " + tool.plugin_id + " plugin's " + tool.tool + " failed."
      }
      const output = result && typeof result.output === "string" ? result.output : ""
      const attachments = Array.isArray(result?.attachments) ? result.attachments : []
      if (attachments.length === 0) return output
      // OpenCode takes an output string or a file part; a screenshot that
      // cannot be handed over as a part still has to reach the reader, so the
      // refusal is stated rather than silently dropping the picture.
      return {
        output,
        attachments: attachments.map((a) => ({
          type: "file",
          mime: a.mime,
          url: "data:" + a.mime + ";base64," + a.data,
        })),
      }
    },
  }
}

export default async () => {
  const tools = await toolTable()

  const registered = {}
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || typeof tool.plugin_id !== "string") continue
    if (typeof tool.tool !== "string") continue
    registered[tool.name] = opencodeTool(tool)
  }

  return {
    tool: registered,

    /**
     * The plugin's veto, asked before the call runs.
     *
     * Only when the shell is there: a guard with no alternative would block
     * work the reader asked for. A service that cannot answer fails open for
     * the same reason.
     */
    "tool.execute.before": async (input, output) => {
      if (!(await available())) return
      let verdict
      try {
        verdict = await call("/hooks/before-tool", {
          method: "POST",
          body: JSON.stringify({
            session_id: input.sessionID,
            tool: input.tool,
            input: output.args && typeof output.args === "object" ? output.args : {},
          }),
        })
      } catch {
        // The service went away between the check and the call. Let the call
        // itself report that, rather than turning it into a confusing refusal.
        return
      }
      if (verdict && verdict.allow === false) throw new Error(verdict.message || "refused by a plugin")
    },

    /**
     * The contributed system prompt, appended.
     *
     * Read fresh each turn: a plugin enabled in the app after this OpenCode
     * started contributes from the next message, even though its *tools* are
     * only registered on the next OpenCode launch.
     */
    "experimental.chat.system.transform": async (input, output) => {
      if (!(await available())) return
      let contributed
      try {
        const answer = await call("/hooks/system-prompt?session=" + encodeURIComponent(input.sessionID ?? ""))
        contributed = answer && typeof answer.text === "string" ? answer.text : ""
      } catch {
        return
      }
      if (!contributed) return
      // One copy per prompt: a transform that runs twice in one request must
      // not double the guidance.
      const marker = contributed.split("\n", 1)[0] || contributed.slice(0, 40)
      if (output.system.some((entry) => entry.includes(marker))) return
      output.system.push(contributed)
    },
  }
}
