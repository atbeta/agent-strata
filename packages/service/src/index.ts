// Local HTTP service exposing the agent-strata horizontal layer to UIs.
// The desktop shell (Tauri) runs this as a sidecar and talks to it over
// localhost. One store file, many backend connections, SSE fan-out to clients.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openStore, type Store, type EventQuery } from "@agent-strata/store";
import { projectSession, aggregate, emptySessionView, type SessionView } from "@agent-strata/projector";
import { compareSessions, exportEvents } from "@agent-strata/core";
import { autoAccept, evaluate, loadPolicy, type Policy } from "@agent-strata/policy";
import { UnknownCommandError } from "@agent-strata/adapter-opencode";
import type { BackendDriver, BackendSink, ModelChoice, PromptPart } from "./driver";
import { connectOpencodeDriver } from "./opencode-driver";
import { LiveOverlay } from "./live";
import { filesKeyOf, ViewCache } from "./views";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { goalContinuation, lastAssistantText, sessionAwaiting, shouldContinueGoal } from "./goal";
import { connectAcpDriver } from "./acp-driver";
import { bootPlan, REMEMBERED_PROBE_MS } from "./boot-connect";
import { connectionPhase, connectionPlacement } from "./connection-phase";
import { agentNameOf, connectionMemory, endpointOf, type ConnectBody } from "./connections";
import { extensionRoute } from "./extension-route";
import { mcpAddRequest, safeMcpError } from "./mcp-add";
import { mcpAuthCode, mcpAuthStartView } from "./mcp-auth";
import { providerRoute } from "./provider-auth";
import { readPromptParts } from "./prompt-parts";
import { editorLaunch } from "./editor";
import { refused, shellCors } from "./shell-origin";
import { terminalClose, terminalMessage, terminalOpen, terminalRoute, terminalUpgrade } from "./terminal";
import { SessionClaims } from "./identity";

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
  // directory holding desktop.json and opencode-status.json; default ~/.agent-strata
  desktopDir?: string;
}

interface PendingAsk {
  request_id: string;
  session_id: string;
  tool: string;
  input: Record<string, unknown>;
  asked_at: string;
  call_id?: string;
  resolve: (ans: { decision: "allow" | "deny"; scope?: "once" | "always"; external?: boolean }) => void;
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
  resolve: (ans: { decision: "reply" | "reject"; answers?: string[][]; external?: boolean }) => void;
}

export interface RunningService {
  port: number;
  store: Store;
  sink: BackendSink;
  stop: () => void;
}

export function startService(opts: ServiceOpts = {}): RunningService {
  const desktopDir = opts.desktopDir ?? join(homedir(), ".agent-strata");
  const store = openStore(opts.db ?? ":memory:");
  const conns = new Map<string, BackendDriver>();
  // casf session id -> driver id, filled as sessions are indexed or created
  const owners = new Map<string, string>();
  /** The directory a session was created in, kept until its first event
      lands — the view's `workspace` cannot come from events that do not
      exist yet. */
  const createdDirs = new Map<string, string>();
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
  /**
   * Sessions left on "stop asking me", by casf id.
   *
   * A set rather than a stored policy on purpose: the answer is derived from
   * the live one every time it is needed, so a session on auto keeps following
   * the shared rules as they are edited instead of freezing a copy of them the
   * moment the switch was flipped. A reader who then tightens a rule sees it
   * take effect in the session they already switched off.
   */
  const autoSessions = new Set<string>();
  const modeOf = (sessionID: string): "auto" | "inherit" =>
    autoSessions.has(sessionID) ? "auto" : "inherit";
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
  const subscribers = new Set<(payload: unknown) => void>();
  const broadcast = (payload: unknown) => {
    for (const fn of subscribers) fn(payload);
  };
  const live = new LiveOverlay();
  const views = new ViewCache(store);
  // A continuation already handed to the backend, waiting until that run shows
  // as busy. Without it, the idle that accepted the prompt sends another one.
  const goalKicked = new Set<string>();
  // The user aborted. The idle that follows is them stopping, not the run ending.
  const goalPaused = new Set<string>();
  store.subscribe((e) => {
    live.settle(e);
    broadcast(e);
    if (e.type === "session.status" && e.data.state === "busy") goalKicked.delete(e.session_id);
    if (e.type === "session.status" && e.data.state === "idle") considerGoal(e.session_id);
    if (e.type === "permission.resolved" || e.type === "question.resolved") considerGoal(e.session_id);
  });
  const claims = new SessionClaims();
  // Every channel a backend writes through ends here, so this is the one place
  // that can tell a second copy of a session from the session itself.
  const unshadowed = (events: EventInput[]) =>
    events.filter((e) => !claims.shadowed(e.source, e.session_id));
  const sink: BackendSink = {
    append: (events) => store.append(unshadowed(events)),
    publish: (events) => {
      for (const e of unshadowed(events)) if (live.put(e)) broadcast(e);
    },
    replaceSession: (sessionId, events, replace) => {
      if (events.some((e) => claims.shadowed(e.source, sessionId))) return 0;
      const n = store.replaceSession(sessionId, events, replace);
      views.drop(sessionId);
      broadcast({ type: "session.rebuilt", session_id: sessionId });
      return n;
    },
    markMapped: (sessionId, mapper) => store.markMapper(sessionId, mapper),
    sessionRevision: (sessionId) => store.sessionRevision(sessionId),
    markRevision: (sessionId, rev) => store.markRevision(sessionId, rev),
  };
  /**
   * Syncs currently running, for subscribers that attach mid-flight: the
   * startup sync fires `sync.started` before the app's stream socket exists,
   * and an event-only channel has no way to say "a sync is already going".
   * `/stream` replays this to every new subscriber.
   */
  const activeSyncs = new Map<string, { done: number; total: number }>();
  const syncDriver = (driver: BackendDriver) => {
    activeSyncs.set(driver.id, { done: 0, total: 0 });
    broadcast({ type: "sync.started", connection_id: driver.id });
    return driver
      .sync({
        stale: (casfId) =>
          driver.mapperVersion !== undefined && store.sessionMapper(casfId) !== driver.mapperVersion,
        taken: (casfId) => {
          const native = driver.nativeId(casfId);
          return (
            native !== undefined &&
            claims.shadowed({ backend: driver.agent, native_id: native }, casfId)
          );
        },
        claimed: (casfId) => owners.set(casfId, driver.id),
        progress: (done, total) => {
          activeSyncs.set(driver.id, { done, total });
          broadcast({ type: "sync.progress", connection_id: driver.id, done, total });
        },
      })
      .finally(() => {
        activeSyncs.delete(driver.id);
        broadcast({ type: "sync.finished", connection_id: driver.id });
      });
  };

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });

  const sessionView = (sessionId: string): SessionView => {
    try {
      if (!live.has(sessionId)) return views.view(sessionId);
      const stored = views.events(sessionId);
      return projectSession([...stored, ...live.events(sessionId, stored.at(-1)?.seq ?? 0)]);
    } catch (e) {
      // A session just created owns an id before its first event lands. That
      // gap used to surface as a 500 and the reader painted its "service
      // unreachable" frame for a beat on every new session.
      if (e instanceof Error && e.message === "no events" && owners.has(sessionId)) {
        return { ...emptySessionView(sessionId, sessionId.split(":")[0]!), workspace: createdDirs.get(sessionId) };
      }
      throw e;
    }
  };

  const directoryOf = (casfId: string): string | undefined => {
    try {
      const ws = sessionView(casfId).workspace;
      if (ws && ws !== "unknown" && ws !== "no workspace") return ws;
    } catch {
      // session has no events yet
    }
    return undefined;
  };

  const driverFor = (casfId: string): BackendDriver | undefined => {
    const owned = owners.get(casfId);
    if (owned) return conns.get(owned);
    if (conns.size === 1) return [...conns.values()][0];
    const backend = casfId.split(":")[0];
    const matches = [...conns.values()].filter((c) => c.backend === backend);
    return matches.length === 1 ? matches[0] : undefined;
  };

  const parentOf = (casfId: string): string | undefined => {
    try {
      return sessionView(casfId).parent_session_id;
    } catch {
      // a session with no events yet has no parent to read
      return undefined;
    }
  };

  const settledAsks = new Map<string, "allow" | "deny">();
  const rememberAsk = (id: string, decision: "allow" | "deny") => {
    settledAsks.set(id, decision);
    if (settledAsks.size <= 1000) return;
    let extra = settledAsks.size - 800;
    for (const key of settledAsks.keys()) {
      settledAsks.delete(key);
      if (--extra <= 0) break;
    }
  };
  const onAsk = (req: Extract<EventInput, { type: "permission.requested" }>) => {
    store.append([req]);
    const data = req.data;
    const known = settledAsks.get(data.request_id);
    // A second copy of an ask that is already on screen, or already answered,
    // must not open another prompt or reply to OpenCode again.
    if (known || pendingAsks.has(data.request_id)) {
      return Promise.resolve({ decision: known ?? "allow", external: true as const });
    }
    return new Promise<{ decision: "allow" | "deny"; scope?: "once" | "always"; external?: boolean }>((resolve) =>
      pendingAsks.set(data.request_id, {
        request_id: data.request_id,
        session_id: req.session_id,
        tool: data.tool,
        input: data.input,
        call_id: data.call_id,
        asked_at: req.ts,
        resolve,
      }),
    );
  };
  const settleAsk = (requestId: string, decision: "allow" | "deny") => {
    rememberAsk(requestId, decision);
    const ask = pendingAsks.get(requestId);
    if (!ask) return;
    pendingAsks.delete(requestId);
    ask.resolve({ decision, external: true });
  };
  const onQuestion = (req: Extract<EventInput, { type: "question.asked" }>) => {
    store.append([req]);
    const data = req.data;
    return new Promise<{ decision: "reply" | "reject"; answers?: string[][]; external?: boolean }>(
      (resolve) =>
        pendingQuestions.set(data.request_id, {
          request_id: data.request_id,
          session_id: req.session_id,
          questions: data.questions,
          asked_at: req.ts,
          resolve,
        }),
    );
  };
  /** Answered on another client — drop our card without replying again. */
  const settleQuestion = (requestId: string) => {
    const q = pendingQuestions.get(requestId);
    if (!q) return;
    pendingQuestions.delete(requestId);
    q.resolve({ decision: "reply", external: true });
  };

  const GOAL_MAX = 4_000;
  function considerGoal(sessionId: string) {
    let view: SessionView;
    try {
      view = sessionView(sessionId);
    } catch {
      return;
    }
    const pending =
      sessionAwaiting(view) ||
      [...pendingAsks.values()].some((ask) => ask.session_id === sessionId) ||
      [...pendingQuestions.values()].some((q) => q.session_id === sessionId);
    if (
      !shouldContinueGoal({
        goal: view.goal,
        busy: view.busy,
        status: view.status,
        deleted: view.deleted,
        archived: view.archived,
        pending,
        paused: goalPaused.has(sessionId),
        kicked: goalKicked.has(sessionId),
        lastAssistant: lastAssistantText(view.turns),
      })
    ) {
      return;
    }
    const conn = driverFor(sessionId);
    const native = conn?.nativeId(sessionId);
    if (!conn || !native || !conn.capabilities.prompt || !view.goal) return;
    const text = goalContinuation(view.goal);
    goalKicked.add(sessionId);
    void conn.prompt(native, [{ type: "text", text }], { directory: directoryOf(sessionId) }).catch((err) => {
      goalKicked.delete(sessionId);
      console.error("goal continuation failed:", err);
    });
  }

  /**
   * Which session is still waiting on this question, according to the log.
   *
   * The live map knows only about questions this process saw. The log knows all
   * of them, and it is the one a restarted service can still read — which is
   * the whole difference between answering a question after a restart and being
   * told there is nothing to answer.
   */
  const sessionIdOfPendingQuestion = (requestId: string): string | undefined => {
    for (const summary of store.listSessions({ limit: 500 })) {
      const view = sessionView(summary.session_id);
      if (view.pending_questions.some((q) => q.request_id === requestId)) return summary.session_id;
    }
    return undefined;
  };

  /** Tell the backend an answer, for a question this process did not receive. */
  const replyQuestion = async (
    sessionId: string,
    requestId: string,
    decision: "reply" | "reject",
    answers?: string[][],
  ) => {
    const conn = driverFor(sessionId);
    if (!conn) return;
    const directory = directoryOf(sessionId);
    if (decision === "reject") await conn.rejectQuestion?.(requestId, directory);
    else await conn.replyQuestion?.(requestId, answers ?? [], directory);
  };
  const memory = connectionMemory(opts.db);

  /**
   * Boot and the periodic reconnect share one record.
   *
   * A failure used to be a `console.error` and then nothing: the window had
   * connected last time, the address was gone, and the only visible state was
   * the same "nothing is connected" as a person who had never connected.
   * `retrying` is owned by the boot loop until it gives up. A shorter probe
   * from `/sync` must not overwrite it, or the first poll would report the
   * address dead while boot was still waiting for an embedded server.
   */
  const attempts = new Map<
    string,
    { endpoint: string; backend: string; phase: "retrying" | "failed"; error?: string }
  >();
  const beginAttempt = (body: ConnectBody) => {
    const endpoint = endpointOf(body);
    attempts.set(endpoint, { endpoint, backend: body.backend ?? "opencode", phase: "retrying" });
  };
  const failAttempt = (body: ConnectBody, error: unknown, settle: boolean) => {
    const endpoint = endpointOf(body);
    const current = attempts.get(endpoint);
    if (current?.phase === "retrying" && !settle) return;
    const message = error instanceof Error ? error.message : String(error);
    attempts.set(endpoint, {
      endpoint,
      backend: body.backend ?? "opencode",
      phase: "failed",
      error: message.slice(0, 240),
    });
  };
  const finishAttempt = (endpoint: string) => {
    attempts.delete(endpoint);
  };

  const inflightConnects = new Map<string, Promise<{ id: string; indexed: number }>>();
  const connectBackend = (body: ConnectBody): Promise<{ id: string; indexed: number }> => {
    const key = endpointOf(body);
    const pending = inflightConnects.get(key);
    if (pending) return pending;
    const job = connectOnce(body).finally(() => inflightConnects.delete(key));
    inflightConnects.set(key, job);
    return job;
  };
  const connectOnce = async (body: ConnectBody): Promise<{ id: string; indexed: number }> => {
    const backend = body.backend ?? "opencode";
    const endpoint = endpointOf(body);
    const already = [...conns.values()].find((c) => c.baseUrl === endpoint);
    if (already) {
      finishAttempt(endpoint);
      void syncDriver(already).catch((e) => console.error(`sync ${already.id} failed: ${e}`));
      return { id: already.id, indexed: 0 };
    }
    const explicit: Policy | undefined = body.policy ? loadPolicy(body.policy) : undefined;
    // Per-connect policy wins; otherwise follow the live shared policy — unless
    // this session was left on auto, which softens the shared fallback rather
    // than replacing the document, so the reader's own rules still apply.
    const shared = explicit ? () => explicit : () => currentPolicy;
    /**
     * Whether this session was left on auto — or any session it descends from.
     *
     * A subagent is part of the conversation that opened it: the reader put
     * *that* session on auto, and the work it delegated is the work they meant.
     * Reading the stance from the child alone made the switch stop at the
     * subagent, whose ask then waited in a session the sidebar hides — the run
     * went nowhere and there was nothing on screen to answer.
     */
    const autoStance = (sessionID: string): boolean => {
      let id: string | undefined = sessionID;
      for (let hops = 0; id && hops < 8; hops++) {
        if (autoSessions.has(id)) return true;
        id = parentOf(id);
      }
      return false;
    };
    const policy = (sessionID: string): Policy | undefined => {
      const base = shared();
      if (!autoStance(sessionID)) return base;
      // No shared document means there is nothing to soften, not nothing to
      // do — the stance still answers "do not ask me here".
      return autoAccept(base ?? { version: 1, default: "ask", rules: [] });
    };
    let driver: BackendDriver;
    if (backend === "opencode") {
      if (!body.baseUrl) throw new Error("baseUrl required");
      driver = await connectOpencodeDriver({
        sink,
        baseUrl: body.baseUrl,
        name: body.name,
        directory: body.directory,
        username: body.username,
        password: body.password,
        policy,
        connectTimeoutMs: body.connectTimeoutMs,
        onAsk,
        onQuestion,
        onSettled: settleAsk,
        onQuestionSettled: settleQuestion,
      });
    } else if (backend === "acp") {
      if (!body.command) throw new Error("command required");
      driver = await connectAcpDriver({
        sink,
        command: body.command,
        args: body.args,
        cwd: body.cwd ?? body.directory,
        agentName: body.agentName ?? agentNameOf(body.command),
        name: body.name,
        policy,
        onAsk,
      });
    } else {
      throw new Error(`backend ${backend} is not registered`);
    }
    conns.set(driver.id, driver);
    let indexed: string[] = [];
    try {
      indexed = await driver.indexSessions();
      for (const casfId of indexed) owners.set(casfId, driver.id);
    } catch (e) {
      console.error(`index sessions on ${driver.id} failed: ${e}`);
    }
    void syncDriver(driver).catch((e) => console.error(`sync ${driver.id} failed: ${e}`));
    finishAttempt(endpoint);
    return { id: driver.id, indexed: indexed.length };
  };

  // boot auto-connect. The address we mean to use retries until the deadline
  // (an embedded server may still be starting). Every other remembered address
  // is probed once, so a dead one does not sit on the connect timeout.
  const boot: ConnectBody[] = opts.autoConnect
    ? [
        {
          baseUrl: opts.autoConnect,
          username: opts.autoConnectUsername,
          password: opts.autoConnectPassword,
        },
        ...memory.saved().filter((c) => endpointOf(c) !== opts.autoConnect),
      ]
    : memory.saved();
  for (const { body, mode } of bootPlan(boot, opts.autoConnect)) {
    const endpoint = endpointOf(body);
    const deadline = Date.now() + (opts.autoConnectTimeoutMs ?? 15_000);
    beginAttempt(body);
    void (async () => {
      for (;;) {
        try {
          const { id } = await connectBackend(
            mode === "once" ? { ...body, connectTimeoutMs: REMEMBERED_PROBE_MS } : body,
          );
          memory.remember(body);
          console.log(`auto-connected backend ${id}`);
          return;
        } catch (e) {
          if (mode === "once" || Date.now() > deadline) {
            console.error(`auto-connect to ${endpoint} gave up: ${e}`);
            failAttempt(body, e, true);
            return;
          }
          await Bun.sleep(750);
        }
      }
    })();
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") return json({ ok: true, conns: conns.size });

    if (path === "/sessions" && req.method === "GET") {
      const summaries = store.listSessions({
        backend: url.searchParams.get("backend") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 200),
      });
      const askSessions = new Set([...pendingAsks.values()].map((p) => p.session_id));
      const rows = summaries.map((summary) => ({ summary, view: sessionView(summary.session_id) }));
      // From the projection, not from `pendingQuestions`. That map only holds
      // what arrived over a live connection since this process started, so it
      // forgets everything the moment the service restarts — and a question
      // someone is still looking at does not become answered because the app
      // was closed. The projector reads the event log, which remembers.
      const waiting = new Set(askSessions);
      for (const { summary, view: v } of rows) {
        if (v.pending_questions.length > 0) waiting.add(summary.session_id);
      }
      // A session whose subagent is waiting is waiting too. The run the reader
      // started is the run that cannot move, and the subagent's own row is not
      // in the sidebar — leaving the parent out of it means a conversation
      // nothing can advance draws as an ordinary idle row.
      const parentRow = new Map(rows.map(({ summary, view: v }) => [summary.session_id, v.parent_session_id]));
      const needsInput = new Set(waiting);
      for (const sid of waiting) {
        let up = parentRow.get(sid);
        for (let hops = 0; up && hops < 8; hops++) {
          if (needsInput.has(up)) break;
          needsInput.add(up);
          up = parentRow.get(up);
        }
      }
      const sessions = rows.map(({ summary, view: v }) => ({
        summary,
        status: v.status,
        busy: v.busy,
        totals: v.totals,
        title: v.title,
        workspace: v.workspace,
        parent: v.parent_session_id,
        archived: v.archived === true,
        deleted: v.deleted === true,
        needs_input: needsInput.has(summary.session_id),
        // Which connection owns it, resolved the same way the per-session
        // commands resolve it, so a label in the UI cannot disagree with where
        // the prompt actually goes. Absent when no connected backend claims it.
        connection_id: driverFor(summary.session_id)?.id,
      }));
      return json({ sessions, aggregate: aggregate(rows.map((r) => r.view)) });
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
      const models: ModelChoice[] = [];
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
      const tail = url.searchParams.get("tail");
      if (tail !== null) {
        const v = sessionView(sid);
        const n = Math.max(1, Math.floor(Number(tail)) || 1);
        const offset = Math.max(0, v.turns.length - n);
        const key = filesKeyOf(v);
        const { files_changed, ...rest } = v;
        return json({
          ...rest,
          turns: v.turns.slice(offset),
          turn_offset: offset,
          prev_turn_id: offset > 0 ? v.turns[offset - 1]!.turn_id : null,
          files_key: key,
          ...(url.searchParams.get("files_key") === key ? {} : { files_changed }),
        });
      }
      const untilSeq = url.searchParams.get("until_seq");
      if (untilSeq === null) {
        // A live partial is not part of the stored record, so it cannot be
        // served from the serialized body. Tail and replay reads slice the
        // projection themselves and never touch that body.
        if (!live.has(sid)) {
          try {
            return new Response(views.viewBody(sid), {
              headers: { "content-type": "application/json" },
            });
          } catch {
            // Zero events yet — sessionView knows when that is a real session.
            return json(sessionView(sid));
          }
        }
        return json(sessionView(sid));
      }
      const n = Number(untilSeq);
      try {
        return json(
          projectSession(views.events(sid).filter((e) => e.seq <= n)),
        );
      } catch {
        return json(sessionView(sid));
      }
    }

    const sessionSearch = path.match(/^\/sessions\/([^/]+)\/search$/);
    if (sessionSearch && req.method === "GET") {
      const sid = decodeURIComponent(sessionSearch[1]!);
      const q = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 300);
      // FTS has been sitting in the store the whole time without a route to
      // reach it. A transcript is too long to scan by eye, and the transcript
      // view no longer holds every row in the DOM to let Ctrl+F find them, so
      // this is how a reader locates anything now.
      //
      // Ask for one more than we will return. A truncated result set that
      // reports itself as the whole list is worse than no search at all: the
      // reader would stop looking at a term that still has matches further
      // down a 1,500-turn session.
      const found = store.search(q, { session_id: sid, limit: limit + 1 });
      const hits = found.slice(0, limit).map(({ event, snippet }) => {
        const d = event.data as { turn_id?: unknown; call_id?: unknown };
        return {
          seq: event.seq,
          ts: event.ts,
          type: event.type,
          turn_id: typeof d.turn_id === "string" ? d.turn_id : null,
          // A tool result names its call, not its turn — the projector binds
          // the two. Handing the call id along lets the reader's transcript
          // resolve it against the tool_calls it already holds, instead of
          // making this route replay the projection to find out.
          call_id: typeof d.call_id === "string" ? d.call_id : null,
          snippet,
        };
      });
      return json({ hits, more: found.length > limit });
    }

    if (path === "/sessions" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        title?: string;
        directory?: string;
        connection_id?: string;
      };
      const conn = body.connection_id
        ? conns.get(body.connection_id)
        : [...conns.values()][0];
      if (!conn) return json({ error: "no backend connected" }, 400);
      if (!conn.capabilities.prompt) return json({ error: "backend cannot create sessions" }, 400);
      const created = await conn.createSession({ title: body.title, directory: body.directory });
      owners.set(created.casfId, conn.id);
      if (body.directory) createdDirs.set(created.casfId, body.directory);
      // The channel that hands the user a session is the one that owns it, so
      // another channel onto the same agent leaves this session alone.
      claims.claim(`${conn.agent}:${created.nativeId}`, created.casfId, conn.id);
      return json({ id: created.casfId, native_id: created.nativeId });
    }

    const capsMatch = path.match(/^\/sessions\/([^/]+)\/capabilities$/);
    if (capsMatch && req.method === "GET") {
      let casfId: string;
      try {
        casfId = decodeURIComponent(capsMatch[1]!);
      } catch {
        return json({ error: "not found" }, 404);
      }
      const conn = driverFor(casfId);
      if (!conn?.nativeId(casfId)) return json({ connected: false });
      const c = conn.capabilities;
      return json({
        connected: true,
        prompt: c.prompt,
        abort: c.abort,
        commands: c.commands === true,
        attachments: c.attachments === true,
        manage: c.manage === true,
        ...(c.revert ? { revert: true } : {}),
        ...(c.fork ? { fork: true } : {}),
        ...(c.summarize ? { summarize: true } : {}),
        ...(c.share ? { share: true } : {}),
        ...(conn.extension ? { extension: conn.extension.kind } : {}),
      });
    }

    const sessionCmd = path.match(/^\/sessions\/([^/]+)\/(prompt|command|abort|import|rebuild|rename|archive)$/);
    if (sessionCmd) {
      const casfId = decodeURIComponent(sessionCmd[1]!);
      const cmd = sessionCmd[2]!;
      const conn = driverFor(casfId);
      if (!conn) return json({ error: "no backend connected" }, 400);
      const native = conn.nativeId(casfId);
      if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
      owners.set(casfId, conn.id);
      const directory = directoryOf(casfId);
      if (cmd === "import" && req.method === "POST") {
        if (!conn.capabilities.import) return json({ error: "backend cannot import" }, 400);
        try {
          await conn.importSession(native, directory);
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e) }, 502);
        }
      }
      if (cmd === "rebuild" && req.method === "POST") {
        if (!conn.capabilities.import) return json({ error: "backend cannot rebuild" }, 400);
        try {
          const events = await conn.rebuild(native, directory);
          return json({ ok: true, events });
        } catch (e) {
          return json({ error: String(e) }, 502);
        }
      }
      if (cmd === "abort" && req.method === "POST") {
        if (!conn.capabilities.abort) return json({ error: "backend cannot abort" }, 400);
        goalPaused.add(casfId);
        try {
          await conn.abort(native, directory);
          return json({ ok: true });
        } catch (e) {
          goalPaused.delete(casfId);
          return json({ error: String(e) }, 502);
        }
      }
      if ((cmd === "rename" || cmd === "archive") && req.method === "POST") {
        if (!conn.capabilities.manage) return json({ error: "backend cannot manage sessions" }, 400);
        try {
          if (cmd === "archive") await conn.archive(native, directory);
          else {
            const body = (await req.json().catch(() => null)) as { title?: string } | null;
            const title = body?.title?.trim();
            if (!title) return json({ error: "title required" }, 400);
            await conn.rename(native, title, directory);
          }
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e) }, 502);
        }
      }
      if (cmd === "prompt" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          parts?: unknown;
          text?: unknown;
          model?: { providerID: string; modelID: string };
          agent?: string;
          variant?: string;
        } | null;
        const parts = readPromptParts(body);
        if (!Array.isArray(parts)) return json(parts, 400);
        if (!conn.capabilities.attachments && parts.some((p) => p.type !== "text"))
          return json({ error: "backend cannot take files or attachments" }, 400);
        if (parts.some((p) => p.type === "file_ref") && !(directory ?? conn.directory))
          return json({ error: "session has no workspace to read files from" }, 400);
        goalPaused.delete(casfId);
        try {
          await conn.prompt(native, parts, {
            model: body?.model,
            agent: body?.agent,
            variant: body?.variant,
            directory,
          });
          return json({ ok: true });
        } catch (e) {
          return json({ error: String(e) }, 502);
        }
      }
      if (cmd === "command" && req.method === "POST") {
        if (!conn.capabilities.commands || !conn.command) return json({ error: "backend cannot run commands" }, 400);
        const body = (await req.json().catch(() => null)) as {
          command?: unknown;
          arguments?: unknown;
          parts?: unknown;
          model?: { providerID: string; modelID: string };
          agent?: string;
          variant?: string;
        } | null;
        if (typeof body?.command !== "string" || !body.command) return json({ error: "command required" }, 400);
        let parts: PromptPart[] | undefined;
        if (body.parts !== undefined) {
          const read = readPromptParts({ parts: body.parts });
          if (!Array.isArray(read)) return json(read, 400);
          if (read.some((p) => p.type === "text")) return json({ error: "a command takes its words as arguments" }, 400);
          if (!conn.capabilities.attachments && read.some((p) => p.type !== "text"))
            return json({ error: "backend cannot take files or attachments" }, 400);
          if (read.some((p) => p.type === "file_ref") && !(directory ?? conn.directory))
            return json({ error: "session has no workspace to read files from" }, 400);
          parts = read;
        }
        try {
          await conn.command(native, body.command, typeof body.arguments === "string" ? body.arguments : "", {
            parts,
            model: body.model,
            agent: body.agent,
            variant: body.variant,
            directory,
          });
          return json({ ok: true });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof UnknownCommandError ? 400 : 502);
        }
      }
    }

    const sessionMcpAdd = path.match(/^\/sessions\/([^/]+)\/mcp$/);
    if (sessionMcpAdd && req.method === "POST") {
      const casfId = decodeURIComponent(sessionMcpAdd[1]!);
      const conn = driverFor(casfId);
      if (!conn) return json({ error: "no backend connected" }, 400);
      const native = conn.nativeId(casfId);
      if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
      owners.set(casfId, conn.id);
      if (conn.backend !== "opencode" || !conn.mcpAdd) return json({ error: "backend cannot manage mcp" }, 400);
      const parsed = mcpAddRequest(await req.json().catch(() => null));
      if ("error" in parsed) return json(parsed, 400);
      try {
        await conn.mcpAdd(parsed.name, parsed.config, directoryOf(casfId));
        return json({ ok: true });
      } catch (e) {
        const secret =
          parsed.config.type === "remote" ? { url: parsed.config.url } : { command: parsed.config.command };
        return json({ error: safeMcpError(e, secret) }, 502);
      }
    }

    const sessionMcpAuth = path.match(/^\/sessions\/([^/]+)\/mcp\/([^/]+)\/auth(\/callback)?$/);
    if (sessionMcpAuth && req.method === "POST") {
      const casfId = decodeURIComponent(sessionMcpAuth[1]!);
      const conn = driverFor(casfId);
      if (!conn) return json({ error: "no backend connected" }, 400);
      const native = conn.nativeId(casfId);
      if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
      owners.set(casfId, conn.id);
      if (conn.backend !== "opencode" || !conn.mcpAuthStart || !conn.mcpAuthFinish) {
        return json({ error: "backend cannot manage mcp" }, 400);
      }
      let name: string;
      try {
        name = decodeURIComponent(sessionMcpAuth[2]!);
      } catch {
        return json({ error: "invalid name" }, 400);
      }
      if (!name || name.includes("/") || name.includes("..")) return json({ error: "invalid name" }, 400);
      const callback = sessionMcpAuth[3] === "/callback";
      const body = callback ? ((await req.json().catch(() => null)) as { code?: unknown } | null) : null;
      const code = callback ? mcpAuthCode(body?.code) : undefined;
      if (callback && !code) return json({ error: "code required" }, 400);
      try {
        if (!callback) {
          const started = await conn.mcpAuthStart(name, directoryOf(casfId), req.signal);
          return json(mcpAuthStartView(started));
        }
        await conn.mcpAuthFinish(name, code!, directoryOf(casfId), req.signal);
        return json({ ok: true });
      } catch (e) {
        return json({ error: safeMcpError(e, { command: code ? [code] : [] }) }, 502);
      }
    }

    const sessionMcp = path.match(/^\/sessions\/([^/]+)\/mcp\/([^/]+)\/(connect|disconnect)$/);
    if (sessionMcp && req.method === "POST") {
      const casfId = decodeURIComponent(sessionMcp[1]!);
      const conn = driverFor(casfId);
      if (!conn) return json({ error: "no backend connected" }, 400);
      const native = conn.nativeId(casfId);
      if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
      owners.set(casfId, conn.id);
      let name: string;
      try {
        name = decodeURIComponent(sessionMcp[2]!);
      } catch {
        return json({ error: "invalid name" }, 400);
      }
      if (!name || name.includes("/")) return json({ error: "invalid name" }, 400);
      const fn = sessionMcp[3] === "connect" ? conn.mcpConnect : conn.mcpDisconnect;
      if (conn.backend !== "opencode" || !fn) return json({ error: "backend cannot manage mcp" }, 400);
      try {
        await fn(name, directoryOf(casfId));
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const sessionRevert = path.match(/^\/sessions\/([^/]+)\/revert$/);
    if (sessionRevert && req.method === "POST") {
      const casfId = decodeURIComponent(sessionRevert[1]!);
      const conn = driverFor(casfId);
      if (!conn) return json({ error: "no backend connected" }, 400);
      const native = conn.nativeId(casfId);
      if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
      owners.set(casfId, conn.id);
      if (!conn.capabilities.revert || !conn.revert) return json({ error: "backend cannot revert" }, 400);
      const body = (await req.json().catch(() => null)) as { message_id?: unknown } | null;
      const messageId = typeof body?.message_id === "string" ? body.message_id : "";
      if (!messageId) return json({ error: "message_id required" }, 400);
      try {
        await conn.revert(native, messageId, directoryOf(casfId));
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const sessionUnrevert = path.match(/^\/sessions\/([^/]+)\/unrevert$/);
    if (sessionUnrevert && req.method === "POST") {
      const casfId = decodeURIComponent(sessionUnrevert[1]!);
      const conn = driverFor(casfId);
      if (!conn) return json({ error: "no backend connected" }, 400);
      const native = conn.nativeId(casfId);
      if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
      owners.set(casfId, conn.id);
      if (!conn.capabilities.revert || !conn.unrevert) return json({ error: "backend cannot revert" }, 400);
      try {
        await conn.unrevert(native, directoryOf(casfId));
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const sessionFork = path.match(/^\/sessions\/([^/]+)\/fork$/);
    if (sessionFork && req.method === "POST") {
      const casfId = decodeURIComponent(sessionFork[1]!);
      const conn = driverFor(casfId);
      if (!conn) return json({ error: "no backend connected" }, 400);
      const native = conn.nativeId(casfId);
      if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
      owners.set(casfId, conn.id);
      if (!conn.capabilities.fork || !conn.fork) return json({ error: "backend cannot fork" }, 400);
      const body = (await req.json().catch(() => null)) as { message_id?: unknown } | null;
      const messageId = typeof body?.message_id === "string" ? body.message_id : "";
      if (!messageId) return json({ error: "message_id required" }, 400);
      try {
        const created = await conn.fork(native, messageId, directoryOf(casfId));
        owners.set(created.casfId, conn.id);
        claims.claim(`${conn.agent}:${created.nativeId}`, created.casfId, conn.id);
        return json({ id: created.casfId });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const sessionSummarize = path.match(/^\/sessions\/([^/]+)\/summarize$/);
    if (sessionSummarize && req.method === "POST") {
      const casfId = decodeURIComponent(sessionSummarize[1]!);
      const conn = driverFor(casfId);
      if (!conn) return json({ error: "no backend connected" }, 400);
      const native = conn.nativeId(casfId);
      if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
      owners.set(casfId, conn.id);
      if (!conn.capabilities.summarize || !conn.summarize) return json({ error: "backend cannot summarize" }, 400);
      const body = (await req.json().catch(() => null)) as {
        model?: { providerID?: unknown; modelID?: unknown };
      } | null;
      const model =
        typeof body?.model?.providerID === "string" &&
        typeof body.model.modelID === "string" &&
        body.model.providerID &&
        body.model.modelID
          ? { providerID: body.model.providerID, modelID: body.model.modelID }
          : undefined;
      try {
        await conn.summarize(native, directoryOf(casfId), model);
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const sessionShare = path.match(/^\/sessions\/([^/]+)\/(share|unshare)$/);
    if (sessionShare && req.method === "POST") {
      const casfId = decodeURIComponent(sessionShare[1]!);
      const action = sessionShare[2]!;
      const conn = driverFor(casfId);
      if (!conn) return json({ error: "no backend connected" }, 400);
      const native = conn.nativeId(casfId);
      if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
      owners.set(casfId, conn.id);
      if (!conn.capabilities.share || !conn.share || !conn.unshare)
        return json({ error: "backend cannot share sessions" }, 400);
      try {
        if (action === "share") return json({ url: (await conn.share(native, directoryOf(casfId))) ?? null });
        await conn.unshare(native, directoryOf(casfId));
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    const sessionDelete = path.match(/^\/sessions\/([^/]+)$/);
    if (sessionDelete && req.method === "DELETE") {
      const casfId = decodeURIComponent(sessionDelete[1]!);
      const conn = driverFor(casfId);
      if (!conn) return json({ error: "no backend connected" }, 400);
      if (!conn.capabilities.manage) return json({ error: "backend cannot manage sessions" }, 400);
      const native = conn.nativeId(casfId);
      if (!native) return json({ error: "session is not owned by a connected backend" }, 400);
      try {
        await conn.deleteSession(native, directoryOf(casfId));
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    if (path === "/workspaces" && req.method === "GET") {
      const dirs = new Map<string, { directory: string; name?: string }>();
      for (const conn of conns.values()) {
        try {
          for (const w of await conn.listWorkspaces()) {
            if (w.directory && !dirs.has(w.directory)) {
              dirs.set(w.directory, { directory: w.directory, name: w.name });
            }
          }
        } catch {
          // a backend that cannot list projects still contributes its sessions
        }
      }
      for (const s of store.listSessions({ limit: 500 })) {
        const ws = s.workspace;
        if (ws && ws !== "unknown" && ws !== "no workspace" && !dirs.has(ws)) {
          dirs.set(ws, { directory: ws });
        }
      }
      return json({ workspaces: [...dirs.values()] });
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
      const body = (await req.json().catch(() => null)) as ConnectBody | null;
      if (!body?.baseUrl && !body?.command) return json({ error: "baseUrl or command required" }, 400);
      try {
        const connected = await connectBackend(body);
        memory.remember(body);
        return json(connected);
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    if (path === "/sync" && req.method === "POST") {
      if (conns.size === 0) {
        await Promise.all(
          memory.saved().map(async (saved) => {
            try {
              await connectBackend({ ...saved, connectTimeoutMs: REMEMBERED_PROBE_MS });
            } catch (e) {
              console.error(`reconnect ${endpointOf(saved)} failed: ${e}`);
              failAttempt(saved, e, false);
            }
          }),
        );
      }
      if (conns.size === 0) return json({ connected: false, imported: 0 });
      let imported = 0;
      for (const conn of conns.values()) {
        try {
          imported += await syncDriver(conn);
        } catch (e) {
          console.error(`sync ${conn.id} failed: ${e}`);
        }
      }
      return json({ connected: true, imported });
    }

    if (path === "/connections" && req.method === "GET") {
      const launch = readOpencodeStatus(desktopDir);
      const listed = [...attempts.values()].map((attempt) => ({
        ...attempt,
        placement: connectionPlacement(attempt.backend, attempt.endpoint, launch),
      }));
      const connections = [...conns.values()].map((c) => ({
        id: c.id,
        backend: c.backend,
        baseUrl: c.baseUrl,
        name: c.name,
        directory: c.directory,
        capabilities: { ...c.capabilities, extension: c.extension?.kind },
        placement: connectionPlacement(c.backend, c.baseUrl, launch),
      }));
      return json({
        connections,
        attempts: listed,
        phase: connectionPhase({
          connected: connections.length > 0,
          attempts: listed,
          launchState: launch.state,
        }),
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

    /**
     * Whether one session stops asking.
     *
     * The shared policy is the whole answer for every session, so this carries
     * one bit and no rules: the reader has said "do not interrupt me here", not
     * "here is a different policy". The effective document is derived, so the
     * session keeps following edits to the shared one — a rule tightened later
     * reaches a session that is already on auto.
     *
     * Not persisted, and deliberately: it is a stance about a conversation
     * being in progress, and a service that came back up should not find a
     * week-old session still running unattended.
     */
    const sessionPolicyMatch = path.match(/^\/sessions\/([^/]+)\/policy$/);
    if (sessionPolicyMatch) {
      const sid = decodeURIComponent(sessionPolicyMatch[1]!);
      const known = store.lastSeq(sid) > 0;
      if (req.method === "GET") {
        return json({ mode: modeOf(sid), session_id: sid, known });
      }
      if (req.method === "PUT") {
        const body = (await req.json().catch(() => null)) as { mode?: string } | null;
        if (body?.mode === "auto") autoSessions.add(sid);
        else if (body?.mode === "inherit" || body?.mode === undefined) autoSessions.delete(sid);
        else return json({ error: "mode must be auto or inherit" }, 400);
        broadcast({ type: "session.policy", session_id: sid, mode: modeOf(sid) });
        return json({ ok: true, mode: modeOf(sid), session_id: sid });
      }
      if (req.method === "DELETE") {
        autoSessions.delete(sid);
        broadcast({ type: "session.policy", session_id: sid, mode: "inherit" });
        return json({ ok: true, mode: "inherit", session_id: sid });
      }
    }

    const sessionGoal = path.match(/^\/sessions\/([^/]+)\/goal$/);
    if (sessionGoal) {
      let sid: string;
      try {
        sid = decodeURIComponent(sessionGoal[1]!);
      } catch {
        return json({ error: "not found" }, 404);
      }
      if (store.lastSeq(sid) <= 0) return json({ error: "not found" }, 404);
      if (req.method === "GET") {
        let text: string | null = null;
        try {
          text = sessionView(sid).goal ?? null;
        } catch {
          text = null;
        }
        return json({ text, session_id: sid });
      }
      if (req.method === "DELETE") {
        store.append([
          makeEvent({
            session_id: sid,
            source: { backend: "desktop" },
            type: "session.goal",
            data: { text: null },
          }) as EventInput,
        ]);
        goalPaused.delete(sid);
        goalKicked.delete(sid);
        return json({ ok: true, text: null, session_id: sid });
      }
      if (req.method === "PUT") {
        const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) return json({ error: "text required" }, 400);
        if (text.length > GOAL_MAX) return json({ error: "text is too long" }, 400);
        store.append([
          makeEvent({
            session_id: sid,
            source: { backend: "desktop" },
            type: "session.goal",
            data: { text },
          }) as EventInput,
        ]);
        goalPaused.delete(sid);
        goalKicked.delete(sid);
        considerGoal(sid);
        return json({ ok: true, text, session_id: sid });
      }
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
      const decision = body.decision === "deny" ? "deny" : "allow";
      pendingAsks.delete(ask.request_id);
      rememberAsk(ask.request_id, decision);
      ask.resolve({
        decision,
        scope: body.scope,
      });
      return json({ ok: true });
    }

    if (path === "/questions" && req.method === "GET") {
      // Read from the projection rather than from `pendingQuestions`. That map
      // is what a live connection writes into, so it only knows about questions
      // asked since this process started — and it is a map of promises, which
      // cannot be rebuilt from a restart. A question someone is still looking at
      // does not stop being asked because the window was closed, and this
      // endpoint is the only thing telling the UI that it is waiting on an
      // answer.
      const ids = store
        .listSessions({ limit: Number(url.searchParams.get("limit") ?? 200) })
        .map((s) => s.session_id);
      const pending = ids.flatMap((session_id) =>
        sessionView(session_id).pending_questions.map((q) => ({ ...q, session_id })),
      );
      return json({ pending });
    }

    const questionMatch = path.match(/^\/questions\/([^/]+)\/respond$/);
    if (questionMatch && req.method === "POST") {
      const requestId = decodeURIComponent(questionMatch[1]!);
      const q = pendingQuestions.get(requestId);
      const body = (await req.json().catch(() => ({}))) as {
        decision?: string;
        answers?: string[][];
      };
      const decision = body.decision === "reject" ? "reject" : "reply";
      if (q) {
        pendingQuestions.delete(q.request_id);
        q.resolve({ decision, answers: body.answers });
        return json({ ok: true });
      }
      // Not in the map — the service restarted while the question was still
      // open, so there is no promise to resolve. That does not make the answer
      // wrong. It is recorded against the session that asked it, which is what
      // the projection reads and therefore what retires the card; and the
      // backend is told directly, because it is the one holding the turn.
      const sessionId = sessionIdOfPendingQuestion(requestId);
      if (!sessionId) return json({ error: "no pending question" }, 404);
      store.append([
        makeEvent({
          session_id: sessionId,
          source: { backend: "desktop" },
          type: "question.resolved",
          data: { request_id: requestId, decision, answers: body.answers },
        }) as EventInput,
      ]);
      await replyQuestion(sessionId, requestId, decision, body.answers).catch((err) =>
        console.error("question reply failed:", err),
      );
      return json({ ok: true });
    }

    if (path === "/desktop/editor" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { editor?: unknown; path?: unknown } | null;
      const target = editorLaunch(body?.editor, body?.path);
      if ("error" in target) return json({ error: target.error }, 400);
      const bin = Bun.which(target.bin);
      if (!bin) return json({ error: "editor is not installed" }, 400);
      try {
        Bun.spawn({ cmd: [bin, target.file], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
      return json({ ok: true });
    }

    if (path === "/desktop/opencode" && req.method === "GET") {
      return json(readOpencodeStatus(desktopDir));
    }

    if (path === "/desktop/opencode" && req.method === "PUT") {
      const body = (await req.json().catch(() => null)) as { mode?: unknown } | null;
      const mode = body?.mode;
      if (!isOpencodeMode(mode)) return json({ error: "mode must be embed or external" }, 400);
      mkdirSync(desktopDir, { recursive: true });
      writeFileSync(join(desktopDir, "desktop.json"), JSON.stringify({ opencode: mode }));
      return json({ mode, applied: "next-launch" });
    }

    const terminal = await terminalRoute(req, url, ownedTerminal);
    if (terminal) return terminal;

    const providers = await providerRoute(req, path, (id) => conns.get(id)?.extension?.providers);
    if (providers) return providers;

    const extension = await extensionRoute(req, url, {
      connection: (id) => conns.get(id),
      session: (casfId) => {
        const driver = driverFor(casfId);
        // the same ownership a prompt needs: a driver that maps this session id
        if (!driver?.nativeId(casfId)) return undefined;
        const directory = directoryOf(casfId);
        return directory ? { driver, directory } : undefined;
      },
    });
    if (extension) return extension;

    if (path === "/connections/forget" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
      const endpoint = body?.endpoint;
      if (typeof endpoint !== "string" || endpoint.length === 0) {
        return json({ error: "endpoint required" }, 400);
      }
      memory.forget(endpoint);
      attempts.delete(endpoint);
      return json({ ok: true });
    }

    const discMatch = path.match(/^\/connections\/([^/]+)$/);
    if (discMatch && req.method === "DELETE") {
      const conn = conns.get(decodeURIComponent(discMatch[1]!));
      if (!conn) return json({ error: "not found" }, 404);
      conn.stop();
      conns.delete(conn.id);
      // Its sessions go back to the layer, so another channel may import them.
      claims.release(conn.id);
      memory.forget(conn.baseUrl);
      return json({ ok: true });
    }

    if (path === "/stream") {
      let enqueue: ((payload: unknown) => void) | undefined;
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
          // A sync that began before this socket attached would otherwise be
          // invisible until the next round — replay its state as a started
          // event carrying the progress seen so far.
          for (const [connection_id, s] of activeSyncs) {
            write(
              `data: ${JSON.stringify({ type: "sync.started", connection_id, done: s.done, total: s.total })}\n\n`,
            );
          }
          // comment-frame heartbeat: keeps proxies flushing the stream and
          // surfaces dead connections so stale subscribers get reaped
          heartbeat = setInterval(() => write(`: hb\n\n`), 15_000);
          enqueue = (payload) => write(`data: ${JSON.stringify(payload)}\n\n`);
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
  }

  const ownedTerminal = (casfId: string) => {
    const driver = driverFor(casfId);
    const terminal = driver?.extension?.terminal;
    if (!driver?.nativeId(casfId) || !terminal) return undefined;
    const directory = directoryOf(casfId);
    return directory ? { directory, terminal } : undefined;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    // projecting every session can outlast Bun's 10s default
    idleTimeout: 0,
    websocket: {
      open: terminalOpen,
      message: terminalMessage,
      close: terminalClose,
    },
    async fetch(req, server) {
      // The desktop UI calls this process from the shell's origin (packaged:
      // tauri.localhost; dev: the Vite port); no other page may drive it.
      const allow = {
        vary: "origin",
        "x-content-type-options": "nosniff",
        ...shellCors(req.headers.get("origin")),
      };
      if (refused(req)) return Response.json({ error: "forbidden" }, { status: 403, headers: allow });
      if (req.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            ...allow,
            "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        });
      const upgraded = terminalUpgrade(req, new URL(req.url), server, ownedTerminal);
      if (upgraded === "upgraded") return undefined;
      let res: Response;
      try {
        res = upgraded ?? (await route(req));
      } catch (e) {
        // Bun's own error page has no CORS, so the shell would only see a network error
        res = json({ error: String(e) }, 500);
      }
      for (const [k, v] of Object.entries(allow)) res.headers.set(k, v);
      return res;
    },
  });

  return {
    port: server.port ?? (opts.port ?? 0),
    store,
    sink,
    stop: () => {
      for (const c of conns.values()) c.stop();
      server.stop();
      store.close();
    },
  };
}

type OpencodeLaunchMode = "embed" | "external";
type OpencodeLaunchState =
  | "starting"
  | "running"
  | "missing"
  | "restarting"
  | "stopped"
  | "external"
  | "unmanaged";

function isOpencodeMode(value: unknown): value is OpencodeLaunchMode {
  return value === "embed" || value === "external";
}

function isOpencodeState(value: unknown): value is OpencodeLaunchState {
  return (
    value === "starting" ||
    value === "running" ||
    value === "missing" ||
    value === "restarting" ||
    value === "stopped" ||
    value === "external" ||
    value === "unmanaged"
  );
}

function readDesktopJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readOpencodeMode(dir: string): OpencodeLaunchMode {
  const parsed = readDesktopJson(join(dir, "desktop.json"));
  if (parsed && typeof parsed === "object" && parsed !== null) {
    const mode = (parsed as { opencode?: unknown }).opencode;
    if (isOpencodeMode(mode)) return mode;
  }
  return "embed";
}

function readOpencodeStatus(dir: string): {
  mode: OpencodeLaunchMode;
  state: OpencodeLaunchState;
  url?: string;
} {
  const mode = readOpencodeMode(dir);
  const parsed = readDesktopJson(join(dir, "opencode-status.json"));
  if (!parsed || typeof parsed !== "object" || parsed === null) return { mode, state: "unmanaged" };
  const rec = parsed as { state?: unknown; url?: unknown };
  if (!isOpencodeState(rec.state)) return { mode, state: "unmanaged" };
  const body: { mode: OpencodeLaunchMode; state: OpencodeLaunchState; url?: string } = {
    mode,
    state: rec.state,
  };
  if (typeof rec.url === "string") body.url = rec.url;
  return body;
}

function userHome(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && home.length > 0 ? home : ".";
}

if (import.meta.main) {
  const home = userHome();
  const db = process.env.STRATA_DB ?? join(home, ".agent-strata", "events.db");
  const port = Number(process.env.STRATA_PORT ?? 7700);
  const policyFile = process.env.STRATA_POLICY ?? join(home, ".agent-strata", "policy.json");
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
