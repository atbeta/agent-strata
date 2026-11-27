// The service's plugin shim for OpenCode 2.
//
// OpenCode 2 loads a plugin only when the default export is an object with an
// id and a setup function. The v1 shim is a function, and this server rejects
// that one file on its own; this file is the shape it accepts. The shell
// writes it only while the selected API is v2, and removes it for v1, because
// the two files share one config directory.
//
// Same five rules as the v1 shim: no imports, one export, inert without a
// service, the handshake file beside the config, and no session at load time.

const TOOLS_PATH = "/plugins/tools"
const HANDSHAKE = "strata-service.json"
const INSTRUCTION_KEY = "strata"

const NO_SERVICE =
  "The desktop shell is not running, so there is no service behind the " +
  "strata tools. Start the app, or use the tools this OpenCode already has."

let resolved
const contributed = new Map()

async function serviceTarget() {
  const fromEnv = process.env.STRATA_SERVICE_URL
  if (fromEnv) return { url: fromEnv, token: process.env.STRATA_API_TOKEN || "" }
  resolved ??= probeHandshake()
  return resolved
}

async function probeHandshake() {
  try {
    const [{ readFile }, { dirname, join }, { fileURLToPath }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:url"),
    ])
    // `<config>/plugin/strata-shim-v2.ts` → `<config>/strata-service.json`.
    const here = fileURLToPath(import.meta.url)
    const file = join(dirname(join(here, "..")), HANDSHAKE)
    const raw = await readFile(file, "utf8")
    const parsed = JSON.parse(raw)
    const url = parsed && typeof parsed.url === "string" ? parsed.url : ""
    if (!url) return undefined
    const res = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(700) })
    if (!res.ok) return undefined
    const token = parsed && typeof parsed.token === "string" ? parsed.token : ""
    return { url, token }
  } catch {
    return undefined
  }
}

async function available() {
  try {
    return (await serviceTarget()) !== undefined
  } catch {
    return false
  }
}

async function call(path, init) {
  const target = await serviceTarget()
  if (!target) throw new Error(NO_SERVICE)
  const headers = { "content-type": "application/json", ...init?.headers }
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

async function toolTable() {
  try {
    const table = await call(TOOLS_PATH)
    return Array.isArray(table?.tools) ? table.tools : []
  } catch {
    return []
  }
}

function sessionOf(value) {
  if (!value || typeof value !== "object") return ""
  if (typeof value.sessionID === "string") return value.sessionID
  if (typeof value.sessionId === "string") return value.sessionId
  if (value.session && typeof value.session.id === "string") return value.session.id
  return ""
}

function signalOf(context) {
  if (!context || typeof context !== "object") return undefined
  if (context.abort && typeof context.abort === "object") return context.abort
  if (context.signal && typeof context.signal === "object") return context.signal
  return undefined
}

/**
 * One tool the editor can add.
 *
 * `execute` is `(args, context)`. The call id is `context.id`; the abort
 * signal is `context.signal` (some builds still say `abort`).
 */
function addedTool(tool) {
  return {
    name: tool.name,
    description: tool.description + "\n\n(Provided by the \"" + tool.plugin_id + "\" plugin.)",
    input: tool.input && typeof tool.input === "object" ? tool.input : { type: "object", properties: {} },
    async execute(args, context) {
      const body = {
        session_id: sessionOf(context),
        input: args && typeof args === "object" ? args : {},
      }
      const callID =
        context && typeof context.id === "string" && context.id.length > 0
          ? context.id
          : context && typeof context.callID === "string" && context.callID.length > 0
            ? context.callID
            : undefined
      if (callID) body.call_id = callID
      let result
      try {
        result = await call(
          "/plugins/" + encodeURIComponent(tool.plugin_id) + "/tools/" + encodeURIComponent(tool.tool),
          { method: "POST", body: JSON.stringify(body), signal: signalOf(context) },
        )
      } catch (e) {
        const signal = signalOf(context)
        if (signal && signal.aborted) return "Cancelled."
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
      return {
        output,
        content: [
          { type: "text", text: output },
          ...attachments.map((a) => ({
            type: "file",
            mime: a.mime,
            url: "data:" + a.mime + ";base64," + a.data,
          })),
        ],
      }
    },
  }
}

/**
 * The contributed system prompt, stored on the session.
 *
 * v2 applies an instruction entry at the next step boundary, so this runs
 * when a turn starts and again before a tool call. The same text is not
 * written twice.
 */
async function contribute(ctx, sessionID) {
  if (!sessionID || !(await available())) return
  const entry = ctx.session && ctx.session.instructions && ctx.session.instructions.entry
  if (!entry) return
  let text = ""
  try {
    const answer = await call("/hooks/system-prompt?session=" + encodeURIComponent(sessionID))
    text = answer && typeof answer.text === "string" ? answer.text : ""
  } catch {
    return
  }
  if (contributed.get(sessionID) === text) return
  contributed.set(sessionID, text)
  try {
    if (!text) {
      if (typeof entry.remove === "function") await entry.remove({ sessionID, key: INSTRUCTION_KEY })
      return
    }
    if (typeof entry.put === "function") await entry.put({ sessionID, key: INSTRUCTION_KEY, value: text })
  } catch {
    contributed.delete(sessionID)
  }
}

export default {
  id: "strata",
  async setup(ctx) {
    const tools = await toolTable()
    if (ctx.tool && typeof ctx.tool.transform === "function") {
      try {
        await ctx.tool.transform((editor) => {
          for (const tool of tools) {
            if (!tool || typeof tool.name !== "string" || typeof tool.plugin_id !== "string") continue
            if (typeof tool.tool !== "string") continue
            try {
              editor.add(addedTool(tool))
            } catch {
              // A name this server already owns is skipped. The rest still register.
            }
          }
        })
      } catch {
        // A rejected table must not take the guard down with it.
      }
    }

    if (ctx.tool && typeof ctx.tool.hook === "function") {
      await ctx.tool.hook("execute.before", async (event) => {
        if (!(await available())) return
        const sessionID = sessionOf(event)
        const tool = event && typeof event.tool === "string" ? event.tool : ""
        const input = event && event.input && typeof event.input === "object" ? event.input : {}
        let verdict
        try {
          verdict = await call("/hooks/before-tool", {
            method: "POST",
            body: JSON.stringify({ session_id: sessionID, tool, input }),
          })
        } catch {
          return
        }
        if (verdict && verdict.allow === false) throw new Error(verdict.message || "refused by a plugin")
        await contribute(ctx, sessionID)
      })
    }

    // Fires with the session id before the model call. The instruction entry
    // is what the next step reads; the user prompt itself is left alone.
    if (ctx.session && typeof ctx.session.hook === "function") {
      try {
        await ctx.session.hook("prompt", async (event) => {
          await contribute(ctx, sessionOf(event))
        })
      } catch {
        // The guard and the tools still stand if this name is not a hook here.
      }
    }
  },
}
