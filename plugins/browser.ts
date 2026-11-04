// Hands browser control to the shell's service.
//
// The shell owns a real browser — a Chrome it launches itself with a persistent
// profile — plus anything the session attaches to by port, which is how an
// Electron app's windows become drivable. The agent sees a numbered list of
// interactive elements and acts on refs, never on selectors.
//
// The same rules as dev-process.ts, for the same reasons:
//
// 1. No imports. This file is installed into the user's own OpenCode config,
//    where `@opencode-ai/plugin` and `zod` are not resolvable. An import that
//    cannot resolve is a plugin that silently fails to load.
// 2. One export. OpenCode treats every export as a plugin.
// 3. Inert without the shell. When the service is not there, the tools say so
//    and an external browser MCP — if one is configured — keeps working.
// 4. The again-here case. A server the shell did not start finds the service
//    through the handshake file beside this one; the MCP redirect stays off
//    for those, because a session the app does not own should not lose its
//    own browser tools to us.

/** Said when the shell is not running, so a model knows what is missing. */
const NO_SERVICE =
  "The desktop shell is not running, so there is no service to drive a browser. " +
  "Start the app, or use another browser tool if one is configured."

let resolved = undefined

/**
 * Where the service is, and the token that says we are allowed to ask.
 * Identical to dev-process.ts — the handshake file is the service's, not
 * either plugin's.
 */
async function serviceTarget() {
  const fromEnv = process.env.STRATA_SERVICE_URL
  if (fromEnv) return { url: fromEnv, token: process.env.STRATA_API_TOKEN || "", owned: true }
  resolved ??= probeHandshake()
  const target = await resolved
  if (!target) throw new Error(NO_SERVICE)
  return { ...target, owned: false }
}

/** The handshake file, if a live service is actually behind it. */
async function probeHandshake() {
  try {
    const [{ readFile }, { dirname, join }, { fileURLToPath }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:url"),
    ])
    const here = fileURLToPath(import.meta.url)
    const file = join(dirname(dirname(here)), "strata-dev-process.json")
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
    await serviceTarget()
    return true
  } catch {
    return false
  }
}

async function call(path, init) {
  const target = await serviceTarget()
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
      body && typeof body === "object" && "error" in body
        ? String(body.error)
        : "service answered " + response.status
    throw new Error(detail)
  }
  return body
}

function post(path, sessionID, extra) {
  return call(path, {
    method: "POST",
    body: JSON.stringify({ session_id: sessionID, ...extra }),
  })
}

/**
 * A snapshot answer becomes the text a model reads. The service already
 * rendered the element list; this wraps it with the rule that keeps refs honest.
 */
function snapshotText(snap) {
  const note =
    snap.truncated > 0
      ? "The list is cut — use browser_eval for anything past the shown refs."
      : ""
  return [snap.text, "", "Refs are only valid for this snapshot — the next action returns a new one.", note]
    .filter(Boolean)
    .join("\n")
}

/** A tool result that failed politely instead of raising into the run. */
async function attempt(fn) {
  try {
    return await fn()
  } catch (e) {
    return e && e.message ? String(e.message) : String(e)
  }
}

const GUIDANCE = `

## Browser debugging

Drive real pages with the browser_* tools — they work on a browser the app owns.

\`browser_navigate\` opens a visible Chrome the app controls. The profile persists:
log in once (SSO, intranet, staging) and every session after that carries it.
The reader can watch every page live in the app's Browser panel — they see the
same pixels you drive, so prefer these tools over describing what a page shows.

To debug an Electron app, start it with \`--remote-debugging-port=<port>\` and then
\`browser_attach\` with that port — its windows show up as tabs. The same attaches
to any Chromium that answers CDP.

Read the page with \`browser_snapshot\`, act on the numbered refs with
\`browser_click\` / \`browser_type\` / \`browser_fill\` / \`browser_press\`. Refs are
re-numbered every snapshot, so act on the latest one — an action already returns
the fresh list. \`browser_eval\` runs JavaScript for anything the refs cannot
express, and \`browser_console\` reads console output, page errors, and failed
requests.
`

/** Names this plugin owns — the redirect must not eat them. */
const OWN = new Set([
  "browser_navigate",
  "browser_attach",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_press",
  "browser_hover",
  "browser_select",
  "browser_eval",
  "browser_console",
  "browser_screenshot",
  "browser_tabs",
  "browser_use",
  "browser_close",
])

/**
 * A foreign browser tool — an MCP server's namespaced copy of the same verbs.
 * Matches names like `playwright_browser_navigate` while leaving ours alone.
 */
const FOREIGN_BROWSER = /browser_(navigate|attach|snapshot|click|type|fill|press|hover|select|eval|console|screenshot|tabs|use|close|take_snapshot|drag|go_back|go_forward|wait|network_requests|handle_dialog|install|resize|run_code|file_upload|new_page|list_pages|switch_page|close_page|navigate_back)/

export default async () => ({
  tool: {
    browser_navigate: {
      description: [
        "Open a URL in the browser the app owns — a visible Chrome whose profile persists,",
        "or the current attached tab. Returns the page's interactive element list.",
        "Pass host:port plainly for a local server (localhost:3000 is enough).",
      ].join("\n"),
      args: {
        url: { type: "string", description: "http(s) URL or host:port to open" },
      },
      async execute(args, context) {
        return attempt(async () => snapshotText(await post("/browser/navigate", context.sessionID, { url: args.url })))
      },
    },

    browser_attach: {
      description: [
        "Attach to a Chromium DevTools port — an Electron app started with",
        "`--remote-debugging-port`, or another Chrome already running with CDP.",
        "Its windows become tabs this session can drive. The service never closes",
        "windows it only attached to.",
      ].join("\n"),
      args: {
        port: { type: "number", description: "The CDP port, e.g. 9222" },
      },
      async execute(args, context) {
        return attempt(async () => {
          const state = await post("/browser/attach", context.sessionID, { port: args.port })
          const rows = state.targets.map((t) => `${t.id} ${t.url} (${t.source})`)
          return `Attached. Tabs this session holds:\n${rows.join("\n") || "(none)"}`
        })
      },
    },

    browser_snapshot: {
      description:
        "Read the current page as a numbered list of interactive elements. The refs it returns are what click/type/fill take.",
      args: {},
      async execute(_args, context) {
        return attempt(async () => snapshotText(await post("/browser/snapshot", context.sessionID, {})))
      },
    },

    browser_click: {
      description: "Click an element by its snapshot ref (e5). Returns the fresh snapshot.",
      args: { ref: { type: "string", description: "The ref from the latest snapshot" } },
      async execute(args, context) {
        return attempt(async () =>
          snapshotText(await post("/browser/act", context.sessionID, { action: "click", ref: args.ref })),
        )
      },
    },

    browser_type: {
      description: [
        "Type into an element by its ref, key by key — triggers input events like a",
        "person typing. Use browser_fill to set a value atomically instead.",
      ].join("\n"),
      args: {
        ref: { type: "string", description: "The ref from the latest snapshot" },
        text: { type: "string", description: "The text to type" },
      },
      async execute(args, context) {
        return attempt(async () =>
          snapshotText(
            await post("/browser/act", context.sessionID, { action: "type", ref: args.ref, text: args.text }),
          ),
        )
      },
    },

    browser_fill: {
      description: "Set an input's value in one step — replaces what is there.",
      args: {
        ref: { type: "string" },
        text: { type: "string" },
      },
      async execute(args, context) {
        return attempt(async () =>
          snapshotText(
            await post("/browser/act", context.sessionID, { action: "fill", ref: args.ref, text: args.text }),
          ),
        )
      },
    },

    browser_press: {
      description: "Send a key to an element — Enter, Tab, Escape, ArrowDown.",
      args: {
        ref: { type: "string" },
        key: { type: "string", description: "Key name, e.g. Enter" },
      },
      async execute(args, context) {
        return attempt(async () =>
          snapshotText(
            await post("/browser/act", context.sessionID, { action: "press", ref: args.ref, key: args.key }),
          ),
        )
      },
    },

    browser_hover: {
      description: "Hover an element by its ref — opens menus and tooltips.",
      args: { ref: { type: "string" } },
      async execute(args, context) {
        return attempt(async () =>
          snapshotText(await post("/browser/act", context.sessionID, { action: "hover", ref: args.ref })),
        )
      },
    },

    browser_select: {
      description: "Pick an option in a <select> by its visible label.",
      args: {
        ref: { type: "string" },
        text: { type: "string", description: "The option's visible label" },
      },
      async execute(args, context) {
        return attempt(async () =>
          snapshotText(
            await post("/browser/act", context.sessionID, { action: "select", ref: args.ref, text: args.text }),
          ),
        )
      },
    },

    browser_eval: {
      description: [
        "Run JavaScript in the current page and get the result back. The escape",
        "hatch for anything refs cannot express: reading text, scrolling,",
        "waiting for state, inspecting the DOM.",
      ].join("\n"),
      args: {
        js: { type: "string", description: "A JS expression or () => function string" },
      },
      async execute(args, context) {
        return attempt(async () => {
          const out = await post("/browser/eval", context.sessionID, { js: args.js })
          return typeof out.result === "string" ? out.result : JSON.stringify(out.result)
        })
      },
    },

    browser_console: {
      description:
        "Read the current tab's console output, page errors, and failed requests — the first place to look when a page misbehaves.",
      args: {
        tail: { type: "number", description: "How many recent lines, default 100" },
      },
      async execute(args, context) {
        return attempt(async () => {
          const tail = typeof args.tail === "number" ? args.tail : 100
          const out = await call(`/browser/console?session=${encodeURIComponent(context.sessionID)}&tail=${tail}`)
          if (!out.lines.length) return "No console output yet."
          return out.lines.map((l) => `[${l.kind}] ${l.text}`).join("\n")
        })
      },
    },

    browser_screenshot: {
      description: "Take a screenshot of the current tab. Returns the image plus the file it was saved to.",
      args: {},
      async execute(_args, context) {
        try {
          const out = await post("/browser/screenshot", context.sessionID, {})
          return {
            content: [
              { type: "text", text: `Saved to ${out.path}` },
              { type: "image", mimeType: "image/png", data: out.data },
            ],
          }
        } catch (e) {
          return e && e.message ? String(e.message) : String(e)
        }
      },
    },

    browser_tabs: {
      description: "List the tabs this session holds — own Chrome pages and attached windows.",
      args: {},
      async execute(_args, context) {
        return attempt(async () => {
          const state = await call(`/browser?session=${encodeURIComponent(context.sessionID)}`)
          if (!state.targets.length) return "No tabs — browser_navigate opens one."
          return state.targets
            .map((t) => `${t.id}${t.current ? " (current)" : ""} ${t.url} [${t.source}]`)
            .join("\n")
        })
      },
    },

    browser_use: {
      description: "Switch which tab the other browser_* tools act on.",
      args: { target: { type: "string", description: "A tab id from browser_tabs, e.g. pg3" } },
      async execute(args, context) {
        return attempt(async () => {
          await post("/browser/use", context.sessionID, { target: args.target })
          return `Now on ${args.target}.`
        })
      },
    },

    browser_close: {
      description: "Close this session's own tabs. Attached windows are let go, not closed.",
      args: {},
      async execute(_args, context) {
        return attempt(async () => {
          const out = await post("/browser/close", context.sessionID, {})
          return `Closed ${out.closed} tab(s).`
        })
      },
    },
  },

  // A session running under the shell has no need for a second browser stack:
  // the app's own tools see the same page the reader sees, and a foreign MCP
  // browser would open a different window with different state. The tool call
  // is refused with the name of ours, the way dev-process refuses Start-Process.
  //
  // Only under the shell — a server started elsewhere shares this plugin, and
  // its browser MCP is its own business.
  "tool.execute.before": async (input) => {
    if (OWN.has(input.tool)) return
    if (!FOREIGN_BROWSER.test(input.tool)) return
    if (!process.env.STRATA_SERVICE_URL) return
    throw new Error(
      [
        `Use the shell's browser tools instead of ${input.tool}.`,
        "",
        "browser_navigate / browser_snapshot / browser_click drive a browser this app",
        "owns — same window the reader sees, with a profile that keeps its logins.",
        "browser_attach reaches an Electron app or another CDP port.",
      ].join("\n"),
    )
  },

  "experimental.chat.system.transform": async (_input, output) => {
    if (!(await available())) return
    if (output.system.some((entry) => entry.includes("## Browser debugging"))) return
    output.system.push(GUIDANCE)
  },
})
