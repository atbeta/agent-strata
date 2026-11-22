import type { PluginSocketHandlers } from "@agent-strata/plugin-sdk";
import type { PluginHost } from "./host";

export interface PluginSocketLink {
  kind: "plugin";
  handlers: PluginSocketHandlers;
}

interface UpgradeServer {
  upgrade(req: Request, options: { data: PluginSocketLink }): boolean;
}

export function isPluginSocketLink(value: unknown): value is PluginSocketLink {
  return !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "plugin";
}

export async function pluginUpgrade(
  req: Request,
  url: URL,
  server: UpgradeServer,
  host: PluginHost,
): Promise<"upgraded" | Response | undefined> {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return undefined;
  if (!url.pathname.startsWith("/plugins/")) return undefined;
  const rest = url.pathname.slice("/plugins/".length);
  const match = /^([a-z][a-z0-9-]*)(\/.*)$/.exec(rest);
  if (!match) return undefined;
  const result = await host.upgrade(match[1]!, req, match[2]!);
  if (result instanceof Response) return result;
  if (!result) return Response.json({ error: "not found" }, { status: 404 });
  const data: PluginSocketLink = { kind: "plugin", handlers: result.handlers };
  if (server.upgrade(req, { data })) return "upgraded";
  return Response.json({ error: "upgrade failed" }, { status: 400 });
}
