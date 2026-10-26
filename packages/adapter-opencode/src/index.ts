import {
  createOpencodeClient,
  type Event,
  type FilePartInput,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type { PolicySource } from "@agent-strata/policy";
import { createSessionImport } from "./import";
import { createIngestor } from "./ingest";
import { OpencodeMapper } from "./map";
import { runOpencodeStream } from "./stream";
import type { OnAsk, OnQuestion, OpencodePromptPart, OpencodeSyncGuard, Sink } from "./types";

export type { OnAsk, OnQuestion, OpencodePromptPart, OpencodeSyncGuard, Sink } from "./types";
export type { SnapshotMessage } from "./map";
export {
  OPENCODE_MAPPER_VERSION,
  OPENCODE_REBUILT_TYPES,
  OpencodeMapper,
  SETTLE_DELAY_MS,
  SETTLE_QUIET_MS,
  SETTLE_STALL_MS,
  STREAM_SNAPSHOT_MS,
  rebuildEvents,
  snapshotEvents,
} from "./map";
export { createIngestor } from "./ingest";
export { normalizeOpencodeEvent, runOpencodeStream } from "./stream";

/**
 * Providers the model picker may offer.
 *
 * OpenCode's `connected` list also names every sibling that shares an env var
 * with a key the user stored (`source: "api"`). Those siblings send that key
 * to a different product and the request fails. A provider that is itself only
 * an env var stays, because that var is the credential.
 */
export function pickableProviders<T extends { id: string }>(
  all: readonly T[],
  connected: readonly string[] | undefined,
): T[] {
  const listed = connected ? all.filter((row) => connected.includes(row.id)) : [...all];
  const claimed = new Set<string>();
  for (const row of listed) {
    if (providerSource(row) !== "api") continue;
    for (const name of providerEnv(row)) claimed.add(name);
  }
  if (claimed.size === 0) return listed;
  return listed.filter(
    (row) => providerSource(row) !== "env" || !providerEnv(row).some((name) => claimed.has(name)),
  );
}

function providerSource(row: { id: string }): string | undefined {
  const source = (row as { source?: unknown }).source;
  return typeof source === "string" ? source : undefined;
}

function providerEnv(row: { id: string }): string[] {
  const env = (row as { env?: unknown }).env;
  if (!Array.isArray(env)) return [];
  return env.filter((name): name is string => typeof name === "string" && name.length > 0);
}

/** How often the connection re-reads the backend's own pending asks. */
export const RESTORE_POLL_MS = 30_000;

/** How long a command may take to fail before it counts as started. */
export const COMMAND_START_MS = 1_500;

export class UnknownCommandError extends Error {
  constructor(name: string) {
    super(`unknown command: /${name}`);
    this.name = "UnknownCommandError";
  }
}

function mcpAuthFailure(text: string, secret = ""): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200 || (secret.length >= 8 && trimmed.includes(secret))) return "mcp auth failed";
  return trimmed;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const data = (e as { data?: { message?: unknown } })?.data;
  if (data && typeof data.message === "string" && data.message) return data.message;
  const direct = (e as { message?: unknown })?.message;
  if (typeof direct === "string" && direct) return direct;
  const text = typeof e === "string" ? e : JSON.stringify(e);
  return !text || text === "{}" ? "opencode server error" : text;
}

/** Shown when a prompt was refused or never accepted. Callers must not repeat the text. */
export const PROMPT_NOT_ACCEPTED = "prompt was not accepted";

/**
 * How long a stop's status re-read may take before it stops mattering.
 *
 * The stop button is already showing "stopping" by the time this runs, so a
 * read that hangs holds the button there. It has to be bounded on its own:
 * every call in this adapter goes through `abortingFetch`, which returns a
 * promise that never settles once the connection is gone — waiting on that is
 * waiting forever.
 */
const ABORT_STATUS_MS = 5_000;

export function promptFailure(err: unknown, text: string): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return PROMPT_NOT_ACCEPTED;
  const message = errorMessage(err);
  const sample = text.trim().slice(0, 80);
  if (!message || message.length > 300 || (sample.length >= 12 && message.includes(sample))) return PROMPT_NOT_ACCEPTED;
  return message;
}

export async function connectOpencode(opts: {
  baseUrl: string;
  directory?: string;
  // HTTP basic auth for `opencode serve --username/--password`
  username?: string;
  password?: string;
  sink: Sink;
  policy?: PolicySource;
  onAsk?: OnAsk;
  onQuestion?: OnQuestion;
  onSettled?: (requestId: string, decision: "allow" | "deny") => void;
  onQuestionSettled?: (requestId: string) => void;
  onEvent?: (evt: Event) => void;
  connectTimeoutMs?: number;
  /** How long prompt_async may take to accept. It returns once the run has started. */
  promptAcceptMs?: number;
  fetch?: typeof fetch;
}): Promise<{
  stop: () => void;
  importSession: (
    sessionID: string,
    directory?: string,
    options?: { force?: boolean },
  ) => Promise<boolean>;
  createSession: (opts?: { title?: string; directory?: string }) => Promise<{ id: string }>;
  prompt: (
    sessionID: string,
    parts: OpencodePromptPart[],
    opts?: {
      model?: { providerID: string; modelID: string };
      agent?: string;
      variant?: string;
      directory?: string;
    },
  ) => Promise<void>;
  command: (
    sessionID: string,
    c: {
      command: string;
      arguments: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
      variant?: string;
      directory?: string;
      parts?: FilePartInput[];
    },
  ) => Promise<void>;
  listModels: () => Promise<
    { providerID: string; modelID: string; name: string; variants: string[]; context?: number }[]
  >;
  listAgents: () => Promise<{ name: string; mode?: string }[]>;
  listSessions: () => Promise<{ id: string; title: string; directory: string }[]>;
  listWorkspaces: () => Promise<{ id: string; name?: string; directory: string }[]>;
  abort: (sessionID: string, directory?: string) => Promise<void>;
  replyQuestion: (requestID: string, answers: string[][], directory?: string) => Promise<void>;
  rejectQuestion: (requestID: string, directory?: string) => Promise<void>;
  mcpConnect: (name: string, directory?: string) => Promise<void>;
  mcpDisconnect: (name: string, directory?: string) => Promise<void>;
  mcpAdd: (
    name: string,
    config: { type: "local"; command: string[] } | { type: "remote"; url: string },
    directory?: string,
  ) => Promise<void>;
  mcpAuthStart: (
    name: string,
    directory: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ authorizationUrl?: string; oauthState?: string }>;
  mcpAuthFinish: (name: string, code: string, directory: string | undefined, signal: AbortSignal) => Promise<void>;
  revert: (sessionID: string, messageID: string, directory?: string) => Promise<void>;
  unrevert: (sessionID: string, directory?: string) => Promise<void>;
  fork: (sessionID: string, messageID: string | undefined, directory?: string) => Promise<{ id: string }>;
  summarize: (
    sessionID: string,
    directory?: string,
    model?: { providerID: string; modelID: string },
  ) => Promise<void>;
  share: (sessionID: string, directory?: string) => Promise<string | undefined>;
  unshare: (sessionID: string, directory?: string) => Promise<void>;
  indexSessions: () => Promise<string[]>;
  refreshSessions: (guard?: OpencodeSyncGuard) => Promise<number>;
  rebuildSession: (sessionID: string, directory?: string) => Promise<number>;
  updateSession: (
    sessionID: string,
    patch: { title?: string; archived?: boolean },
    directory?: string,
  ) => Promise<void>;
  deleteSession: (sessionID: string, directory?: string) => Promise<void>;
}> {
  const abort = new AbortController();
  // The SDK builds the SSE request with its own internal signal and ignores a
  // caller-provided one. Wrap fetch so stop() truly ends the stream: an
  // in-flight request is aborted via our signal, an already-open response body
  // has its reader cancelled, and any later retried fetch hangs so the
  // abandoned generator goes inert instead of reconnecting forever.
  const rawFetch = opts.fetch ?? globalThis.fetch;
  let openReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortingFetch = async (request: Request): Promise<Response> => {
    if (abort.signal.aborted) return new Promise<Response>(() => {});
    // Bun cuts a request quiet for 5 minutes, and a command answers only when its run is done
    const signal = request.signal ? AbortSignal.any([abort.signal, request.signal]) : abort.signal;
    const res = await rawFetch(new Request(request, { signal }), { timeout: false } as RequestInit);
    if (!res.body) return res;
    const real = res.body.getReader();
    openReader = real;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { done, value } = await real.read();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      },
      cancel() {
        void real.cancel();
      },
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  abort.signal.addEventListener("abort", () => {
    try {
      void openReader?.cancel().catch(() => {});
    } catch {
      // reader may already be released
    }
  });
  const client: OpencodeClient = createOpencodeClient({
    baseUrl: opts.baseUrl,
    directory: opts.directory,
    headers:
      opts.username !== undefined || opts.password !== undefined
        ? {
            Authorization: `Basic ${btoa(`${opts.username ?? ""}:${opts.password ?? ""}`)}`,
          }
        : undefined,
    fetch: abortingFetch as typeof fetch,
  });
  const mapper = new OpencodeMapper({ directory: opts.directory });
  const ingestor = createIngestor({
    mapper,
    sink: opts.sink,
    policy: opts.policy,
    onAsk: opts.onAsk,
    onQuestion: opts.onQuestion,
    onSettled: opts.onSettled,
    onQuestionSettled: opts.onQuestionSettled,
    reply: async (requestID, r, message, directory) => {
      // The server scopes asks per project directory, so a reply aimed at the
      // connection's default directory 404s on a session living elsewhere —
      // and the SDK puts that in `error` rather than throwing. Checking it is
      // what stops a failed reply from being reported as a granted permission.
      const res = await client.permission.reply({
        requestID,
        reply: r,
        message,
        directory: directory ?? opts.directory,
      });
      if (res.error || res.data !== true)
        throw new Error(`permission reply failed: ${JSON.stringify(res.error ?? res.data)}`);
    },
    replyQuestion: async (requestID, answers, directory) => {
      await client.question.reply({ requestID, answers, directory: directory ?? opts.directory });
    },
    rejectQuestion: async (requestID, directory) => {
      await client.question.reject({ requestID, directory: directory ?? opts.directory });
    },
  });

  const connectTimeout = opts.connectTimeoutMs ?? 10_000;
  const promptAcceptMs = opts.promptAcceptMs ?? 20_000;

  const sessionImport = createSessionImport({
    client,
    directory: opts.directory,
    sink: opts.sink,
    ingestor,
  });
  await runOpencodeStream({
    client,
    abort,
    connectTimeout,
    onEvent: opts.onEvent,
    handle: (evt) => ingestor.handle(evt),
    onReconnect: () => {
      void sessionImport.refreshSessions().catch((err) =>
        console.error("opencode catch-up failed:", err),
      );
      void reconcileIdle();
    },
  });

  /**
   * Ask the backend which sessions it is not running, and believe it.
   *
   * Everything else in this adapter infers `busy` from the event stream, which
   * is right until a frame goes missing — and then it is wrong forever, because
   * no later event is guaranteed to mention that session again. The store's
   * projection is durable, this process's memory is not, so a restart or a
   * reconnect is exactly where the two can disagree with nothing to correct it.
   *
   * Once per connection, not on a timer: a session that drifts while the stream
   * is healthy produces an event, and a poll would spend a request per period
   * to cover a case that only opens at a boundary. A failure here is silence,
   * not an error the reader can act on — the stream still works, and the next
   * connect asks again.
   */
  const reconcileIdle = async () => {
    try {
      const statuses = await client.session.status({ directory: opts.directory });
      const idle = Object.entries(statuses.data ?? {})
        .filter(([, status]) => (status as { type?: string }).type === "idle")
        .map(([sessionID]) => sessionID);
      if (idle.length > 0) ingestor.append(mapper.reconcileIdle(idle));
    } catch (err) {
      // A backend that cannot answer says nothing about the run; leave the
      // projection alone rather than guessing in either direction.
      console.error("opencode status reconcile failed:", err);
    }
  };

  // The first connect is the one that matters most: it is where a restarted
  // service meets a projection written by the process before it. `onReconnect`
  // alone would miss it, because nothing has reconnected yet.
  void reconcileIdle();

  const mcpAuthFetch = (path: string, directory: string | undefined, signal: AbortSignal, body?: unknown) => {
    const q = new URLSearchParams();
    const dir = directory ?? opts.directory;
    if (dir) q.set("directory", dir);
    const timeout = AbortSignal.timeout(300_000);
    return rawFetch(
      new Request(`${opts.baseUrl.replace(/\/+$/, "")}${path}?${q}`, {
        method: "POST",
        headers: {
          ...(opts.username !== undefined || opts.password !== undefined
            ? { authorization: `Basic ${btoa(`${opts.username ?? ""}:${opts.password ?? ""}`)}` }
            : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([signal, timeout, abort.signal]),
      }),
      { timeout: false } as RequestInit,
    );
  };

  const api = {
    stop() {
      abort.abort();
      ingestor.stop();
      clearInterval(restoreTimer);
    },
    async createSession(sessOpts?: { title?: string; directory?: string }) {
      const r = await client.session.create({
        title: sessOpts?.title,
        directory: sessOpts?.directory ?? opts.directory,
      });
      if (!r.data) throw new Error("session.create returned no data");
      return { id: r.data.id };
    },
    async prompt(
      sessionID: string,
      parts: OpencodePromptPart[],
      promptOpts?: {
        model?: { providerID: string; modelID: string };
        agent?: string;
        variant?: string;
        directory?: string;
      },
    ) {
      const said = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      let sent: Awaited<ReturnType<typeof client.session.promptAsync>>;
      try {
        sent = await client.session.promptAsync(
          {
            sessionID,
            directory: promptOpts?.directory ?? opts.directory,
            model: promptOpts?.model,
            agent: promptOpts?.agent,
            // server schema accepts `variant` (reasoning effort); SDK types lag
            ...(promptOpts?.variant ? ({ variant: promptOpts.variant } as object) : {}),
            parts,
          },
          { signal: AbortSignal.timeout(promptAcceptMs) },
        );
      } catch (err) {
        throw new Error(promptFailure(err, said));
      }
      if ("error" in sent && sent.error) throw new Error(promptFailure(sent.error, said));
    },
    async command(
      sessionID: string,
      c: {
        command: string;
        arguments: string;
        agent?: string;
        model?: { providerID: string; modelID: string };
        variant?: string;
        directory?: string;
        parts?: FilePartInput[];
      },
    ) {
      const directory = c.directory ?? opts.directory;
      const listed = await client.command.list({ directory });
      if (listed.error) throw new Error(errorMessage(listed.error));
      if (!(listed.data ?? []).some((x) => x.name === c.command)) throw new UnknownCommandError(c.command);
      const run = client.session.command({
        sessionID,
        directory,
        command: c.command,
        arguments: c.arguments,
        agent: c.agent,
        model: c.model ? `${c.model.providerID}/${c.model.modelID}` : undefined,
        variant: c.variant,
        parts: c.parts,
      });
      // OpenCode answers when the whole run is done, and the run goes on if
      // nobody waits; a command that fails to start fails at once.
      const early = await Promise.race([
        run.then(
          (r) => ({ r }),
          (thrown: unknown) => ({ thrown }),
        ),
        Bun.sleep(COMMAND_START_MS).then(() => undefined),
      ]);
      if (early === undefined) {
        const report = (err: unknown) => {
          if (!abort.signal.aborted) console.error(`opencode command /${c.command} failed:`, err);
        };
        void run.then((r) => r.error && report(r.error), report);
        return;
      }
      if ("thrown" in early) throw early.thrown;
      if (early.r.error) throw new Error(errorMessage(early.r.error));
    },
    async listModels() {
      const r = await client.provider.list();
      // `connected` is broader than a stored key: a sibling that only shares
      // the env var is listed too, and it cannot take that key. Each
      // provider's default model sorts first.
      const out: { providerID: string; modelID: string; name: string; variants: string[]; context?: number }[] =
        [];
      for (const p of pickableProviders(r.data?.all ?? [], r.data?.connected)) {
        const def = r.data?.default?.[p.id];
        const models = Object.entries(p.models ?? {});
        models.sort(([a], [b]) => (a === def ? -1 : b === def ? 1 : 0));
        for (const [modelID, m] of models) {
          const raw = m as { name?: string; variants?: object; limit?: { context?: number } };
          const context = raw.limit?.context;
          out.push({
            providerID: p.id,
            modelID,
            name: raw.name ?? modelID,
            variants: Object.keys(raw.variants ?? {}),
            ...(typeof context === "number" && context > 0 ? { context } : {}),
          });
        }
      }
      return out;
    },
    async listAgents() {
      const r = await client.app.agents();
      // same cut as the official desktop picker: subagents and hidden builtins stay out
      return (r.data ?? [])
        .filter((a) => a.mode !== "subagent" && a.hidden !== true)
        .map((a) => ({ name: a.name, mode: a.mode }));
    },
    async listSessions() {
      const r = await client.session.list({ directory: opts.directory, roots: true, limit: 80 });
      return (r.data ?? []).map((s) => ({ id: s.id, title: s.title, directory: s.directory }));
    },
    async listWorkspaces() {
      const r = await client.project.list();
      const out: { id: string; name?: string; directory: string }[] = [];
      for (const project of r.data ?? []) {
        out.push({ id: project.id, name: project.name, directory: project.worktree });
        for (const sandbox of project.sandboxes ?? []) {
          out.push({ id: project.id, name: project.name, directory: sandbox });
        }
      }
      return out;
    },
    /**
     * Answer a question by the id OpenCode gave it.
     *
     * The path a question normally takes is a promise handed back to the caller
     * when it arrives, and that promise only exists in the process that received
     * it. Answering after a restart goes through here instead, and says so in the
     * log — the projector reads the log, so that is what retires the card.
     */
    async replyQuestion(requestId: string, answers: string[][], directory?: string) {
      await client.question.reply({ requestID: requestId, answers, directory: directory ?? opts.directory });
    },
    async rejectQuestion(requestId: string, directory?: string) {
      await client.question.reject({ requestID: requestId, directory: directory ?? opts.directory });
    },
    async abort(sessionID: string, directory?: string) {
      const dir = directory ?? opts.directory;
      await client.session.abort({ sessionID, directory: dir });
      // The official client clears its synced todo store on stop: the queued
      // next steps belong to the run that just ended. Same move here — the
      // projector folds it into an empty plan and the strip goes away until
      // the next real `todo.updated`.
      ingestor.handle({
        id: `abort:${sessionID}:todos:${Date.now()}`,
        type: "todo.updated",
        properties: { sessionID, todos: [] },
      } as Event);
      // Abort returns when the request is accepted, not when a status event
      // arrives. A session that was already idle accepts it and sends
      // nothing, so a stale stored `busy` flag — the thing the stop button
      // reads — never moves; the synthesized idle is what clears it. But a
      // session the server still reports as running will send its own idle
      // once the interrupt lands, and an early synthesized one only flicks
      // the button off and back on — so only say idle when the server is
      // not running the session right now. A status read that fails says
      // nothing about the run; keep the close-out in that case so the stale
      // flag still clears.
      let running = false;
      try {
        // Bounded on its own, not by the signal: `abortingFetch` never settles
        // once the connection is gone, so a read with no deadline of its own
        // holds the stop button at "stopping" forever. A timeout reads as
        // "could not tell", which is the same answer a failure gives.
        const statuses = await Promise.race([
          client.session.status({ directory: dir }),
          Bun.sleep(ABORT_STATUS_MS).then(() => undefined),
        ]);
        const kind = statuses === undefined ? undefined : (statuses.data ?? {})[sessionID]?.type;
        running = kind === "busy" || kind === "retry";
      } catch {
        running = false;
      }
      if (!running) {
        ingestor.handle({
          id: `abort:${sessionID}:${Date.now()}`,
          type: "session.idle",
          properties: { sessionID },
        } as Event);
      }
    },
    async mcpConnect(name: string, directory?: string) {
      await client.mcp.connect({ name, directory: directory ?? opts.directory });
    },
    async mcpDisconnect(name: string, directory?: string) {
      await client.mcp.disconnect({ name, directory: directory ?? opts.directory });
    },
    async mcpAdd(
      name: string,
      config: { type: "local"; command: string[] } | { type: "remote"; url: string },
      directory?: string,
    ) {
      const added = await client.mcp.add({ name, config, directory: directory ?? opts.directory });
      if (added.error) throw new Error(errorMessage(added.error));
    },
    async mcpAuthStart(name: string, directory: string | undefined, signal: AbortSignal) {
      const res = await mcpAuthFetch(`/mcp/${encodeURIComponent(name)}/auth`, directory, signal);
      const text = await res.text();
      if (!res.ok) throw new Error(mcpAuthFailure(text));
      try {
        return JSON.parse(text) as { authorizationUrl?: string; oauthState?: string };
      } catch {
        throw new Error("mcp auth failed");
      }
    },
    async mcpAuthFinish(name: string, code: string, directory: string | undefined, signal: AbortSignal) {
      const res = await mcpAuthFetch(`/mcp/${encodeURIComponent(name)}/auth/callback`, directory, signal, { code });
      const text = await res.text();
      if (!res.ok) throw new Error(mcpAuthFailure(text, code));
      let status: { status?: unknown; error?: unknown } | undefined;
      try {
        status = JSON.parse(text) as { status?: unknown; error?: unknown };
      } catch {
        status = undefined;
      }
      if (status?.status === "failed") {
        throw new Error(mcpAuthFailure(typeof status.error === "string" ? status.error : "", code));
      }
    },
    async revert(sessionID: string, messageID: string, directory?: string) {
      // Current servers stage a boundary at /api/session/:id/revert/stage.
      // A 404 on that route means this server still answers the older
      // POST /session/:id/revert. Any other status is the revert itself.
      const staged = await client.v2.session.revert.stage({ sessionID, messageID });
      if (!staged.error) return;
      if (staged.response.status !== 404) throw new Error(errorMessage(staged.error));
      const legacy = await client.session.revert({
        sessionID,
        messageID,
        directory: directory ?? opts.directory,
      });
      if (legacy.error) throw new Error(errorMessage(legacy.error));
    },
    async unrevert(sessionID: string, directory?: string) {
      const cleared = await client.v2.session.revert.clear({ sessionID });
      if (!cleared.error) return;
      if (cleared.response.status !== 404) throw new Error(errorMessage(cleared.error));
      // Newer servers clear with DELETE /api/session/:id/revert. The SDK this
      // build speaks still posts /revert/clear, so a 404 tries the delete
      // before the legacy unrevert route.
      const base = opts.baseUrl.replace(/\/+$/, "");
      const deleted = await rawFetch(
        new Request(`${base}/api/session/${encodeURIComponent(sessionID)}/revert`, {
          method: "DELETE",
          headers:
            opts.username !== undefined || opts.password !== undefined
              ? { authorization: `Basic ${btoa(`${opts.username ?? ""}:${opts.password ?? ""}`)}` }
              : {},
        }),
      );
      if (deleted.ok) return;
      if (deleted.status !== 404) {
        const text = (await deleted.text()).trim();
        throw new Error(text && text.length <= 300 ? text : "revert clear failed");
      }
      const legacy = await client.session.unrevert({ sessionID, directory: directory ?? opts.directory });
      if (legacy.error) throw new Error(errorMessage(legacy.error));
    },
    async fork(sessionID: string, messageID: string | undefined, directory?: string) {
      const r = await client.session.fork({ sessionID, messageID, directory: directory ?? opts.directory });
      if (!r.data) throw new Error("session.fork returned no data");
      return { id: r.data.id };
    },
    async summarize(
      sessionID: string,
      directory?: string,
      model?: { providerID: string; modelID: string },
    ) {
      const r = await client.session.summarize({
        sessionID,
        directory: directory ?? opts.directory,
        ...(model ? { providerID: model.providerID, modelID: model.modelID } : {}),
      });
      if (r.error) throw new Error(errorMessage(r.error));
    },
    async share(sessionID: string, directory?: string) {
      const r = await client.session.share({ sessionID, directory: directory ?? opts.directory });
      if (r.error) throw new Error(errorMessage(r.error));
      return r.data?.share?.url;
    },
    async unshare(sessionID: string, directory?: string) {
      const r = await client.session.unshare({ sessionID, directory: directory ?? opts.directory });
      if (r.error) throw new Error(errorMessage(r.error));
    },
    async updateSession(sessionID: string, patch: { title?: string; archived?: boolean }, directory?: string) {
      const r = await client.session.update({
        sessionID,
        directory: directory ?? opts.directory,
        title: patch.title,
        // 0 is how OpenCode records "not archived"; leaving the field out would
        // mean "do not change" and the restore would look like it did nothing.
        time: patch.archived === undefined ? undefined : { archived: patch.archived ? Date.now() : 0 },
      });
      if (r.data) {
        ingestor.handle({
          id: `write:${sessionID}:updated`,
          type: "session.updated",
          properties: { sessionID, info: r.data },
        } as Event);
      }
    },
    async deleteSession(sessionID: string, directory?: string) {
      await client.session.delete({ sessionID, directory: directory ?? opts.directory });
      ingestor.handle({
        id: `write:${sessionID}:deleted`,
        type: "session.deleted",
        properties: {
          sessionID,
          info: {
            id: sessionID,
            directory: directory ?? opts.directory ?? "",
            title: "",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      } as Event);
    },
    indexSessions() {
      return sessionImport.indexSessions();
    },
    restorePendingPrompts(directories: Set<string | undefined>) {
      return sessionImport.restorePendingPrompts(directories);
    },
    refreshSessions(guard?: OpencodeSyncGuard) {
      return sessionImport.refreshSessions(guard);
    },
    importSession: sessionImport.importSession,
    rebuildSession: sessionImport.rebuildSession,
  };

  /**
   * Re-read the backend's own pending asks on a clock of its own.
   *
   * An ask raised while the event stream was between connections never reaches
   * us as `permission.asked`, and the syncs that would replay it are driven by
   * the UI — a reader that is closed, asleep, or simply not polling leaves the
   * ask unseen and the session reading as busy with no card. The connection
   * owns the truth about its pending prompts, so it polls for them itself;
   * the ingestor's inflight set makes a re-poll of an ask already handled a
   * no-op.
   */
  const restorePending = () => {
    void sessionImport.restorePendingPrompts(sessionImport.knownDirectories).catch((err) =>
      console.error("opencode pending prompt restore failed:", err),
    );
  };
  // Once at startup, not one interval period in. The gap this closes is not
  // theoretical: a question someone left unanswered is invisible for the first
  // 30 seconds of every launch, which reads as the question never being asked
  // at all — no card, and no marker on the session that is waiting.
  restorePending();
  const restoreTimer = setInterval(restorePending, RESTORE_POLL_MS);
  return api;
}
