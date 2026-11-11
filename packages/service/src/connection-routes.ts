import { connectionPhase, connectionPlacement, sameEndpoint } from "./connection-phase";
import { REMEMBERED_PROBE_MS } from "./boot-connect";
import { endpointOf, type ConnectBody, type connectionMemory } from "./connections";
import type { ConnectionRegistry } from "./connection-registry";
import type { BackendDriver, ModelChoice } from "./driver";
import type { SessionClaims } from "./identity";
import { readOpencodeStatus } from "./opencode-status";

export interface ConnectionAttempt {
  endpoint: string;
  backend: string;
  phase: "retrying" | "failed";
  error?: string;
}

export async function connectionRoute(
  req: Request,
  path: string,
  deps: {
    connections: ConnectionRegistry;
    attempts: Map<string, ConnectionAttempt>;
    activeSyncs: Map<string, { done: number; total: number }>;
    pendingSyncs: Set<string>;
    desktopDir: string;
    memory: ReturnType<typeof connectionMemory>;
    dismissedEmbedded: Map<string, string>;
    claims: SessionClaims;
    connectBackend(body: ConnectBody): Promise<{ id: string; indexed: number }>;
    withEmbeddedCredentials(body: ConnectBody): ConnectBody;
    syncDriver(driver: BackendDriver): Promise<{ imported: number; reconciled: number }>;
    failAttempt(body: ConnectBody, error: unknown, settle: boolean): void;
  },
): Promise<Response | undefined> {
  if (path === "/connect" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as ConnectBody | null;
    if (!body?.baseUrl && !body?.command) {
      return Response.json({ error: "baseUrl or command required" }, { status: 400 });
    }
    try {
      const connected = await deps.connectBackend(body);
      deps.memory.remember(body);
      return Response.json(connected);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  if (path === "/sync" && req.method === "POST") {
    if (deps.connections.size === 0) {
      await Promise.all(
        deps.memory.saved().map(async (saved) => {
          try {
            await deps.connectBackend({
              ...deps.withEmbeddedCredentials(saved),
              connectTimeoutMs: REMEMBERED_PROBE_MS,
            });
          } catch (error) {
            console.error(`reconnect ${endpointOf(saved)} failed: ${error}`);
            deps.failAttempt(saved, error, false);
          }
        }),
      );
    }
    if (deps.connections.size === 0) {
      return Response.json({ connected: false, imported: 0, reconciled: 0 });
    }
    let imported = 0;
    let reconciled = 0;
    for (const conn of deps.connections.values()) {
      try {
        const result = await deps.syncDriver(conn);
        imported += result.imported;
        reconciled += result.reconciled;
      } catch (error) {
        console.error(`sync ${conn.id} failed: ${error}`);
      }
    }
    return Response.json({ connected: true, imported, reconciled });
  }

  if (path === "/connections" && req.method === "GET") {
    const launch = readOpencodeStatus(deps.desktopDir);
    const listed = [...deps.attempts.values()].map((attempt) => ({
      ...attempt,
      placement: connectionPlacement(attempt.backend, attempt.endpoint, launch),
    }));
    const connections = [...deps.connections.values()].map((conn) => ({
      id: conn.id,
      backend: conn.backend,
      baseUrl: conn.baseUrl,
      name: conn.name,
      directory: conn.directory,
      capabilities: { ...conn.capabilities, extension: conn.extension?.kind },
      placement: connectionPlacement(conn.backend, conn.baseUrl, launch),
      sync: deps.activeSyncs.has(conn.id) ? "syncing" : deps.pendingSyncs.has(conn.id) ? "starting" : "idle",
      ...(deps.activeSyncs.has(conn.id)
        ? {
            syncDone: deps.activeSyncs.get(conn.id)?.done,
            syncTotal: deps.activeSyncs.get(conn.id)?.total,
          }
        : {}),
    }));
    return Response.json({
      connections,
      attempts: listed,
      phase: connectionPhase({
        connected: connections.length > 0,
        attempts: listed,
        launchState: launch.state,
      }),
    });
  }

  if (path === "/options" && req.method === "GET") {
    const models: ModelChoice[] = [];
    const agents: { name: string; mode?: string }[] = [];
    for (const conn of deps.connections.values()) {
      try {
        models.push(...(await conn.listModels()));
        agents.push(...(await conn.listAgents()));
      } catch {
        // A backend that cannot list options contributes nothing.
      }
    }
    return Response.json({ models, agents });
  }

  if (path === "/connections/forget" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
    const endpoint = body?.endpoint;
    if (typeof endpoint !== "string" || endpoint.length === 0) {
      return Response.json({ error: "endpoint required" }, { status: 400 });
    }
    const status = readOpencodeStatus(deps.desktopDir);
    if (status.url === endpoint && status.password) {
      deps.dismissedEmbedded.set(endpoint, status.password);
    }
    deps.memory.forget(endpoint);
    deps.attempts.delete(endpoint);
    return Response.json({ ok: true });
  }

  const disconnect = path.match(/^\/connections\/([^/]+)$/);
  if (disconnect && req.method === "DELETE") {
    const conn = deps.connections.get(decodeURIComponent(disconnect[1]!));
    if (!conn) return Response.json({ error: "not found" }, { status: 404 });
    const status = readOpencodeStatus(deps.desktopDir);
    if (status.url && sameEndpoint(conn.baseUrl, status.url) && status.password) {
      deps.dismissedEmbedded.set(conn.baseUrl, status.password);
    }
    conn.stop();
    deps.connections.remove(conn.id);
    deps.claims.release(conn.id);
    deps.memory.forget(conn.baseUrl);
    return Response.json({ ok: true });
  }

  return undefined;
}
