// The MCP face of the plugin platform.
//
// ACP agents are handed MCP servers per session, so this is how an agent that
// is not OpenCode reaches the same tools. It is a *dumb* adapter in the
// strictest sense: `tools/list` is the host's table, `tools/call` is
// `POST /plugins/:id/tools/:tool` with the session the URL named. It does no
// policy of its own, because there is nothing here that could bypass the one
// place policy runs.
//
// Transport: MCP "Streamable HTTP" in its simple form — one JSON-RPC message
// per POST, answered with `application/json`. No SSE stream back to the
// client: a tool result here is small (text, or an attachment reference), and
// a stream nobody reads is a socket held open for nothing.

import type { ToolEntry } from "@agent-strata/plugin-sdk";
import type { PluginHost } from "./host";

export interface McpDeps {
  host: PluginHost;
  /** Only a session a ticket was bound to may be served. */
  sessionOf: (ticket: string) => string | undefined;
  /** The tool table an agent may see. Same one the shim uses. */
  tools: () => ToolEntry[];
  /**
   * The one execution path. The caller supplies it rather than this file
   * importing policy, so the MCP endpoint cannot drift into having its own
   * opinion about who may run what.
   */
  execute: (
    pluginId: string,
    tool: string,
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    callId: string,
  ) => Promise<{ output: string; isError?: boolean }>;
  json: (data: unknown, status?: number) => Response;
}

const PROTOCOL_VERSION = "2025-06-18";

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * `POST /plugins/mcp?session=…`.
 *
 * The session is in the URL rather than in each call because that is the only
 * place ACP can put it: `mcpServers` is per session, and the agent's MCP client
 * speaks a protocol that has no notion of ours.
 */
export async function mcpRoute(
  req: Request,
  url: URL,
  deps: McpDeps,
): Promise<Response | undefined> {
  if (url.pathname !== "/plugins/mcp") return undefined;
  if (req.method !== "POST") {
    // No server-initiated stream and no session to delete: the endpoint is a
    // pure request/response surface.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  // The URL names a ticket, never a session id: an agent holds this URL, and a
  // session id in it would be a capability to call tools as that session.
  const requested = url.searchParams.get("session");
  const sessionId = requested === null ? undefined : deps.sessionOf(requested);
  if (sessionId === undefined) return undefined;

  const raw = await req.text();
  let message: Rpc;
  try {
    message = JSON.parse(raw) as Rpc;
  } catch {
    return deps.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  // A batch is legal JSON-RPC; answering each in an array is the legal answer.
  if (Array.isArray(message)) {
    const answers = await Promise.all(
      (message as unknown as Rpc[]).map((one) => handle(one, sessionId, deps, req.signal)),
    );
    return deps.json(answers.filter((a) => a !== undefined));
  }

  const answer = await handle(message, sessionId, deps, req.signal);
  // A notification (no id) has no response body. 202 is what the transport
  // expects, and an empty 200 makes some clients treat it as a broken reply.
  if (answer === undefined) return new Response(null, { status: 202 });
  return deps.json(answer);
}

async function handle(
  message: Rpc,
  sessionId: string,
  deps: McpDeps,
  signal: AbortSignal,
): Promise<unknown> {
  const id = message.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });

  switch (message.method) {
    case "initialize":
      return ok({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "strata", version: "1" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: deps.tools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input,
        })),
      });
    case "tools/call": {
      const params = message.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      const split = splitQualified(name);
      if (!split) return fail(-32602, `unknown tool ${name}`);
      // The call id is minted here and used for both sides: the tool call the
      // agent reports and the progress this endpoint sends carry the same key.
      const callId = `mcp:${crypto.randomUUID()}`;
      try {
        const result = await deps.execute(split.pluginId, split.tool, sessionId, args, signal, callId);
        return ok({
          content: [{ type: "text", text: result.output }],
          ...(result.isError ? { isError: true } : {}),
        });
      } catch (e) {
        // A refusal or a failure inside the plugin is a *tool* result, not a
        // protocol error: the model has to read it and decide what to do.
        return ok({
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `unknown method ${message.method ?? ""}`);
  }
}

/** `<plugin>_<tool>`; the id cannot contain an underscore, so the first splits it. */
function splitQualified(name: string): { pluginId: string; tool: string } | undefined {
  const at = name.indexOf("_");
  if (at <= 0 || at === name.length - 1) return undefined;
  return { pluginId: name.slice(0, at), tool: name.slice(at + 1) };
}
