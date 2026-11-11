import { UnknownCommandError } from "@agent-strata/adapter-opencode";
import { sessionBriefing } from "@agent-strata/core";
import { aggregate, projectSession, runningShell, type SessionView } from "@agent-strata/projector";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import type { Store } from "@agent-strata/store";
import type { ConnectionRegistry } from "./connection-registry";
import type { BackendDriver, PromptPart } from "./driver";
import { forkBefore, forkTitle } from "./fork";
import type { GoalRunner } from "./goal-runner";
import type { SessionClaims } from "./identity";
import type { LiveOverlay } from "./live";
import { mcpAddRequest, safeMcpError } from "./mcp-add";
import { mcpAuthCode, mcpAuthStartView } from "./mcp-auth";
import type { PermissionRequests } from "./permission-requests";
import type { PluginHost } from "./plugins/host";
import { readPromptParts } from "./prompt-parts";
import { filesKeyOf, type ViewCache } from "./views";

export async function sessionRoute(
  req: Request,
  path: string,
  deps: {
    store: Store;
    connections: ConnectionRegistry;
    claims: SessionClaims;
    permissions: PermissionRequests;
    views: ViewCache;
    live: LiveOverlay;
    plugins: PluginHost;
    createdDirs: Map<string, string>;
    goalRunner: GoalRunner;
    sessionView(sessionId: string): SessionView;
    directoryOf(sessionId: string): string | undefined;
    driverFor(sessionId: string): BackendDriver | undefined;
    broadcast(payload: unknown): void;
  },
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const { store, connections } = deps;

  if (path === "/sessions" && req.method === "GET") {
    const requested = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1), 2000);
    const fetched = store.listSessions({
      backend: url.searchParams.get("backend") ?? undefined,
      limit: requested + 1,
    });
    const more = fetched.length > requested;
    const summaries = more ? fetched.slice(0, requested) : fetched;
    const askSessions = new Set([...deps.permissions.pendingAsks.values()].map((pending) => pending.session_id));
    const rows = summaries.map((summary) => ({ summary, view: deps.sessionView(summary.session_id) }));
    const waiting = new Set(askSessions);
    for (const { summary, view } of rows) {
      if (view.pending_questions.length > 0) waiting.add(summary.session_id);
    }
    const parentRow = new Map(rows.map(({ summary, view }) => [summary.session_id, view.parent_session_id]));
    const needsInput = new Set(waiting);
    for (const sessionId of waiting) {
      let parent = parentRow.get(sessionId);
      for (let hops = 0; parent && hops < 8; hops++) {
        if (needsInput.has(parent)) break;
        needsInput.add(parent);
        parent = parentRow.get(parent);
      }
    }
    const sessions = rows.map(({ summary, view }) => {
      const shell = runningShell(view);
      return {
        summary,
        status: view.status,
        busy: view.busy,
        retry: view.retry,
        compacting: view.compacting === true,
        session_error: view.session_error,
        totals: view.totals,
        title: view.title,
        workspace: view.workspace,
        parent: view.parent_session_id,
        archived: view.archived === true,
        deleted: view.deleted === true,
        needs_input: needsInput.has(summary.session_id),
        ...(shell ? { shell } : {}),
        connection_id: deps.driverFor(summary.session_id)?.id,
      };
    });
    return Response.json({ sessions, aggregate: aggregate(rows.map((row) => row.view)), more });
  }

  const sessionViewMatch = path.match(/^\/sessions\/([^/]+)\/view$/);
  if (sessionViewMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(sessionViewMatch[1]!);
    const tail = url.searchParams.get("tail");
    if (tail !== null) {
      const view = deps.sessionView(sessionId);
      const count = Math.max(1, Math.floor(Number(tail)) || 1);
      const offset = Math.max(0, view.turns.length - count);
      const key = filesKeyOf(view);
      const { files_changed, ...rest } = view;
      return Response.json({
        ...rest,
        turns: view.turns.slice(offset),
        turn_offset: offset,
        prev_turn_id: offset > 0 ? view.turns[offset - 1]!.turn_id : null,
        files_key: key,
        ...(url.searchParams.get("files_key") === key ? {} : { files_changed }),
      });
    }
    const untilSeq = url.searchParams.get("until_seq");
    if (untilSeq === null) {
      if (!deps.live.has(sessionId)) {
        try {
          return new Response(deps.views.viewBody(sessionId), {
            headers: { "content-type": "application/json" },
          });
        } catch {
          return Response.json(deps.sessionView(sessionId));
        }
      }
      return Response.json(deps.sessionView(sessionId));
    }
    const seq = Number(untilSeq);
    try {
      return Response.json(projectSession(deps.views.events(sessionId).filter((event) => event.seq <= seq)));
    } catch {
      return Response.json(deps.sessionView(sessionId));
    }
  }

  const sessionSearch = path.match(/^\/sessions\/([^/]+)\/search$/);
  if (sessionSearch && req.method === "GET") {
    const sessionId = decodeURIComponent(sessionSearch[1]!);
    const query = url.searchParams.get("q") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 300);
    const found = store.search(query, { session_id: sessionId, limit: limit + 1 });
    const hits = found.slice(0, limit).map(({ event, snippet }) => {
      const data = event.data as { turn_id?: unknown; call_id?: unknown };
      return {
        seq: event.seq,
        ts: event.ts,
        type: event.type,
        turn_id: typeof data.turn_id === "string" ? data.turn_id : null,
        call_id: typeof data.call_id === "string" ? data.call_id : null,
        snippet,
      };
    });
    return Response.json({ hits, more: found.length > limit });
  }

  if (path === "/sessions" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      title?: string;
      directory?: string;
      connection_id?: string;
    };
    const conn = body.connection_id
      ? connections.get(body.connection_id)
      : [...connections.values()][0];
    if (!conn) return Response.json({ error: "no backend connected" }, { status: 400 });
    if (!conn.capabilities.prompt) {
      return Response.json({ error: "backend cannot create sessions" }, { status: 400 });
    }
    const created = await conn.createSession({ title: body.title, directory: body.directory });
    connections.own(created.casfId, conn.id);
    if (body.directory) deps.createdDirs.set(created.casfId, body.directory);
    deps.claims.claim(`${conn.agent}:${created.nativeId}`, created.casfId, conn.id);
    return Response.json({ id: created.casfId, native_id: created.nativeId });
  }

  const capabilities = path.match(/^\/sessions\/([^/]+)\/capabilities$/);
  if (capabilities && req.method === "GET") {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(capabilities[1]!);
    } catch {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const conn = deps.driverFor(sessionId);
    if (!conn?.nativeId(sessionId)) return Response.json({ connected: false });
    const caps = conn.capabilities;
    return Response.json({
      connected: true,
      connection_id: conn.id,
      prompt: caps.prompt,
      abort: caps.abort,
      commands: caps.commands === true,
      shell: caps.shell === true,
      attachments: caps.attachments === true,
      manage: caps.manage === true,
      ...(caps.revert ? { revert: true } : {}),
      ...(caps.fork ? { fork: true } : {}),
      ...(caps.summarize ? { summarize: true } : {}),
      ...(caps.share ? { share: true } : {}),
      ...(conn.extension ? { extension: conn.extension.kind } : {}),
    });
  }

  const commandMatch = path.match(
    /^\/sessions\/([^/]+)\/(prompt|command|shell|abort|import|rebuild|rename|archive|unarchive)$/,
  );
  if (commandMatch) {
    const sessionId = decodeURIComponent(commandMatch[1]!);
    const command = commandMatch[2]!;
    const conn = deps.driverFor(sessionId);
    if (!conn) return Response.json({ error: "no backend connected" }, { status: 400 });
    const native = conn.nativeId(sessionId);
    if (!native) {
      return Response.json({ error: "session is not owned by a connected backend" }, { status: 400 });
    }
    connections.own(sessionId, conn.id);
    const directory = deps.directoryOf(sessionId);
    if (command === "import" && req.method === "POST") {
      if (!conn.capabilities.import) return Response.json({ error: "backend cannot import" }, { status: 400 });
      try {
        await conn.importSession(native, directory);
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 502 });
      }
    }
    if (command === "rebuild" && req.method === "POST") {
      if (!conn.capabilities.import) return Response.json({ error: "backend cannot rebuild" }, { status: 400 });
      try {
        const events = await conn.rebuild(native, directory);
        return Response.json({ ok: true, events });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 502 });
      }
    }
    if (command === "abort" && req.method === "POST") {
      if (!conn.capabilities.abort) return Response.json({ error: "backend cannot abort" }, { status: 400 });
      deps.goalRunner.pause(sessionId);
      try {
        await conn.abort(native, directory);
        return Response.json({ ok: true });
      } catch (error) {
        deps.goalRunner.allow(sessionId);
        return Response.json({ error: String(error) }, { status: 502 });
      }
    }
    if ((command === "rename" || command === "archive" || command === "unarchive") && req.method === "POST") {
      if (!conn.capabilities.manage) {
        return Response.json({ error: "backend cannot manage sessions" }, { status: 400 });
      }
      try {
        if (command === "archive" || command === "unarchive") {
          await conn.archive(native, directory, command === "archive");
          deps.broadcast({ type: "session.updated", session_id: sessionId });
        } else {
          const body = (await req.json().catch(() => null)) as { title?: string } | null;
          const title = body?.title?.trim();
          if (!title) return Response.json({ error: "title required" }, { status: 400 });
          await conn.rename(native, title, directory);
        }
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 502 });
      }
    }
    if (command === "prompt" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as {
        parts?: unknown;
        text?: unknown;
        model?: { providerID: string; modelID: string };
        agent?: string;
        variant?: string;
      } | null;
      const parts = readPromptParts(body);
      if (!Array.isArray(parts)) return Response.json(parts, { status: 400 });
      if (!conn.capabilities.attachments && parts.some((part) => part.type !== "text")) {
        return Response.json({ error: "backend cannot take files or attachments" }, { status: 400 });
      }
      if (parts.some((part) => part.type === "file_ref") && !(directory ?? conn.directory)) {
        return Response.json({ error: "session has no workspace to read files from" }, { status: 400 });
      }
      deps.goalRunner.allow(sessionId);
      try {
        await conn.prompt(native, parts, {
          model: body?.model,
          agent: body?.agent,
          variant: body?.variant,
          directory,
        });
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 502 });
      }
    }
    if (command === "command" && req.method === "POST") {
      if (!conn.capabilities.commands || !conn.command) {
        return Response.json({ error: "backend cannot run commands" }, { status: 400 });
      }
      const body = (await req.json().catch(() => null)) as {
        command?: unknown;
        arguments?: unknown;
        parts?: unknown;
        model?: { providerID: string; modelID: string };
        agent?: string;
        variant?: string;
      } | null;
      if (typeof body?.command !== "string" || !body.command) {
        return Response.json({ error: "command required" }, { status: 400 });
      }
      let parts: PromptPart[] | undefined;
      if (body.parts !== undefined) {
        const read = readPromptParts({ parts: body.parts });
        if (!Array.isArray(read)) return Response.json(read, { status: 400 });
        if (read.some((part) => part.type === "text")) {
          return Response.json({ error: "a command takes its words as arguments" }, { status: 400 });
        }
        if (!conn.capabilities.attachments && read.some((part) => part.type !== "text")) {
          return Response.json({ error: "backend cannot take files or attachments" }, { status: 400 });
        }
        if (read.some((part) => part.type === "file_ref") && !(directory ?? conn.directory)) {
          return Response.json({ error: "session has no workspace to read files from" }, { status: 400 });
        }
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
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: error instanceof UnknownCommandError ? 400 : 502 },
        );
      }
    }
    if (command === "shell" && req.method === "POST") {
      if (!conn.capabilities.shell || !conn.shell) {
        return Response.json({ error: "backend cannot run shell commands" }, { status: 400 });
      }
      const body = (await req.json().catch(() => null)) as {
        command?: unknown;
        model?: { providerID: string; modelID: string };
        agent?: string;
      } | null;
      if (typeof body?.command !== "string" || !body.command.trim()) {
        return Response.json({ error: "command required" }, { status: 400 });
      }
      if (body.model !== undefined) {
        const model = body.model as { providerID?: unknown; modelID?: unknown } | null;
        if (!model || typeof model.providerID !== "string" || typeof model.modelID !== "string") {
          return Response.json({ error: "model must be { providerID, modelID }" }, { status: 400 });
        }
      }
      if (body.agent !== undefined && typeof body.agent !== "string") {
        return Response.json({ error: "agent must be a string" }, { status: 400 });
      }
      deps.goalRunner.allow(sessionId);
      try {
        await conn.shell(native, body.command, {
          model: body.model,
          agent: body.agent,
          directory,
        });
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
      }
    }
  }

  const sessionMcpAdd = path.match(/^\/sessions\/([^/]+)\/mcp$/);
  if (sessionMcpAdd && req.method === "POST") {
    const sessionId = decodeURIComponent(sessionMcpAdd[1]!);
    const conn = deps.driverFor(sessionId);
    if (!conn) return Response.json({ error: "no backend connected" }, { status: 400 });
    const native = conn.nativeId(sessionId);
    if (!native) return Response.json({ error: "session is not owned by a connected backend" }, { status: 400 });
    connections.own(sessionId, conn.id);
    if (conn.backend !== "opencode" || !conn.mcpAdd) {
      return Response.json({ error: "backend cannot manage mcp" }, { status: 400 });
    }
    const parsed = mcpAddRequest(await req.json().catch(() => null));
    if ("error" in parsed) return Response.json(parsed, { status: 400 });
    try {
      await conn.mcpAdd(parsed.name, parsed.config, deps.directoryOf(sessionId));
      return Response.json({ ok: true });
    } catch (error) {
      const secret = parsed.config.type === "remote"
        ? { url: parsed.config.url }
        : { command: parsed.config.command };
      return Response.json({ error: safeMcpError(error, secret) }, { status: 502 });
    }
  }

  const sessionMcpAuth = path.match(/^\/sessions\/([^/]+)\/mcp\/([^/]+)\/auth(\/callback)?$/);
  if (sessionMcpAuth && req.method === "POST") {
    const sessionId = decodeURIComponent(sessionMcpAuth[1]!);
    const conn = deps.driverFor(sessionId);
    if (!conn) return Response.json({ error: "no backend connected" }, { status: 400 });
    const native = conn.nativeId(sessionId);
    if (!native) return Response.json({ error: "session is not owned by a connected backend" }, { status: 400 });
    connections.own(sessionId, conn.id);
    if (conn.backend !== "opencode" || !conn.mcpAuthStart || !conn.mcpAuthFinish) {
      return Response.json({ error: "backend cannot manage mcp" }, { status: 400 });
    }
    let name: string;
    try {
      name = decodeURIComponent(sessionMcpAuth[2]!);
    } catch {
      return Response.json({ error: "invalid name" }, { status: 400 });
    }
    if (!name || name.includes("/") || name.includes("..")) {
      return Response.json({ error: "invalid name" }, { status: 400 });
    }
    const callback = sessionMcpAuth[3] === "/callback";
    const body = callback ? ((await req.json().catch(() => null)) as { code?: unknown } | null) : null;
    const code = callback ? mcpAuthCode(body?.code) : undefined;
    if (callback && !code) return Response.json({ error: "code required" }, { status: 400 });
    try {
      if (!callback) {
        const started = await conn.mcpAuthStart(name, deps.directoryOf(sessionId), req.signal);
        return Response.json(mcpAuthStartView(started));
      }
      await conn.mcpAuthFinish(name, code!, deps.directoryOf(sessionId), req.signal);
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json({ error: safeMcpError(error, { command: code ? [code] : [] }) }, { status: 502 });
    }
  }

  const sessionMcp = path.match(/^\/sessions\/([^/]+)\/mcp\/([^/]+)\/(connect|disconnect)$/);
  if (sessionMcp && req.method === "POST") {
    const sessionId = decodeURIComponent(sessionMcp[1]!);
    const conn = deps.driverFor(sessionId);
    if (!conn) return Response.json({ error: "no backend connected" }, { status: 400 });
    const native = conn.nativeId(sessionId);
    if (!native) return Response.json({ error: "session is not owned by a connected backend" }, { status: 400 });
    connections.own(sessionId, conn.id);
    let name: string;
    try {
      name = decodeURIComponent(sessionMcp[2]!);
    } catch {
      return Response.json({ error: "invalid name" }, { status: 400 });
    }
    if (!name || name.includes("/")) return Response.json({ error: "invalid name" }, { status: 400 });
    const fn = sessionMcp[3] === "connect" ? conn.mcpConnect : conn.mcpDisconnect;
    if (conn.backend !== "opencode" || !fn) {
      return Response.json({ error: "backend cannot manage mcp" }, { status: 400 });
    }
    try {
      await fn(name, deps.directoryOf(sessionId));
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  const sessionRevert = path.match(/^\/sessions\/([^/]+)\/revert$/);
  if (sessionRevert && req.method === "POST") {
    const sessionId = decodeURIComponent(sessionRevert[1]!);
    const conn = deps.driverFor(sessionId);
    if (!conn) return Response.json({ error: "no backend connected" }, { status: 400 });
    const native = conn.nativeId(sessionId);
    if (!native) return Response.json({ error: "session is not owned by a connected backend" }, { status: 400 });
    connections.own(sessionId, conn.id);
    if (!conn.capabilities.revert || !conn.revert) {
      return Response.json({ error: "backend cannot revert" }, { status: 400 });
    }
    const body = (await req.json().catch(() => null)) as { message_id?: unknown } | null;
    const messageId = typeof body?.message_id === "string" ? body.message_id : "";
    if (!messageId) return Response.json({ error: "message_id required" }, { status: 400 });
    try {
      await conn.revert(native, messageId, deps.directoryOf(sessionId));
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  const sessionUnrevert = path.match(/^\/sessions\/([^/]+)\/unrevert$/);
  if (sessionUnrevert && req.method === "POST") {
    const sessionId = decodeURIComponent(sessionUnrevert[1]!);
    const conn = deps.driverFor(sessionId);
    if (!conn) return Response.json({ error: "no backend connected" }, { status: 400 });
    const native = conn.nativeId(sessionId);
    if (!native) return Response.json({ error: "session is not owned by a connected backend" }, { status: 400 });
    connections.own(sessionId, conn.id);
    if (!conn.capabilities.revert || !conn.unrevert) {
      return Response.json({ error: "backend cannot revert" }, { status: 400 });
    }
    try {
      await conn.unrevert(native, deps.directoryOf(sessionId));
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  const sessionFork = path.match(/^\/sessions\/([^/]+)\/fork$/);
  if (sessionFork && req.method === "POST") {
    const sessionId = decodeURIComponent(sessionFork[1]!);
    const conn = deps.driverFor(sessionId);
    if (!conn) return Response.json({ error: "no backend connected" }, { status: 400 });
    const native = conn.nativeId(sessionId);
    if (!native) return Response.json({ error: "session is not owned by a connected backend" }, { status: 400 });
    connections.own(sessionId, conn.id);
    if (!conn.capabilities.fork || !conn.fork) {
      return Response.json({ error: "backend cannot fork" }, { status: 400 });
    }
    const body = (await req.json().catch(() => null)) as { message_id?: unknown; through?: unknown } | null;
    if (body?.message_id !== undefined && (typeof body.message_id !== "string" || !body.message_id)) {
      return Response.json({ error: "message_id must be a message id" }, { status: 400 });
    }
    const view = deps.sessionView(sessionId);
    const cut = forkBefore(view, body?.message_id as string | undefined, body?.through === true);
    if (!cut) return Response.json({ error: "no such message in the session" }, { status: 400 });
    const directory = deps.directoryOf(sessionId);
    try {
      const created = await conn.fork(native, cut.before, directory);
      connections.own(created.casfId, conn.id);
      deps.claims.claim(`${conn.agent}:${created.nativeId}`, created.casfId, conn.id);
      const source = view.title?.trim();
      if (source && conn.capabilities.manage) {
        const title = forkTitle(source, store.listSessions().map((summary) => summary.title));
        await conn.rename(created.nativeId, title, directory).catch(() => {});
      }
      return Response.json({ id: created.casfId });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  const sessionHandoff = path.match(/^\/sessions\/([^/]+)\/handoff$/);
  if (sessionHandoff && req.method === "POST") {
    const sessionId = decodeURIComponent(sessionHandoff[1]!);
    let view: SessionView;
    try {
      view = deps.sessionView(sessionId);
    } catch (error) {
      if (error instanceof Error && error.message === "no events") {
        return Response.json({ error: "session not found" }, { status: 404 });
      }
      throw error;
    }
    const body = (await req.json().catch(() => null)) as {
      connection_id?: unknown;
      model?: { providerID: string; modelID: string };
      agent?: string;
      variant?: string;
    } | null;
    const connectionId = typeof body?.connection_id === "string" ? body.connection_id : "";
    if (!connectionId) return Response.json({ error: "connection_id required" }, { status: 400 });
    const target = connections.get(connectionId);
    if (!target) return Response.json({ error: "no such connection" }, { status: 400 });
    if (!target.capabilities.prompt) return Response.json({ error: "backend cannot prompt" }, { status: 400 });
    const titleBase = view.title?.trim() || "session";
    const title = `Handoff: ${titleBase.length > 60 ? `${titleBase.slice(0, 59)}…` : titleBase}`;
    const directory = deps.directoryOf(sessionId);
    try {
      const created = await target.createSession({ title, directory });
      connections.own(created.casfId, target.id);
      if (directory) deps.createdDirs.set(created.casfId, directory);
      deps.claims.claim(`${target.agent}:${created.nativeId}`, created.casfId, target.id);
      await target.prompt(created.nativeId, [{ type: "text", text: sessionBriefing(view) }], {
        model: body?.model,
        agent: body?.agent,
        variant: body?.variant,
        directory,
      });
      return Response.json({ id: created.casfId });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  const sessionSummarize = path.match(/^\/sessions\/([^/]+)\/summarize$/);
  if (sessionSummarize && req.method === "POST") {
    const sessionId = decodeURIComponent(sessionSummarize[1]!);
    const conn = deps.driverFor(sessionId);
    if (!conn) return Response.json({ error: "no backend connected" }, { status: 400 });
    const native = conn.nativeId(sessionId);
    if (!native) return Response.json({ error: "session is not owned by a connected backend" }, { status: 400 });
    connections.own(sessionId, conn.id);
    if (!conn.capabilities.summarize || !conn.summarize) {
      return Response.json({ error: "backend cannot summarize" }, { status: 400 });
    }
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
      await conn.summarize(native, deps.directoryOf(sessionId), model);
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  const sessionShare = path.match(/^\/sessions\/([^/]+)\/(share|unshare)$/);
  if (sessionShare && req.method === "POST") {
    const sessionId = decodeURIComponent(sessionShare[1]!);
    const action = sessionShare[2]!;
    const conn = deps.driverFor(sessionId);
    if (!conn) return Response.json({ error: "no backend connected" }, { status: 400 });
    const native = conn.nativeId(sessionId);
    if (!native) return Response.json({ error: "session is not owned by a connected backend" }, { status: 400 });
    connections.own(sessionId, conn.id);
    if (!conn.capabilities.share || !conn.share || !conn.unshare) {
      return Response.json({ error: "backend cannot share sessions" }, { status: 400 });
    }
    try {
      if (action === "share") {
        return Response.json({ url: (await conn.share(native, deps.directoryOf(sessionId))) ?? null });
      }
      await conn.unshare(native, deps.directoryOf(sessionId));
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  const sessionData = path.match(/^\/sessions\/([^/]+)\/data$/);
  if (sessionData && req.method === "GET") {
    const sessionId = decodeURIComponent(sessionData[1]!);
    const counts = store.classCounts([sessionId])[0] ?? {
      session_id: sessionId,
      rebuildable: 0,
      local: 0,
      rebuildable_bytes: 0,
      local_bytes: 0,
    };
    const conn = deps.driverFor(sessionId);
    return Response.json({
      ...counts,
      backend: conn !== undefined,
      can_delete: Boolean(conn?.capabilities.manage && conn.nativeId(sessionId)),
    });
  }

  const sessionDelete = path.match(/^\/sessions\/([^/]+)$/);
  if (sessionDelete && req.method === "DELETE") {
    const sessionId = decodeURIComponent(sessionDelete[1]!);
    const localOnly = url.searchParams.get("local") === "1";
    const counts = store.classCounts([sessionId])[0];
    const conn = deps.driverFor(sessionId);
    const native = conn?.nativeId(sessionId);
    let backend = false;
    if (!localOnly && conn && conn.capabilities.manage && native) {
      try {
        await conn.deleteSession(native, deps.directoryOf(sessionId));
        backend = true;
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 502 });
      }
    } else if (!localOnly) {
      return Response.json(
        {
          error: "no connected backend can delete this session",
          backend: false,
          local: counts?.local ?? 0,
          local_only: true,
        },
        { status: 409 },
      );
    }
    const deleted = store.deleteSessions([sessionId]);
    deps.views.drop(sessionId);
    void deps.plugins.sessionEnded(sessionId);
    deps.broadcast({ type: "session.deleted", session_id: sessionId });
    return Response.json({ ok: true, backend, deleted, local: counts?.local ?? 0 });
  }

  const sessionGoal = path.match(/^\/sessions\/([^/]+)\/goal$/);
  if (sessionGoal) {
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(sessionGoal[1]!);
    } catch {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (store.lastSeq(sessionId) <= 0) return Response.json({ error: "not found" }, { status: 404 });
    if (req.method === "GET") {
      let text: string | null = null;
      let paused = false;
      let met = false;
      try {
        const view = deps.sessionView(sessionId);
        text = view.goal ?? null;
        paused = view.goal_paused === true;
        met = view.goal_met === true;
      } catch {
        text = null;
      }
      return Response.json({ text, paused, met, session_id: sessionId });
    }
    if (req.method === "DELETE") {
      store.append([
        makeEvent({
          session_id: sessionId,
          source: { backend: "desktop" },
          type: "session.goal",
          data: { text: null },
        }) as EventInput,
      ]);
      deps.goalRunner.reset(sessionId);
      return Response.json({ ok: true, text: null, session_id: sessionId });
    }
    if (req.method === "PUT") {
      const body = (await req.json().catch(() => null)) as { text?: unknown; paused?: unknown } | null;
      if (typeof body?.paused === "boolean" && body.text === undefined) {
        let view: SessionView;
        try {
          view = deps.sessionView(sessionId);
        } catch {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        if (!view.goal) return Response.json({ error: "no goal" }, { status: 400 });
        if (body.paused) {
          if (view.goal_met) return Response.json({ error: "goal is met" }, { status: 409 });
          if (!view.goal_paused) {
            store.append([
              makeEvent({
                session_id: sessionId,
                source: { backend: "desktop" },
                type: "session.goal",
                data: { text: view.goal, paused: true },
              }) as EventInput,
            ]);
          }
          return Response.json({ ok: true, text: view.goal, paused: true, session_id: sessionId });
        }
        if (view.goal_paused) {
          store.append([
            makeEvent({
              session_id: sessionId,
              source: { backend: "desktop" },
              type: "session.goal",
              data: { text: view.goal },
            }) as EventInput,
          ]);
          deps.goalRunner.restart(sessionId);
        }
        return Response.json({ ok: true, text: view.goal, paused: false, session_id: sessionId });
      }
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text) return Response.json({ error: "text required" }, { status: 400 });
      if (text.length > 4_000) return Response.json({ error: "text is too long" }, { status: 400 });
      store.append([
        makeEvent({
          session_id: sessionId,
          source: { backend: "desktop" },
          type: "session.goal",
          data: { text },
        }) as EventInput,
      ]);
      deps.goalRunner.restart(sessionId);
      return Response.json({ ok: true, text, session_id: sessionId });
    }
  }

  return undefined;
}
