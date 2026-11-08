// The plugin surface of the HTTP API.
//
// Two kinds of route live here, and the difference matters:
//
// - `/plugins/:id/tools/:tool` is the only place a plugin tool runs. It does
//   the whole sequence — session resolve, guards, policy, ask, dispatch — so
//   there is exactly one answer to "where is policy enforced".
// - Everything else (`/plugins`, `/plugins/tools`, lifecycle, resources,
//   events, hooks, private routes) is plumbing: no policy decision, only
//   namespace checks and the guards that belong to a declaration.
//
// The old flat `/dev` routes are gone. They were the shape this replaces: a
// capability that had to be wired into the service and into the shim.

import type { PluginEvent, ToolEntry } from "@agent-strata/plugin-sdk";
import { coerceToolInput } from "./args";
import { readToolCall } from "./call";
import type { PluginHost } from "./host";
import { GuardError } from "./host";

export interface PluginRouteDeps {
  host: PluginHost;
  /**
   * `POST /plugins/mcp?session=…` — the MCP face ACP agents are handed.
   * Returns undefined for any other path.
   */
  mcp?: (req: Request, url: URL) => Promise<Response | undefined>;
  resolveSession: (given: string) => string;
  /**
   * Judge one plugin tool call. Passed in rather than computed here so the
   * service keeps one implementation of "policy + ask" (the same one `/dev`
   * used), instead of this file growing a second.
   */
  authorize: (
    sessionId: string,
    tool: ToolEntry,
    input: Record<string, unknown>,
  ) => Promise<{ allow: true } | { allow: false; status: number; error: string }>;
  /** Where a session's workspace is, for the tool's default cwd. */
  directoryOf: (sessionId: string) => string | undefined;
  json: (data: unknown, status?: number) => Response;
  /** Query token whitelist must already be applied by the caller. */
  onChanged: (listener: () => void) => () => void;
}

/**
 * Match `/plugins/...` and answer it, or return undefined.
 *
 * Fixed verbs are matched before the plugin's own routes: `/plugins/:id/health`
 * can never be shadowed by a plugin whose `route()` would like the path.
 */
export async function pluginRoute(
  req: Request,
  url: URL,
  deps: PluginRouteDeps,
): Promise<Response | undefined> {
  const path = url.pathname;
  // The MCP endpoint is a different protocol on the same prefix; it is asked
  // first so `/plugins/mcp` is never read as a plugin named "mcp".
  if (deps.mcp) {
    const answer = await deps.mcp(req, url);
    if (answer) return answer;
    // `/plugins/mcp` with a ticket that is not bound (or none at all) is
    // answered here rather than falling through to "no plugin called mcp",
    // because the ticket — not the path — is what is wrong.
    if (url.pathname === "/plugins/mcp") {
      return deps.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "this endpoint is not bound to a session" } },
        403,
      );
    }
  }
  const ours =
    path === "/plugins" || path.startsWith("/plugins/") || path === "/hooks/before-tool" || path === "/hooks/system-prompt";
  if (!ours) return undefined;
  const { host, json } = deps;

  if (path === "/plugins" && req.method === "GET") {
    return json({
      plugins: host.list().map((p) => ({
        id: p.id,
        state: p.state,
        error: p.error,
        ...host.summary().find((s) => s.id === p.id),
      })),
    });
  }

  if (path === "/plugins/tools" && req.method === "GET") {
    // Session-free by design: an adapter registers this table before any
    // session exists, and a table that changed per session could not be
    // registered there at all. `session` is accepted and ignored so an older
    // caller does not break.
    return json({ tools: host.toolTable() });
  }

  const rest = path.slice("/plugins/".length);

  // --- lifecycle ---------------------------------------------------------
  const lifecycle = /^([a-z][a-z0-9-]*)\/lifecycle$/.exec(rest);
  if (lifecycle && req.method === "POST") {
    const id = lifecycle[1]!;
    const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
    const action = body?.action;
    if (action !== "enable" && action !== "disable" && action !== "restart") {
      return json({ error: 'action must be "enable", "disable" or "restart"' }, 400);
    }
    if (!host.get(id)) return json({ error: "no such plugin" }, 404);
    const started = Date.now();
    try {
      if (action === "enable") await host.enable(id);
      else if (action === "disable") await host.disable(id);
      else await host.restart(id);
      return json({ ok: true, action, plugin: host.get(id)?.state, ms: Date.now() - started });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }

  // --- health ------------------------------------------------------------
  const health = /^([a-z][a-z0-9-]*)\/health$/.exec(rest);
  if (health && req.method === "GET") {
    const record = host.get(health[1]!);
    if (!record) return json({ error: "no such plugin" }, 404);
    return json({
      id: record.manifest.id,
      state: record.state,
      error: record.error,
      initialized_at: record.initializedAt,
      uptime_ms: record.initializedAt ? Date.now() - record.initializedAt : undefined,
    });
  }

  // --- tool execution: the one place a plugin tool runs -------------------
  const call = /^([a-z][a-z0-9-]*)\/tools\/([a-z][a-z0-9_-]*)$/.exec(rest);
  if (call && req.method === "POST") {
    const pluginId = call[1]!;
    const tool = call[2]!;
    const found = host.resolveTool(pluginId, tool);
    if (!found) return json({ error: "no such tool" }, 404);

    const parsed = await readToolCall(req, deps.resolveSession);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);

    // The same normalisation the MCP face applies: a client that sent the
    // schema instead of an instance of it should not reach the tool as-is.
    const input = coerceToolInput(found.entry.input, parsed.input);
    const verdict = await deps.authorize(parsed.sessionId, found.entry, input);
    if (!verdict.allow) return json({ error: verdict.error }, verdict.status);

    // The caller's connection is the cancellation source: if it goes away, the
    // plugin is told, so a browser action does not keep running for a reader
    // who closed the window.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await host.callTool(pluginId, tool, {
        callId: parsed.callId,
        sessionId: parsed.sessionId,
        input,
        signal: controller.signal,
      });
      // A tool that failed is a successful call that reports failure: the
      // MCP mapping every adapter here agrees on is `isError` in the result,
      // not a transport error. Only a dispatch failure — no such plugin, a
      // plugin that broke mid-call — leaves the route with a non-200.
      return json({
        output: result.output,
        is_error: result.isError === true,
        attachments: result.attachments,
        plugin_id: pluginId,
        tool,
      });
    } catch (e) {
      if (e instanceof GuardError) return json({ error: e.message }, 403);
      return json({ error: e instanceof Error ? e.message : String(e), plugin_id: pluginId, tool }, 502);
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
  }

  // --- resources ---------------------------------------------------------
  const resource = /^([a-z][a-z0-9-]*)\/resources\/([a-z][a-z0-9-]*)$/.exec(rest);
  if (resource && req.method === "GET") {
    const pluginId = resource[1]!;
    const key = resource[2]!;
    const requested = url.searchParams.get("session");
    const sessionId = requested === null ? undefined : deps.resolveSession(requested);
    if (!sessionId) return json({ error: "session required" }, 400);
    try {
      const read = await host.readResource(pluginId, key, sessionId);
      const body = read.body instanceof Uint8Array ? read.body : new TextEncoder().encode(read.body);
      return new Response(body, {
        headers: {
          "content-type": read.mime,
          "content-length": String(body.byteLength),
          // Same posture as the extension routes: whatever a plugin returns is
          // data, never a page that runs as this origin.
          "content-security-policy": "sandbox",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  }

  // --- events ------------------------------------------------------------
  const events = /^([a-z][a-z0-9-]*)\/events$/.exec(rest);
  if (events && req.method === "GET") {
    const pluginId = events[1]!;
    if (!host.isRunning(pluginId)) return json({ error: "no such plugin" }, 404);
    const requested = url.searchParams.get("session");
    const sessionId = requested === null ? undefined : deps.resolveSession(requested);
    return eventStream(host, pluginId, sessionId);
  }

  // --- hooks -------------------------------------------------------------
  if (path === "/hooks/before-tool" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      session_id?: unknown;
      tool?: unknown;
      input?: unknown;
    } | null;
    if (typeof body?.session_id !== "string" || body.session_id.length === 0) {
      return json({ error: "session_id required" }, 400);
    }
    if (typeof body.tool !== "string" || body.tool.length === 0) {
      return json({ error: "tool required" }, 400);
    }
    const sessionId = deps.resolveSession(body.session_id);
    const input =
      body.input && typeof body.input === "object" && !Array.isArray(body.input)
        ? (body.input as Record<string, unknown>)
        : {};
    const verdict = await host.beforeTool({ sessionId, tool: body.tool, input });
    return json(verdict);
  }

  if (path === "/hooks/system-prompt" && req.method === "GET") {
    const requested = url.searchParams.get("session");
    // A prompt transform can run before a session exists (a title, a summary).
    // With no session there is nothing session-specific to contribute, but the
    // guidance is still true, so an unresolved id is used as given.
    const sessionId = requested === null ? "" : deps.resolveSession(requested);
    const text = await host.systemPrompt(sessionId);
    return json({ text });
  }

  // --- private routes ----------------------------------------------------
  const priv = /^([a-z][a-z0-9-]*)(\/.*)$/.exec(rest);
  if (priv) {
    const pluginId = priv[1]!;
    const subpath = priv[2]!;
    const record = host.get(pluginId);
    if (!record) return json({ error: "no such plugin" }, 404);
    const answer = await host.route(pluginId, req, subpath);
    return answer ?? json({ error: "not found" }, 404);
  }

  return undefined;
}

/** SSE: one plugin's events, optionally narrowed to a session. */
function eventStream(host: PluginHost, pluginId: string, sessionId: string | undefined): Response {
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<string>({
    start(ctrl) {
      const write = (chunk: string) => {
        try {
          ctrl.enqueue(chunk);
        } catch {
          if (ctrl.desiredSize === null) stop();
        }
      };
      const stop = () => {
        unsubscribe?.();
        unsubscribe = undefined;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
      };
      write(`data: ${JSON.stringify({ type: "plugin.connected", plugin_id: pluginId })}\n\n`);
      unsubscribe = host.subscribe(pluginId, (event: PluginEvent) => {
        // Scoping follows what the event says about itself. An event that
        // names a session is delivered only to that session's subscriber; one
        // that names none is global, and goes to every subscriber of the
        // plugin. That is deliberate — a plugin announcing "my tab appeared"
        // has no session to name — but it means a plugin that forgets
        // `session_id` on a per-session event broadcasts it to all of them.
        const owner = (event.data as { session_id?: string } | undefined)?.session_id;
        if (sessionId !== undefined && owner !== undefined && owner !== sessionId) return;
        write(`data: ${JSON.stringify({ ...event, plugin_id: pluginId })}\n\n`);
      });
      heartbeat = setInterval(() => write(": keep-alive\n\n"), 20_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe = undefined;
      heartbeat = undefined;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}
