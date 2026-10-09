// Local HTTP service exposing the agent-strata horizontal layer to UIs.
// The desktop shell (Tauri) runs this as a sidecar and talks to it over
// localhost. One store file, many backend connections, SSE fan-out to clients.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openStore, type Store, type EventQuery } from "@agent-strata/store";
import { projectSession, aggregate, type SessionView } from "@agent-strata/projector";
import { compareSessions, exportEvents } from "@agent-strata/core";
import { evaluate, loadPolicy, type Policy } from "@agent-strata/policy";
import type { Event } from "@agent-strata/schema";
import type { BackendDriver } from "./driver";
import { connectOpencodeDriver } from "./opencode-driver";

export interface ServiceOpts {
  db?: string;
  port?: number;
  // optional JSON file the live policy is loaded from / persisted to
  policyFile?: string;
  // backend baseUrl to connect on boot, retried until autoConnectTimeoutMs.
  // username/password are the HTTP basic pair for `opencode serve`.
  autoConnect?: string;
  autoConnectUsername?: string;
  autoConnectPassword?: string;
  autoConnectTimeoutMs?: number;
}

interface PendingAsk {
  request_id: string;
  session_id: string;
  tool: string;
  input: Record<string, unknown>;
  asked_at: string;
  resolve: (ans: { decision: "allow" | "deny"; scope?: "once" | "always" }) => void;
}

interface PendingQuestion {
  request_id: string;
  session_id: string;
  questions: {
    question: string;
    header: string;
    options: { label: string; description: string }[];
    multiple?: boolean;
    custom?: boolean;
  }[];
  asked_at: string;
  resolve: (ans: { decision: "reply" | "reject"; answers?: string[][] }) => void;
}

export interface RunningService {
  port: number;
  store: Store;
  stop: () => void;
}

export function startService(opts: ServiceOpts = {}): RunningService {
  const store = openStore(opts.db ?? ":memory:");
  const conns = new Map<string, BackendDriver>();
  // casf session id -> driver id, filled as sessions are indexed or created
  const owners = new Map<string, string>();
  // live policy: applies to every connection (hot-swapped via PUT /policy)
  let currentPolicy: Policy | undefined;
  const loadPolicyFile = (): Policy | undefined => {
    if (!opts.policyFile) return undefined;
    try {
      return loadPolicy(JSON.parse(readFileSync(opts.policyFile, "utf8")));
    } catch {
      return undefined;
    }
  };
  currentPolicy = loadPolicyFile();
  const persistPolicy = () => {
    if (!opts.policyFile) return;
    if (currentPolicy === undefined) {
      try {
        unlinkSync(opts.policyFile);
      } catch {
        // already gone
      }
      return;
    }
    mkdirSync(dirname(opts.policyFile), { recursive: true });
    writeFileSync(opts.policyFile, JSON.stringify(currentPolicy, null, 2) + "\n");
  };
  const pendingAsks = new Map<string, PendingAsk>();
  const pendingQuestions = new Map<string, PendingQuestion>();
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
    projectSession(store.read({ session_id: sessionId, limit: 20_000 }));

  const driverFor = (casfId: string): BackendDriver | undefined => {
    const owned = owners.get(casfId);
    if (owned) return conns.get(owned);
    if (conns.size === 1) return [...conns.values()][0];
    const backend = casfId.split(":")[0];
    const matches = [...conns.values()].filter((c) => c.backend === backend);
    return matches.length === 1 ? matches[0] : undefined;
  };

  const connectBackend = async (body: {
    backend?: string;
    baseUrl: string;
    name?: string;
    directory?: string;
    username?: string;
    password?: string;
    policy?: unknown;
    connectTimeoutMs?: number;
  }): Promise<{ id: string; indexed: number }> => {
    const backend = body.backend ?? "opencode";
    if (backend !== "opencode") throw new Error(`backend ${backend} is not registered`);
    const explicit: Policy | undefined = body.policy
      ? loadPolicy(body.policy)
      : undefined;
    const driver = await connectOpencodeDriver({
      sink: store,
      baseUrl: body.baseUrl,
      name: body.name,
      directory: body.directory,
      username: body.username,
      password: body.password,
      // per-connect policy wins; otherwise follow the live shared policy
      policy: explicit ? () => explicit : () => currentPolicy,
      connectTimeoutMs: body.connectTimeoutMs,
      onAsk: (req) => {
        store.append([req]);
        const data = req.data;
        return new Promise((resolve) =>
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
      onQuestion: (req) => {
        store.append([req]);
        const data = req.data;
        return new Promise((resolve) =>
          pendingQuestions.set(data.request_id, {
            request_id: data.request_id,
            session_id: req.session_id,
            questions: data.questions,
            asked_at: req.ts,
            resolve,
          }),
        );
      },
    });
    conns.set(driver.id, driver);
    let indexed: string[] = [];
    try {
      indexed = await driver.indexSessions();
      for (const casfId of indexed) owners.set(casfId, driver.id);
    } catch (e) {
      console.error(`index sessions on ${driver.id} failed: ${e}`);
    }
    return { id: driver.id, indexed: indexed.length };
  };

  // boot auto-connect (e.g. Tauri spawning `opencode serve` next to us):
  // the server takes a moment to come up, so retry until the deadline
  if (opts.autoConnect) {
    const baseUrl = opts.autoConnect;
    const deadline = Date.now() + (opts.autoConnectTimeoutMs ?? 15_000);
    void (async () => {
      for (;;) {
        try {
          const { id } = await connectBackend({
            baseUrl,
            username: opts.autoConnectUsername,
            password: opts.autoConnectPassword,
          });
          console.log(`auto-connected backend ${id}`);
          return;
        } catch (e) {
          if (Date.now() > deadline) {
            console.error(`auto-connect to ${baseUrl} gave up: ${e}`);
            return;
          }
          await Bun.sleep(750);
        }
      }
    })();
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    // projecting every session can outlast Bun's 10s default
    idleTimeout: 0,
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
          return {
            summary: s,
            status: v.status,
            busy: v.busy,
            totals: v.totals,
            title: v.title,
            parent: v.parent_session_id,
          };
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

      if (path === "/options" && req.method === "GET") {
        // model/agent pickers: merge every connected backend's lists
        const models: { providerID: string; modelID: string; name: string }[] = [];
        const agents: { name: string; mode?: string }[] = [];
        for (const conn of conns.values()) {
          try {
            models.push(...(await conn.listModels()));
            agents.push(...(await conn.listAgents()));
          } catch {
            // a backend that can't list options just contributes nothing
          }
        }
        return json({ models, agents });
      }

      const sessionMatch = path.match(/^\/sessions\/([^/]+)\/view$/);
      if (sessionMatch && req.method === "GET") {
        const sid = decodeURIComponent(sessionMatch[1]!);
        const untilSeq = url.searchParams.get("until_seq");
        if (untilSeq === null) return json(sessionView(sid));
        const n = Number(untilSeq);
        return json(
          projectSession(store.read({ session_id: sid }).filter((e) => e.seq <= n)),
        );
      }

      if (path === "/sessions" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          title?: string;
          connection_id?: string;
        };
        const conn = body.connection_id
          ? conns.get(body.connection_id)
          : [...conns.values()][0];
        if (!conn) return json({ error: "no backend connected" }, 400);
        if (!conn.capabilities.prompt) return json({ error: "backend cannot create sessions" }, 400);
        const created = await conn.createSession({ title: body.title });
        owners.set(created.casfId, conn.id);
        return json({ id: created.casfId, native_id: created.nativeId });
      }

      const sessionCmd = path.match(/^\/sessions\/([^/]+)\/(prompt|abort|import)$/);
      if (sessionCmd) {
        const casfId = decodeURIComponent(sessionCmd[1]!);
        const cmd = sessionCmd[2]!;
        const conn = driverFor(casfId);
        if (!conn) return json({ error: "no backend connected" }, 400);
        const native = conn.nativeId(casfId);
        if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
        owners.set(casfId, conn.id);
        if (cmd === "import" && req.method === "POST") {
          if (!conn.capabilities.import) return json({ error: "backend cannot import" }, 400);
          try {
            await conn.importSession(native);
            return json({ ok: true });
          } catch (e) {
            return json({ error: String(e) }, 502);
          }
        }
        if (cmd === "abort" && req.method === "POST") {
          if (!conn.capabilities.abort) return json({ error: "backend cannot abort" }, 400);
          try {
            await conn.abort(native);
            return json({ ok: true });
          } catch (e) {
            return json({ error: String(e) }, 502);
          }
        }
        if (cmd === "prompt" && req.method === "POST") {
          const body = (await req.json().catch(() => null)) as {
            text?: string;
            model?: { providerID: string; modelID: string };
            agent?: string;
            variant?: string;
          } | null;
          if (!body?.text) return json({ error: "text required" }, 400);
          try {
            await conn.prompt(native, body.text, {
              model: body.model,
              agent: body.agent,
              variant: body.variant,
            });
            return json({ ok: true });
          } catch (e) {
            return json({ error: String(e) }, 502);
          }
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
          name?: string;
          directory?: string;
          username?: string;
          password?: string;
          policy?: unknown;
          connectTimeoutMs?: number;
        } | null;
        if (!body?.baseUrl) return json({ error: "baseUrl required" }, 400);
        try {
          return json(await connectBackend({ ...body, baseUrl: body.baseUrl }));
        } catch (e) {
          return json({ error: String(e) }, 502);
        }
      }

      if (path === "/connections" && req.method === "GET") {
        return json({
          connections: [...conns.values()].map((c) => ({
            id: c.id,
            backend: c.backend,
            baseUrl: c.baseUrl,
            name: c.name,
            directory: c.directory,
            capabilities: c.capabilities,
          })),
        });
      }

      if (path === "/policy" && req.method === "GET") {
        return json({ policy: currentPolicy ?? null, file: opts.policyFile ?? null });
      }

      if (path === "/policy" && req.method === "PUT") {
        const body = (await req.json().catch(() => null)) as unknown;
        try {
          currentPolicy = loadPolicy(body);
        } catch (e) {
          return json({ error: String(e) }, 400);
        }
        persistPolicy();
        return json({ ok: true, policy: currentPolicy });
      }

      if (path === "/policy" && req.method === "DELETE") {
        currentPolicy = undefined;
        persistPolicy();
        return json({ ok: true });
      }

      if (path === "/policy/test" && req.method === "POST") {
        // dry-run the permission engine: body { tool, input, policy? } —
        // an inline policy is validated and used, else the live one
        const body = (await req.json().catch(() => null)) as {
          tool?: string;
          input?: Record<string, unknown>;
          policy?: unknown;
        } | null;
        if (!body?.tool) return json({ error: "tool required" }, 400);
        let p = currentPolicy;
        if (body.policy !== undefined) {
          try {
            p = loadPolicy(body.policy);
          } catch (e) {
            return json({ error: String(e) }, 400);
          }
        }
        if (!p) return json({ decision: "ask", reason: "no policy" });
        return json(evaluate(p, { tool: body.tool, input: body.input ?? {} }));
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

      if (path === "/questions" && req.method === "GET") {
        return json({
          pending: [...pendingQuestions.values()].map(({ resolve: _r, ...p }) => p),
        });
      }

      const questionMatch = path.match(/^\/questions\/([^/]+)\/respond$/);
      if (questionMatch && req.method === "POST") {
        const q = pendingQuestions.get(decodeURIComponent(questionMatch[1]!));
        if (!q) return json({ error: "no pending question" }, 404);
        const body = (await req.json().catch(() => ({}))) as {
          decision?: string;
          answers?: string[][];
        };
        pendingQuestions.delete(q.request_id);
        q.resolve({
          decision: body.decision === "reject" ? "reject" : "reply",
          answers: body.answers,
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
  const policyFile =
    process.env.STRATA_POLICY ?? `${process.env.HOME}/.agent-strata/policy.json`;
  const svc = startService({
    db,
    port,
    policyFile,
    // e.g. STRATA_OPENCODE_URL=http://127.0.0.1:4096 (Tauri embed sets this)
    autoConnect: process.env.STRATA_OPENCODE_URL,
    autoConnectUsername: process.env.STRATA_OPENCODE_USERNAME,
    autoConnectPassword: process.env.STRATA_OPENCODE_PASSWORD,
  });
  console.log(`agent-strata service listening on http://127.0.0.1:${svc.port} (db: ${db})`);
}
