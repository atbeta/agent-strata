// Local HTTP service exposing the agent-strata horizontal layer to UIs.
// The desktop shell (Tauri) runs this as a sidecar and talks to it over
// localhost. One store file, many backend connections, SSE fan-out to clients.

import { openStore, type Store, type EventQuery } from "@agent-strata/store";
import { projectSession, aggregate, type SessionView } from "@agent-strata/projector";
import { connectOpencode } from "@agent-strata/adapter-opencode";
import { compareSessions, exportEvents } from "@agent-strata/core";
import { loadPolicy, type Policy } from "@agent-strata/policy";
import type { Event } from "@agent-strata/schema";

export interface ServiceOpts {
  db?: string;
  port?: number;
}

interface Conn {
  id: string;
  backend: string;
  baseUrl: string;
  directory?: string;
  stop: () => void;
  createSession: (opts?: { title?: string }) => Promise<{ id: string }>;
  prompt: (
    sessionID: string,
    text: string,
    opts?: { model?: { providerID: string; modelID: string }; agent?: string },
  ) => Promise<void>;
}

interface PendingAsk {
  request_id: string;
  session_id: string;
  tool: string;
  input: Record<string, unknown>;
  asked_at: string;
  resolve: (ans: { decision: "allow" | "deny"; scope?: "once" | "always" }) => void;
}

export interface RunningService {
  port: number;
  store: Store;
  stop: () => void;
}

export function startService(opts: ServiceOpts = {}): RunningService {
  const store = openStore(opts.db ?? ":memory:");
  const conns = new Map<string, Conn>();
  const pendingAsks = new Map<string, PendingAsk>();
  const subscribers = new Set<(evt: Event) => void>();
  store.subscribe((e) => {
    for (const fn of subscribers) fn(e);
  });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });

  const sessionView = (sessionId: string): SessionView =>
    projectSession(store.read({ session_id: sessionId }));

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/health") return json({ ok: true, conns: conns.size });

      if (path === "/sessions" && req.method === "GET") {
        const summaries = store.listSessions({
          backend: url.searchParams.get("backend") ?? undefined,
          limit: Number(url.searchParams.get("limit") ?? 200),
        });
        const views = summaries.map((s) => {
          const v = sessionView(s.session_id);
          return { summary: s, status: v.status, totals: v.totals, title: v.title };
        });
        return json({ sessions: views, aggregate: aggregate(views.map((v) => sessionView(v.summary.session_id))) });
      }

      if (path === "/events" && req.method === "GET") {
        const q: EventQuery = {
          session_id: url.searchParams.get("session_id") ?? undefined,
          backend: url.searchParams.get("backend") ?? undefined,
          types: url.searchParams.get("types")?.split(","),
          since: url.searchParams.get("since") ?? undefined,
          until: url.searchParams.get("until") ?? undefined,
          text: url.searchParams.get("text") ?? undefined,
          order: (url.searchParams.get("order") as "asc" | "desc") ?? "asc",
          offset: url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : undefined,
          limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
        };
        return json({ events: store.query(q) });
      }

      const sessionMatch = path.match(/^\/sessions\/([^/]+)\/view$/);
      if (sessionMatch && req.method === "GET") {
        return json(sessionView(decodeURIComponent(sessionMatch[1]!)));
      }

      if (path === "/sessions" && req.method === "POST") {
        const conn = [...conns.values()][0];
        if (!conn) return json({ error: "no backend connected" }, 400);
        const body = (await req.json().catch(() => ({}))) as { title?: string };
        const created = await conn.createSession({ title: body.title });
        return json({ id: `opencode:${created.id}`, native_id: created.id });
      }

      const promptMatch = path.match(/^\/sessions\/([^/]+)\/prompt$/);
      if (promptMatch && req.method === "POST") {
        const conn = [...conns.values()][0];
        if (!conn) return json({ error: "no backend connected" }, 400);
        const body = (await req.json().catch(() => null)) as {
          text?: string;
          model?: { providerID: string; modelID: string };
          agent?: string;
        } | null;
        if (!body?.text) return json({ error: "text required" }, 400);
        const native = decodeURIComponent(promptMatch[1]!).replace(/^opencode:/, "");
        try {
          await conn.prompt(native, body.text, { model: body.model, agent: body.agent });
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e) }, 502);
        }
      }

      if (path === "/compare" && req.method === "GET") {
        const a = url.searchParams.get("a");
        const b = url.searchParams.get("b");
        if (!a || !b) return json({ error: "a and b session ids required" }, 400);
        return json(compareSessions(sessionView(a), sessionView(b)));
      }

      if (path === "/export" && req.method === "GET") {
        const sessionId = url.searchParams.get("session_id") ?? undefined;
        const body = exportEvents(store, {
          session_id: sessionId,
          redact: url.searchParams.get("redact") !== "false",
        });
        return new Response(body, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }

      if (path === "/connect" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          backend?: string;
          baseUrl?: string;
          directory?: string;
          policy?: unknown;
          connectTimeoutMs?: number;
        } | null;
        if (!body?.baseUrl) return json({ error: "baseUrl required" }, 400);
        if ((body.backend ?? "opencode") !== "opencode")
          return json({ error: "only opencode backend supported" }, 400);
        try {
          const policy: Policy | undefined = body.policy ? loadPolicy(body.policy) : undefined;
          const conn = await connectOpencode({
            baseUrl: body.baseUrl,
            directory: body.directory,
            sink: store,
            policy,
            connectTimeoutMs: body.connectTimeoutMs,
            onAsk: (req) => {
              store.append([req]);
              const data = req.data as {
                request_id: string;
                tool: string;
                input: Record<string, unknown>;
              };
              return new Promise<{ decision: "allow" | "deny"; scope?: "once" | "always" }>(
                (resolve) =>
                  pendingAsks.set(data.request_id, {
                    request_id: data.request_id,
                    session_id: req.session_id,
                    tool: data.tool,
                    input: data.input,
                    asked_at: req.ts,
                    resolve,
                  }),
              );
            },
          });
          const id = `opencode:${body.baseUrl}`;
          conns.set(id, {
            id,
            backend: "opencode",
            baseUrl: body.baseUrl,
            directory: body.directory,
            stop: conn.stop,
            createSession: conn.createSession,
            prompt: conn.prompt,
          });
          return json({ id });
        } catch (e) {
          return json({ error: String(e) }, 502);
        }
      }

      if (path === "/connections" && req.method === "GET") {
        return json({
          connections: [...conns.values()].map(({ stop: _s, ...c }) => c),
        });
      }

      if (path === "/permissions" && req.method === "GET") {
        return json({
          pending: [...pendingAsks.values()].map(({ resolve: _r, ...p }) => p),
        });
      }

      const permMatch = path.match(/^\/permissions\/([^/]+)\/respond$/);
      if (permMatch && req.method === "POST") {
        const ask = pendingAsks.get(decodeURIComponent(permMatch[1]!));
        if (!ask) return json({ error: "no pending ask" }, 404);
        const body = (await req.json().catch(() => ({}))) as {
          decision?: string;
          scope?: "once" | "always";
        };
        pendingAsks.delete(ask.request_id);
        ask.resolve({
          decision: body.decision === "deny" ? "deny" : "allow",
          scope: body.scope,
        });
        return json({ ok: true });
      }

      const discMatch = path.match(/^\/connections\/([^/]+)$/);
      if (discMatch && req.method === "DELETE") {
        const conn = conns.get(decodeURIComponent(discMatch[1]!));
        if (!conn) return json({ error: "not found" }, 404);
        conn.stop();
        conns.delete(conn.id);
        return json({ ok: true });
      }

      if (path === "/stream") {
        let enqueue: ((evt: Event) => void) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const drop = () => {
          if (enqueue) subscribers.delete(enqueue);
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
        };
        const stream = new ReadableStream<string>({
          start(ctrl) {
            const write = (chunk: string) => {
              try {
                ctrl.enqueue(chunk);
              } catch {
                // desiredSize === null means the stream is closed for good
                if (ctrl.desiredSize === null) drop();
              }
            };
            write(`data: ${JSON.stringify({ type: "service.connected" })}\n\n`);
            // comment-frame heartbeat: keeps proxies flushing the stream and
            // surfaces dead connections so stale subscribers get reaped
            heartbeat = setInterval(() => write(`: hb\n\n`), 15_000);
            enqueue = (evt) => write(`data: ${JSON.stringify(evt)}\n\n`);
            subscribers.add(enqueue);
          },
          cancel() {
            drop();
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      }

      return json({ error: "not found" }, 404);
    },
  });

  return {
    port: server.port ?? (opts.port ?? 0),
    store,
    stop: () => {
      for (const c of conns.values()) c.stop();
      server.stop();
      store.close();
    },
  };
}

if (import.meta.main) {
  const db = process.env.STRATA_DB ?? `${process.env.HOME}/.agent-strata/events.db`;
  const port = Number(process.env.STRATA_PORT ?? 7700);
  const svc = startService({ db, port });
  console.log(`agent-strata service listening on http://127.0.0.1:${svc.port} (db: ${db})`);
}
