// Local HTTP service exposing the agent-strata horizontal layer to UIs.
// The desktop shell (Tauri) runs this as a sidecar and talks to it over
// localhost. One store file, many backend connections, SSE fan-out to clients.

import { existsSync, mkdirSync, readFileSync, unlinkSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openStore, type Store } from "@agent-strata/store";
import { emptySessionView, projectSession, type SessionView } from "@agent-strata/projector";
import { loadPolicy, type Policy } from "@agent-strata/policy";
import { createAuthorizer } from "./authorization";
import { createPolicyRuntime } from "./policy-runtime";
import { policyRoute } from "./policy-routes";
import { PermissionRequests } from "./permission-requests";
import { ConnectionRegistry } from "./connection-registry";
import { GoalRunner } from "./goal-runner";
import type { BackendDriver, BackendSink } from "./driver";
import { connectOpencodeDriver } from "./opencode-driver";
import { LiveOverlay } from "./live";
import { ViewCache } from "./views";
import { type EventInput } from "@agent-strata/schema";
import { connectAcpDriver } from "./acp-driver";
import { bootPlan, REMEMBERED_PROBE_MS } from "./boot-connect";
import { sameEndpoint } from "./connection-phase";
import { connectionRoute, type ConnectionAttempt } from "./connection-routes";
import {
  agentNameOf,
  connectionMemory,
  endpointOf,
  looksEmbedded,
  type ConnectBody,
} from "./connections";
import { extensionRoute } from "./extension-route";
import { providerRoute } from "./provider-auth";
import { availableBackupName, fileInfo, listBackups, listLegacy, maintenanceDirs } from "./maintenance";
import { maintenanceRoute } from "./maintenance-routes";
import { refused, shellCors } from "./shell-origin";
import { queryTokenOk, readApiToken, tokenOk } from "./api-token";
import { writeSecureJson } from "./secure-write";
import { terminalClose, terminalMessage, terminalOpen, terminalRoute, terminalUpgrade } from "./terminal";
import { pathInside } from "./path-inside";
import { PluginHost, type RegisteredPlugin } from "./plugins/host";
import { builtinPlugins } from "./plugins/builtin";
import { pluginRoute } from "./plugins/routes";
import { mcpRoute } from "./plugins/mcp";
import { createMcpTickets } from "./plugins/tickets";
import { SessionClaims } from "./identity";
import { promptRoute } from "./prompt-routes";
import { sessionRoute } from "./session-routes";
import { eventRoute } from "./event-routes";
import { desktopRoute } from "./desktop-routes";
import { workspaceRoute } from "./workspace-routes";
import {
  autoConnectPlacement,
  readOpencodeMode,
  readOpencodeStatus,
  readWorktreeRoot,
} from "./opencode-status";

function logLine(message: string, data?: unknown): string {
  if (data === undefined) return message;
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    text = String(data);
  }
  return text.length > 2_000 ? `${message} ${text.slice(0, 2_000)}…` : `${message} ${text}`;
}

const MAX_REQUEST_BODY_BYTES = 80 * 1024 * 1024;

export interface ServiceOpts {
  db?: string;
  port?: number;
  // the capability token every request has to present; unset means no check
  apiToken?: string;
  // optional JSON file the live policy is loaded from / persisted to
  policyFile?: string;
  // backend baseUrl to connect on boot, retried until autoConnectTimeoutMs.
  // username/password are the HTTP basic pair for `opencode serve`.
  autoConnect?: string;
  autoConnectUsername?: string;
  autoConnectPassword?: string;
  autoConnectTimeoutMs?: number;
  // whether autoConnect is the server the app starts, or one someone else runs
  autoConnectPlacement?: "embed" | "external";
  // directory holding desktop.json and opencode-status.json; default ~/.agent-strata
  desktopDir?: string;
  /**
   * Plugins to register on top of the builtins.
   *
   * The seam exists because the reference plugin (`echo`) is a test fixture:
   * registering it here rather than in `builtinPlugins` keeps a proof of the
   * architecture out of what a user installs, while still letting the suite
   * exercise the real routes.
   */
  plugins?: RegisteredPlugin[];
}

export interface RunningService {
  port: number;
  store: Store;
  sink: BackendSink;
  stop: () => void;
}

function extFor(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const known: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "application/json": ".json",
  };
  return known[base] ?? "";
}

export function startService(opts: ServiceOpts = {}): RunningService {
  // STRATA_DESKTOP_DIR exists mostly for tests: without it a suite on a dev
  // machine reads the real ~/.agent-strata — a running embedded server there
  // is a real backend the reconcile would happily connect to.
  const desktopDir = opts.desktopDir ?? process.env.STRATA_DESKTOP_DIR ?? join(homedir(), ".agent-strata");
  const apiToken = readApiToken(opts);
  const store = openStore(opts.db ?? ":memory:");
  let stopped = false;
  const conns = new ConnectionRegistry();
  const createdDirs = new Map<string, string>();
  const knownDirs = async (): Promise<Map<string, { directory: string; name?: string }>> => {
    const dirs = new Map<string, { directory: string; name?: string }>();
    for (const conn of conns.values()) {
      try {
        for (const workspace of await conn.listWorkspaces()) {
          if (workspace.directory && !dirs.has(workspace.directory)) {
            dirs.set(workspace.directory, { directory: workspace.directory, name: workspace.name });
          }
        }
      } catch {
        // a backend that cannot list projects still contributes its sessions
      }
    }
    for (const summary of store.listSessions()) {
      const workspace = summary.workspace;
      if (workspace && workspace !== "unknown" && workspace !== "no workspace" && !dirs.has(workspace)) {
        dirs.set(workspace, { directory: workspace });
      }
    }
    return dirs;
  };
  const loadPolicyFile = (): Policy | undefined => {
    if (!opts.policyFile) return undefined;
    try {
      return loadPolicy(JSON.parse(readFileSync(opts.policyFile, "utf8")));
    } catch {
      return undefined;
    }
  };
  const policyRuntime = createPolicyRuntime(loadPolicyFile(), (sessionId) => parentOf(sessionId));
  const policyForSession = policyRuntime.policyForSession;
  const persistPolicy = () => {
    if (!opts.policyFile) return;
    if (policyRuntime.shared === undefined) {
      try {
        unlinkSync(opts.policyFile);
      } catch {
        // already gone
      }
      return;
    }
    mkdirSync(dirname(opts.policyFile), { recursive: true });
    writeSecureJson(opts.policyFile, policyRuntime.shared);
  };
  const permissionRequests = new PermissionRequests({
    store,
    sessionView: (sessionId) => sessionView(sessionId),
    driverFor: (sessionId) => driverFor(sessionId),
    directoryOf: (sessionId) => directoryOf(sessionId),
  });
  const goalRunner = new GoalRunner({
    store,
    sessionView: (sessionId) => sessionView(sessionId),
    driverFor: (sessionId) => driverFor(sessionId),
    directoryOf: (sessionId) => directoryOf(sessionId),
    hasPending: (sessionId) => permissionRequests.hasPending(sessionId),
  });
  const subscribers = new Set<(payload: unknown) => void>();
  const broadcast = (payload: unknown) => {
    for (const fn of subscribers) fn(payload);
  };
  const live = new LiveOverlay();
  const views = new ViewCache(store);
  const plugins = new PluginHost({
    dataDir: desktopDir,
    logger: {
      info: (message, data) => console.log(logLine(message, data)),
      warn: (message, data) => console.warn(logLine(message, data)),
      error: (message, data) => console.error(logLine(message, data)),
    },
    workspaceOf: (sessionId) => directoryOf(sessionId) ?? driverFor(sessionId)?.directory,
    resolveSession: (given) => resolveSessionId(given),
    pendingCall: (sessionId, toolName) => {
      try {
        const view = sessionView(sessionId);
        let found: { call_id: string; ts?: string } | undefined;
        for (const turn of view.turns) {
          for (const call of turn.tool_calls) {
            if (call.tool !== toolName || call.status !== "pending") continue;
            found = { call_id: call.call_id, ts: call.ts };
          }
        }
        return found?.call_id;
      } catch {
        return undefined;
      }
    },
    onStreamEvent: (event) => broadcast(event),
    onProgress: (progress) => {
      broadcast({
        type: "tool.progress",
        session_id: progress.session_id,
        plugin_id: progress.plugin_id,
        tool: progress.tool,
        call_id: progress.call_id,
        message: progress.message,
        percent: progress.percent,
        data: progress.data,
      });
    },
  });
  for (const extra of opts.plugins ?? []) plugins.register(extra);
  for (const builtin of builtinPlugins({
    dataDir: desktopDir,
    workspaceOf: (sessionId) => directoryOf(sessionId) ?? driverFor(sessionId)?.directory,
  })) {
    plugins.register(builtin);
  }
  plugins.onChange(() => broadcast({ type: "plugins.changed" }));

  const mcpTickets = createMcpTickets({
    baseUrl: () => `http://127.0.0.1:${server.port ?? 0}`,
  });
  const maintenanceDirsInfo = maintenanceDirs(opts.db, desktopDir);
  const maintenanceSnapshot = () => {
    const dbPath = maintenanceDirsInfo.dbPath;
    const dbFile = dbPath ? fileInfo(dbPath) : undefined;
    const wal = dbPath ? fileInfo(`${dbPath}-wal`) : undefined;
    const shm = dbPath ? fileInfo(`${dbPath}-shm`) : undefined;
    return {
      db: {
        path: dbPath,
        bytes: dbFile?.bytes ?? 0,
        wal_bytes: wal?.bytes ?? 0,
        shm_bytes: shm?.bytes ?? 0,
        stats: store.stats(),
      },
      backups: listBackups(maintenanceDirsInfo.dir),
      legacy: listLegacy(maintenanceDirsInfo.dir),
    };
  };
  const backupBefore = (why: string): string | undefined => {
    if (!maintenanceDirsInfo.dbPath) return undefined;
    try {
      mkdirSync(maintenanceDirsInfo.backupDir, { recursive: true });
      const name = availableBackupName(maintenanceDirsInfo.dir);
      store.backupTo(join(maintenanceDirsInfo.backupDir, name));
      return name;
    } catch (error) {
      console.error(`could not back up before ${why}:`, error);
      return undefined;
    }
  };
  store.subscribe((event) => {
    live.settle(event);
    broadcast(event);
    goalRunner.handleEvent(event);
  });
  const claims = new SessionClaims();
  const unshadowed = (events: EventInput[]) =>
    events.filter((event) => !claims.shadowed(event.source, event.session_id));
  const sink: BackendSink = {
    append: (events) => store.append(unshadowed(events)),
    publish: (events) => {
      for (const event of unshadowed(events)) if (live.put(event)) broadcast(event);
    },
    replaceSession: (sessionId, events, replace) => {
      if (events.some((event) => claims.shadowed(event.source, sessionId))) return 0;
      const count = store.replaceSession(sessionId, events, replace);
      views.drop(sessionId);
      broadcast({ type: "session.rebuilt", session_id: sessionId });
      return count;
    },
    markMapped: (sessionId, mapper) => store.markMapper(sessionId, mapper),
    sessionRevision: (sessionId) => store.sessionRevision(sessionId),
    markRevision: (sessionId, revision) => store.markRevision(sessionId, revision),
    sessionRunning: (sessionId) => store.sessionRunning(sessionId),
    runningSessions: () => store.runningSessions(),
    spillAttachment: (mime, base64) => {
      try {
        const bytes = Buffer.from(base64, "base64");
        const id = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}${extFor(mime)}`;
        const dir = join(desktopDir, "attachments");
        const path = join(dir, id);
        if (!existsSync(path)) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(path, bytes, { mode: 0o600 });
        }
        return id;
      } catch (error) {
        console.error("could not keep a tool attachment:", error);
        return undefined;
      }
    },
  };
  const activeSyncs = new Map<string, { done: number; total: number }>();
  const pendingSyncs = new Set<string>();
  const syncDriver = (driver: BackendDriver) => {
    pendingSyncs.delete(driver.id);
    activeSyncs.set(driver.id, { done: 0, total: 0 });
    broadcast({ type: "sync.started", connection_id: driver.id });
    const reconciled = new Set<string>();
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
        claimed: (casfId) => conns.own(casfId, driver.id),
        local: () => {
          const gone = new Set(store.deletedSessions());
          const rows: { id: string; directory?: string }[] = [];
          for (const summary of store.listSessions({ backend: driver.agent })) {
            const id = driver.nativeId(summary.session_id);
            if (!id || gone.has(summary.session_id)) continue;
            if (claims.shadowed({ backend: driver.agent, native_id: id }, summary.session_id)) continue;
            rows.push({ id, directory: summary.workspace ?? undefined });
          }
          return rows;
        },
        reconciled: (casfId) => reconciled.add(casfId),
        progress: (done, total) => {
          activeSyncs.set(driver.id, { done, total });
          broadcast({ type: "sync.progress", connection_id: driver.id, done, total });
        },
      })
      .then((imported) => ({ imported, reconciled: reconciled.size }))
      .finally(() => {
        activeSyncs.delete(driver.id);
        pendingSyncs.delete(driver.id);
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
    } catch (error) {
      if (error instanceof Error && error.message === "no events" && conns.owns(sessionId)) {
        return {
          ...emptySessionView(sessionId, sessionId.split(":")[0]!),
          workspace: createdDirs.get(sessionId),
        };
      }
      throw error;
    }
  };

  const resolveSessionId = (given: string): string => conns.resolveSessionId(given);
  const authorize = createAuthorizer({
    policyFor(sessionId) {
      const source = policySourceFor(sessionId);
      return source ? source(sessionId) : policyForSession(sessionId);
    },
    askPermission(sessionId, tool, input) {
      return permissionRequests.askPermission(sessionId, tool, input);
    },
    audit(sessionId, tool, verdict) {
      console.log(
        `[plugin-audit] ${tool.name} session=${sessionId} decision=${verdict.decision}` +
          (verdict.rule_id ? ` rule=${verdict.rule_id}` : "") +
          (verdict.reason ? ` (${verdict.reason})` : ""),
      );
    },
  });

  const directoryOf = (casfId: string): string | undefined => {
    try {
      const workspace = sessionView(casfId).workspace;
      if (workspace && workspace !== "unknown" && workspace !== "no workspace") return workspace;
    } catch {
      // session has no events yet
    }
    return undefined;
  };
  const driverFor = (casfId: string): BackendDriver | undefined => conns.driverFor(casfId);
  const policySourceFor = (casfId: string): ((sessionId: string) => Policy | undefined) | undefined =>
    conns.policySourceFor(casfId);

  const settle = async (sessionId: string): Promise<void> => {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      try {
        if (!sessionView(sessionId).busy) return;
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };

  const releaseInside = async (dir: string): Promise<void> => {
    const disposed = new Set<string>();
    const terminalsClosed = new Set<string>();
    await plugins.releaseDirectory(dir);
    const sessions = store.listSessions();
    const parents = new Map<string, string | undefined>();
    for (const summary of sessions) {
      try {
        parents.set(summary.session_id, sessionView(summary.session_id).parent_session_id);
      } catch {
        // a session with no events yet has no parent to read
      }
    }
    const doomed = new Set(
      sessions.filter((summary) => summary.workspace && pathInside(dir, summary.workspace)).map((summary) => summary.session_id),
    );
    let grew = doomed.size > 0;
    while (grew) {
      grew = false;
      for (const summary of sessions) {
        const parent = parents.get(summary.session_id);
        if (parent && doomed.has(parent) && !doomed.has(summary.session_id)) {
          doomed.add(summary.session_id);
          grew = true;
        }
      }
    }
    for (const summary of sessions) {
      if (!doomed.has(summary.session_id)) continue;
      const workspace =
        summary.workspace && summary.workspace !== "unknown" && summary.workspace !== "no workspace"
          ? summary.workspace
          : undefined;
      const inFolder = workspace !== undefined && pathInside(dir, workspace);
      const where = workspace ?? directoryOf(summary.session_id);
      goalRunner.pause(summary.session_id);
      const conn = driverFor(summary.session_id);
      if (!conn) continue;
      const terminal = conn.extension?.terminal;
      if (terminal && workspace && inFolder && !terminalsClosed.has(workspace)) {
        terminalsClosed.add(workspace);
        const shells = await terminal.list(workspace).catch(() => []);
        for (const shell of shells) await terminal.remove(workspace, shell.id).catch(() => {});
      }
      if (!conn.capabilities.abort) continue;
      const native = conn.nativeId(summary.session_id);
      if (!native) continue;
      await conn.abort(native, where).catch(() => {});
      await settle(summary.session_id);
      if (inFolder && workspace && !disposed.has(workspace)) {
        disposed.add(workspace);
        await conn.extension?.dispose?.(workspace).catch(() => {});
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  };

  const parentOf = (casfId: string): string | undefined => {
    try {
      return sessionView(casfId).parent_session_id;
    } catch {
      return undefined;
    }
  };
  const memory = connectionMemory(opts.db);
  const attempts = new Map<string, ConnectionAttempt>();
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
  const dismissedEmbedded = new Map<string, string>();
  const connectBackend = (body: ConnectBody): Promise<{ id: string; indexed: number }> => {
    if (stopped) return Promise.reject(new Error("service is stopped"));
    const key = endpointOf(body);
    const pending = inflightConnects.get(key);
    if (pending) return pending;
    const job = connectOnce(body).finally(() => inflightConnects.delete(key));
    inflightConnects.set(key, job);
    return job;
  };
  const connectOnce = async (body: ConnectBody): Promise<{ id: string; indexed: number }> => {
    if (stopped) throw new Error("service is stopped");
    const backend = body.backend ?? "opencode";
    const endpoint = endpointOf(body);
    const already = [...conns.values()].find((conn) => conn.baseUrl === endpoint);
    if (already) {
      finishAttempt(endpoint);
      pendingSyncs.add(already.id);
      void syncDriver(already).catch((error) => console.error(`sync ${already.id} failed: ${error}`));
      return { id: already.id, indexed: 0 };
    }
    const explicit: Policy | undefined = body.policy ? loadPolicy(body.policy) : undefined;
    const policy = policyRuntime.policyForConnection(explicit);
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
        onAsk: permissionRequests.onAsk,
        onQuestion: permissionRequests.onQuestion,
        onSettled: permissionRequests.settleAsk,
        onQuestionSettled: permissionRequests.settleQuestion,
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
        onAsk: permissionRequests.onAsk,
        openMcp: () => mcpTickets.open(),
      });
    } else {
      throw new Error(`backend ${backend} is not registered`);
    }
    if (stopped) {
      driver.stop();
      throw new Error("service is stopped");
    }
    conns.add(driver, policy, body.password);
    pendingSyncs.add(driver.id);
    let indexed: string[] = [];
    try {
      indexed = await driver.indexSessions();
      conns.ownMany(indexed, driver.id);
    } catch (error) {
      console.error(`index sessions on ${driver.id} failed: ${error}`);
    }
    if (stopped) {
      driver.stop();
      throw new Error("service is stopped");
    }
    void syncDriver(driver).catch((error) => console.error(`sync ${driver.id} failed: ${error}`));
    finishAttempt(endpoint);
    return { id: driver.id, indexed: indexed.length };
  };

  const withEmbeddedCredentials = (body: ConnectBody): ConnectBody => {
    if (body.password) return body;
    if (body.placement !== "embed" && body.credentials !== "opencode-status") return body;
    const status = readOpencodeStatus(desktopDir);
    if (!status.url || !status.username || !status.password) return body;
    if (!sameEndpoint(status.url, body.baseUrl ?? "")) return body;
    return { ...body, username: status.username, password: status.password };
  };

  const placement = autoConnectPlacement(opts, desktopDir);
  const remembered = memory.pruneEmbedded(placement, opts.autoConnect);
  const boot: ConnectBody[] = opts.autoConnect
    ? [
        {
          baseUrl: opts.autoConnect,
          username: opts.autoConnectUsername,
          password: opts.autoConnectPassword,
          placement,
        },
        ...remembered.filter((conn) => endpointOf(conn) !== opts.autoConnect).map(withEmbeddedCredentials),
      ]
    : remembered.map(withEmbeddedCredentials);
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
        } catch (error) {
          if (mode === "once" || Date.now() > deadline) {
            console.error(`auto-connect to ${endpoint} gave up: ${error}`);
            if (looksEmbedded(body)) {
              memory.forget(endpoint);
              attempts.delete(endpoint);
              return;
            }
            failAttempt(body, error, true);
            return;
          }
          await Bun.sleep(750);
        }
      }
    })();
  }

  const reconcileEmbedded = () => {
    if (stopped || readOpencodeMode(desktopDir) !== "embed") return;
    const status = readOpencodeStatus(desktopDir);
    const url = status.url;
    if (status.state !== "running" || !url || !status.username || !status.password) return;
    if (dismissedEmbedded.get(url) === status.password) return;
    const current = [...conns.values()].find((conn) => conn.baseUrl === url);
    if (current) {
      if (conns.passwordOf(current.id) === status.password) return;
      current.stop();
      conns.remove(current.id);
      claims.release(current.id);
    }
    if (attempts.has(url)) return;
    const body: ConnectBody = {
      baseUrl: url,
      username: status.username,
      password: status.password,
      placement: "embed",
      name: "embedded",
    };
    beginAttempt(body);
    void connectBackend(body)
      .then(() => memory.remember(body))
      .catch((error) => failAttempt(body, error, true));
  };
  const statusFile = join(desktopDir, "opencode-status.json");
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  const onStatusChange = () => {
    if (stopped) return;
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcileEmbedded, 200);
  };
  try {
    const statusWatcher = watchFile(statusFile, { interval: 200 }, onStatusChange);
    statusWatcher.unref();
  } catch {
    // No desktop directory to watch; the interval below still catches up.
  }
  const reconcilePoll = setInterval(reconcileEmbedded, 10_000);
  reconcilePoll.unref?.();
  reconcileEmbedded();

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/health") return json({ ok: true, conns: conns.size });

    const desktop = await desktopRoute(req, path, { desktopDir, knownDirs });
    if (desktop) return desktop;

    const session = await sessionRoute(req, path, {
      store,
      connections: conns,
      claims,
      permissions: permissionRequests,
      views,
      live,
      plugins,
      createdDirs,
      goalRunner,
      sessionView,
      directoryOf,
      driverFor,
      broadcast,
    });
    if (session) return session;

    const maintenance = await maintenanceRoute(req, path, {
      store,
      dirs: maintenanceDirsInfo,
      snapshot: maintenanceSnapshot,
      backupBefore,
      sessionView,
      views,
      broadcast,
    });
    if (maintenance) return maintenance;

    const events = await eventRoute(req, path, { store, sessionView, subscribers, activeSyncs });
    if (events) return events;

    const workspace = await workspaceRoute(req, path, {
      desktopDir,
      knownDirs,
      releaseInside,
      // Read per request: the setting lives in a file the settings page
      // writes, and a value captured at boot would be ignored until restart.
      worktreeRoot: () => readWorktreeRoot(desktopDir),
    });
    if (workspace) return workspace;

    const connection = await connectionRoute(req, path, {
      connections: conns,
      attempts,
      activeSyncs,
      pendingSyncs,
      desktopDir,
      memory,
      dismissedEmbedded,
      claims,
      connectBackend,
      withEmbeddedCredentials,
      syncDriver,
      failAttempt,
    });
    if (connection) return connection;

    const policy = await policyRoute(req, path, {
      runtime: policyRuntime,
      store,
      policyFile: opts.policyFile,
      persist: persistPolicy,
      broadcast,
    });
    if (policy) return policy;

    const prompted = await promptRoute(req, path, permissionRequests);
    if (prompted) return prompted;

    const terminal = await terminalRoute(req, url, ownedTerminal);
    if (terminal) return terminal;

    const pluginHit = await pluginRoute(req, url, {
      host: plugins,
      resolveSession: resolveSessionId,
      mcp: (request, target) =>
        mcpRoute(request, target, {
          host: plugins,
          tools: () => plugins.toolTable(),
          execute: async (pluginId, tool, sessionId, input, signal, callId) => {
            const found = plugins.resolveTool(pluginId, tool);
            if (!found) throw new Error(`no tool ${pluginId}_${tool}`);
            const verdict = await authorize(sessionId, found.entry, input);
            if (!verdict.allow) throw new Error(verdict.error);
            const result = await plugins.callTool(pluginId, tool, { callId, sessionId, input, signal });
            return { output: result.output, isError: result.isError };
          },
          sessionOf: (ticket) => mcpTickets.sessionOf(ticket),
          json,
        }),
      authorize,
      directoryOf,
      json,
      onChanged: (listener) => plugins.onChange(listener),
    });
    if (pluginHit) return pluginHit;

    const providers = await providerRoute(req, path, (id) => conns.get(id)?.extension?.providers);
    if (providers) return providers;

    const extension = await extensionRoute(req, url, {
      connection: (id) => conns.get(id),
      session: (casfId) => {
        const driver = driverFor(casfId);
        if (!driver?.nativeId(casfId)) return undefined;
        const directory = directoryOf(casfId);
        return directory ? { driver, directory } : undefined;
      },
    });
    if (extension) return extension;

    return json({ error: "not found" }, 404);
  }

  const ownedTerminal = (casfId: string) => {
    const driver = driverFor(casfId);
    const terminal = driver?.extension?.terminal;
    if (!driver?.nativeId(casfId) || !terminal) return undefined;
    const directory = directoryOf(casfId);
    return directory ? { directory, terminal } : undefined;
  };

  void plugins.startAll().catch((error: unknown) => {
    console.error("plugins failed to start:", error);
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    idleTimeout: 0,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    websocket: {
      open: terminalOpen,
      message: terminalMessage,
      close: terminalClose,
    },
    async fetch(req, server) {
      const allow = {
        vary: "origin",
        "x-content-type-options": "nosniff",
        ...shellCors(req.headers.get("origin")),
      };
      if (refused(req)) return Response.json({ error: "forbidden" }, { status: 403, headers: allow });
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            ...allow,
            "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
            "access-control-allow-headers": "authorization, x-strata-token, content-type",
          },
        });
      }
      const url = new URL(req.url);
      const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      const browserless =
        upgrade || url.pathname === "/stream" || /^\/plugins\/[a-z][a-z0-9-]*\/events$/.test(url.pathname);
      const ticketAuthorized = url.pathname === "/plugins/mcp";
      const authorized =
        tokenOk(req, apiToken) || (browserless && queryTokenOk(url, apiToken)) || ticketAuthorized;
      const health = req.method === "GET" && url.pathname === "/health";
      if (!health && !authorized) {
        return Response.json({ error: "unauthorized" }, { status: 401, headers: allow });
      }
      const declared = Number(req.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
        return Response.json({ error: "request body too large" }, { status: 413, headers: allow });
      }
      const upgraded = terminalUpgrade(req, url, server, ownedTerminal);
      if (upgraded === "upgraded") return undefined;
      let res: Response;
      try {
        res = upgraded ?? (await route(req));
      } catch (error) {
        res = json({ error: String(error) }, 500);
      }
      for (const [key, value] of Object.entries(allow)) res.headers.set(key, value);
      return res;
    },
  });

  return {
    port: server.port ?? (opts.port ?? 0),
    store,
    sink,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(reconcileTimer);
      clearInterval(reconcilePoll);
      unwatchFile(statusFile, onStatusChange);
      for (const conn of conns.values()) conn.stop();
      conns.clear();
      void plugins.stopAll();
      server.stop();
      store.close();
    },
  };
}

function userHome(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && home.length > 0 ? home : ".";
}

export function main(): void {
  const home = userHome();
  const db = process.env.STRATA_DB ?? join(home, ".agent-strata", "events.db");
  const port = Number(process.env.STRATA_PORT ?? 7700);
  const policyFile = process.env.STRATA_POLICY ?? join(home, ".agent-strata", "policy.json");
  const placement = process.env.STRATA_OPENCODE_PLACEMENT;
  try {
    const svc = startService({
      db,
      port,
      policyFile,
      apiToken: process.env.STRATA_API_TOKEN,
      autoConnect: process.env.STRATA_OPENCODE_URL,
      autoConnectUsername: process.env.STRATA_OPENCODE_USERNAME,
      autoConnectPassword: process.env.STRATA_OPENCODE_PASSWORD,
      autoConnectPlacement: placement === "embed" || placement === "external" ? placement : undefined,
    });
    console.log(`agent-strata service listening on http://127.0.0.1:${svc.port} (db: ${db})`);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

// `bun packages/service/src/index.ts` (tauri dev). The compiled sidecar does
// not use this: on Windows, bun --compile reports import.meta.main as false,
// so a binary that gated listen on the flag started, printed nothing, and
// exited. The shell then reported the port as taken.
if (import.meta.main) main();
