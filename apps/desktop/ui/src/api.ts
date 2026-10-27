import { inDesktopShell } from "./shell";
import { t } from "./i18n";
import type { MessageKey } from "./locales/zh";
import type {
  FileChangeView,
  FileEditView,
  PermissionInfo,
  QuestionOption,
  QuestionPrompt,
  SessionView,
  ToolCallView,
  Turn,
} from "../../../../packages/projector/src/index";

export type { ContentBlock } from "../../../../packages/schema/src/index";
export type {
  FileChangeView as FileChange,
  FileEditView as FileEdit,
  PermissionInfo as PendingPermission,
  QuestionOption,
  QuestionPrompt as PendingQuestion,
  SessionView,
  ToolCallView,
  Turn,
};

export interface SessionRow {
  summary: {
    session_id: string;
    backend: string;
    workspace: string | null;
    title: string | null;
    started_at: string;
    last_ts: string;
    last_seq: number;
  };
  status: string;
  busy?: boolean;
  title?: string;
  workspace?: string;
  /** set for subagent / child sessions; the sidebar hides these */
  parent?: string;
  archived?: boolean;
  deleted?: boolean;
  needs_input?: boolean;
  /**
   * A dev server the session's shell has not exited. Absent unless the command
   * is one that stays up and the call is still pending.
   */
  shell?: { command: string; detail: string; since?: string };
  /**
   * The connection this session belongs to, when a connected backend claims
   * it. Two instances of the same backend kind are otherwise
   * indistinguishable in the list — `backend` only says which kind, never
   * which server.
   */
  connection_id?: string;
  totals: {
    input: number;
    output: number;
    cost_usd: number;
    tool_calls: number;
    cache_read: number;
    cache_write: number;
  };
}

export interface SessionsResponse {
  sessions: SessionRow[];
  aggregate: { total: { cost_usd: number; input: number; output: number } };
  /** The store had more than the requested page. */
  more?: boolean;
}

/** One full-text hit inside a session. `snippet` brackets its matches: "…lo[ad]ing…". */
export interface SearchHit {
  seq: number;
  ts: string;
  type: string;
  /** Which turn the hit belongs to. Tool results name their call instead. */
  turn_id: string | null;
  call_id: string | null;
  snippet: string;
}

/** The last turns of a session's view, and where they sit in the whole. */
export interface ViewTail extends Omit<SessionView, "files_changed"> {
  turn_offset: number;
  /** the turn just before the tail, so a reader can tell the two still line up */
  prev_turn_id: string | null;
  /** names the files list; sending it back leaves an unchanged list out */
  files_key: string;
  files_changed?: SessionView["files_changed"];
}

export interface TurnPair {
  a_turn: { turn_id: string; first_user_text: string | null } | null;
  b_turn: { turn_id: string; first_user_text: string | null } | null;
  same_prompt: boolean;
  tools: { only_a: string[]; only_b: string[]; shared: string[] };
  delta: { input: number; output: number; cost_usd: number; duration_ms: number | null };
}

export interface SessionComparison {
  a: { session_id: string; backend: string; model?: string; totals: SessionView["totals"] };
  b: { session_id: string; backend: string; model?: string; totals: SessionView["totals"] };
  turn_pairs: TurnPair[];
  summary: {
    turn_pairs: number;
    same_prompt: number;
    shared_tools: string[];
    only_a_tools: string[];
    only_b_tools: string[];
    delta_totals: { input: number; output: number; cost_usd: number };
  };
}

export interface PendingAsk {
  request_id: string;
  session_id: string;
  tool: string;
  input: Record<string, unknown>;
  asked_at: string;
  call_id?: string;
}

export interface StrataEvent {
  id: string;
  session_id: string;
  backend: string;
  type: string;
  seq: number;
  ts: string;
  data: Record<string, unknown>;
}

export type ConnectionPlacement = "embed" | "external";

/** What `/connections` says the backends are doing, once it has answered. */
export type ConnectionPhaseName = "connected" | "attaching" | "failed" | "missing" | "idle";

export interface ConnectionAttempt {
  endpoint: string;
  backend: string;
  phase: "retrying" | "failed";
  error?: string;
  placement?: ConnectionPlacement;
}

export interface ConnectionsResponse {
  connections: Connection[];
  attempts?: ConnectionAttempt[];
  phase?: ConnectionPhaseName;
}

export interface Connection {
  id: string;
  backend: string;
  baseUrl: string;
  name?: string;
  directory?: string;
  /** OpenCode only: the shell spawned this server, or it is someone else's. */
  placement?: ConnectionPlacement;
  capabilities?: {
    prompt: boolean;
    abort: boolean;
    models: boolean;
    agents: boolean;
    import: boolean;
    manage?: boolean;
    /** live workspace state this backend can be read for; absent for a backend with none */
    extension?: "opencode";
  };
}

export interface VcsInfo {
  /** null outside a git repository */
  branch?: string | null;
  default_branch?: string | null;
}

export interface OptionsResponse {
  models: {
    providerID: string;
    modelID: string;
    name: string;
    variants?: string[];
    context?: number;
  }[];
  agents: { name: string; mode?: string }[];
}

/** One piece of a prompt; paths are relative to the session's workspace. */
export type PromptPart =
  | { type: "text"; text: string }
  | { type: "file_ref"; path: string; mention?: { start: number; end: number } }
  | { type: "attachment"; mime: string; url: string; filename?: string };

/** A command takes its words as arguments, so its files cannot point into any text. */
export type CommandPart =
  | Extract<PromptPart, { type: "attachment" }>
  | { type: "file_ref"; path: string; mention?: never };

export interface SessionCapabilities {
  connected: boolean;
  /** the connection driving this session, when one is */
  connection_id?: string;
  prompt?: boolean;
  abort?: boolean;
  commands?: boolean;
  /** a leading `!` runs a shell command with the agent answering */
  shell?: boolean;
  attachments?: boolean;
  /** rename, archive, delete */
  manage?: boolean;
  revert?: boolean;
  fork?: boolean;
  summarize?: boolean;
  share?: boolean;
  extension?: "opencode";
}

export interface CommandInfo {
  name: string;
  description?: string;
  /** "builtin" marks a command this app runs itself; the rest come from the backend. */
  source?: "command" | "mcp" | "skill" | "builtin";
  /** the command cannot run until the reader types something after the name */
  argument?: boolean;
  hints?: string[];
}

export interface PromptChoice {
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
}

export interface PolicyCondition {
  matches?: string;
  equals?: string | number | boolean;
  glob?: string;
}

export interface PolicyRule {
  id: string;
  effect: "allow" | "deny" | "ask";
  tool: string;
  when?: Record<string, PolicyCondition>;
  reason?: string;
}

export interface Policy {
  version: 1;
  default: "ask" | "allow" | "deny";
  rules: PolicyRule[];
}

export interface PolicyResponse {
  policy: Policy | null;
  file: string | null;
}

export interface PolicyDecision {
  decision: "allow" | "deny" | "ask";
  rule_id?: string;
  reason?: string;
}

/** Packaged webview has no Vite proxy, so it talks to the sidecar directly. */
const DESKTOP_SERVICE = "http://127.0.0.1:7700";

export const api = (p: string) => (inDesktopShell() ? `${DESKTOP_SERVICE}${p}` : `/api${p}`);

/**
 * The capability token the service expects, when there is one.
 *
 * The desktop shell generates one per launch and the service asks for it on
 * everything but the health check. A browser tab has no way to read it — the
 * dev proxy adds the header itself — so the read is a no-op there.
 *
 * It is read once and kept: the token does not change while the app is open,
 * and a page that asked again would only pay for the same answer twice.
 */
let tokenRead: Promise<string> | undefined;

export function apiToken(): Promise<string> {
  if (!inDesktopShell()) return Promise.resolve("");
  tokenRead ??= (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return (await invoke<string>("api_token")) ?? "";
    } catch {
      // A shell that cannot answer has no token to present, and a service
      // without one asks for nothing.
      return "";
    }
  })();
  return tokenRead;
}

/** The request with the token folded in, when the service expects one. */
export async function withAuth(init?: RequestInit): Promise<RequestInit> {
  const token = await apiToken();
  if (!token) return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * The one way this page talks to the service.
 *
 * Every request goes through here, so the token cannot be left off one of
 * them by accident: a page that half works is worse than one that does not.
 */
export async function apiFetch(p: string, init?: RequestInit): Promise<Response> {
  return fetch(api(p), await withAuth(init));
}

/**
 * The address of a stream, with the token the service expects.
 *
 * An EventSource cannot carry a header — that is the browser's rule, not
 * ours — so the token rides in the query. The address is only known once the
 * shell has handed the token over, which is why this is a promise.
 */
export async function streamUrl(p: string): Promise<string> {
  const token = await apiToken();
  const url = api(p);
  if (!token) return url;
  return `${url}?${new URLSearchParams({ token }).toString()}`;
}

export async function getJson<T>(p: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(p, init);
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
  return (await res.json()) as T;
}

/**
 * How long a first read waits for the sidecar before giving up.
 *
 * The startup screen owns this wait now; the resource should not turn a slow
 * launch into a red error a few seconds before the service would have answered.
 * Keeping the two numbers together means the screen and the reads it waits on
 * cannot disagree about how long "still starting" lasts.
 */
export const SERVICE_BOOT_MS = 30_000;

/**
 * The first read races the service, which is spawned beside the window and is
 * not listened for before the page paints. A connection failure is that race;
 * an HTTP error is the service already answering, and waiting would only hide it.
 */
export async function getJsonWhenUp<T>(path: string): Promise<T> {
  if (!inDesktopShell()) return getJson(path);
  const deadline = Date.now() + SERVICE_BOOT_MS;
  for (;;) {
    try {
      return await getJson<T>(path);
    } catch (err) {
      if (!(err instanceof TypeError) || Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** A read of the session's OpenCode backend beyond its record: files, commands, VCS. */
export function opencodePath(sessionId: string, path: string, query?: Record<string, string | number>): string {
  const q = query ? new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : "";
  return `/sessions/${encodeURIComponent(sessionId)}/opencode${path}${q ? `?${q}` : ""}`;
}

/** Undefined when the session's backend has no OpenCode extension: another backend, or not connected. */
export async function readOpencode<T>(
  sessionId: string,
  path: string,
  query?: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const res = await apiFetch(opencodePath(sessionId, path, query), { signal });
  if (res.status === 404) return undefined;
  await throwOnError(res);
  return (await res.json()) as T;
}

export function readVcs(sessionId: string): Promise<VcsInfo | undefined> {
  return readOpencode<VcsInfo>(sessionId, "/vcs");
}

export type ReviewDiff = {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
};

/** The session's current file changes. `messageID` limits them to one reply. */
export function readSessionDiff(sessionId: string, messageID?: string): Promise<ReviewDiff[] | undefined> {
  return readOpencode<ReviewDiff[]>(sessionId, "/session/diff", messageID ? { messageID } : undefined);
}

/** `git` is the worktree. `branch` is the worktree against the default branch. */
export function readVcsDiff(sessionId: string, mode: "git" | "branch"): Promise<ReviewDiff[] | undefined> {
  return readOpencode<ReviewDiff[]>(sessionId, "/vcs/diff", { mode });
}

export type FileNode = {
  name: string;
  path: string;
  absolute: string;
  type: "file" | "directory";
  ignored: boolean;
};

export type FileBody = {
  type: "text" | "binary";
  content: string;
};

export function listFiles(sessionId: string, path: string): Promise<FileNode[] | undefined> {
  return readOpencode<FileNode[]>(sessionId, "/file", { path });
}

export function readFileBody(sessionId: string, path: string): Promise<FileBody | undefined> {
  return readOpencode<FileBody>(sessionId, "/file/content", { path });
}

export async function openInEditor(editor: "cursor" | "vscode", path: string): Promise<void> {
  const res = await apiFetch("/desktop/editor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ editor, path }),
  });
  await throwOnError(res);
}

export function readCapabilities(sessionId: string): Promise<SessionCapabilities> {
  return getJson<SessionCapabilities>(`/sessions/${encodeURIComponent(sessionId)}/capabilities`);
}

export function readCommands(sessionId: string): Promise<CommandInfo[] | undefined> {
  return readOpencode<CommandInfo[]>(sessionId, "/command");
}

export type McpServerStatus = {
  status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration";
  error?: string;
};
export type SkillInfo = { name: string; description?: string; location: string; content: string };

export function readMcp(sessionId: string): Promise<Record<string, McpServerStatus> | undefined> {
  return readOpencode<Record<string, McpServerStatus>>(sessionId, "/mcp");
}

export type LspServer = { id: string; name: string; root: string; status: "connected" | "error" };

export function readLsp(sessionId: string): Promise<LspServer[] | undefined> {
  return readOpencode<LspServer[]>(sessionId, "/lsp");
}

export function readSkills(sessionId: string): Promise<SkillInfo[] | undefined> {
  return readOpencode<SkillInfo[]>(sessionId, "/skill");
}

export async function addMcp(
  sessionId: string,
  server: { name: string; command?: string; url?: string },
): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(server),
    }),
  );
}

export async function beginMcpLogin(
  sessionId: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ url: string } | { ok: true }> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(name)}/auth`, {
    method: "POST",
    signal,
  });
  await throwOnError(res);
  return (await res.json()) as { url: string } | { ok: true };
}

export async function finishMcpLogin(
  sessionId: string,
  name: string,
  code: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await apiFetch(
    `/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(name)}/auth/callback`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      signal,
    },
  );
  await throwOnError(res);
}

export async function connectMcp(sessionId: string, name: string): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(name)}/connect`, {
      method: "POST",
    }),
  );
}

export async function disconnectMcp(sessionId: string, name: string): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(name)}/disconnect`, {
      method: "POST",
    }),
  );
}

export function findFiles(sessionId: string, query: string, signal?: AbortSignal): Promise<string[] | undefined> {
  return readOpencode<string[]>(sessionId, "/find/file", { query, limit: 20, dirs: "false" }, signal);
}

export async function sendPrompt(sessionId: string, parts: PromptPart[], choice: PromptChoice): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts, ...choice }),
    }),
  );
}

export async function runCommand(
  sessionId: string,
  command: { name: string; args: string; parts?: CommandPart[] },
  choice: PromptChoice,
): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: command.name,
        arguments: command.args,
        ...(command.parts?.length ? { parts: command.parts } : {}),
        ...choice,
      }),
    }),
  );
}

/**
 * A command for the session's shell, the agent answering for it.
 *
 * Not a local exec: this is OpenCode's own `!` behaviour, and the reply comes
 * back as an ordinary turn. Whether the command is allowed is the backend's
 * call, surfacing as the same permission asks a tool call would produce.
 */
export async function runShell(sessionId: string, command: string, choice: PromptChoice): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/shell`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, ...choice }),
    }),
  );
}

export function exportFileName(sessionId: string): string {
  return `strata-${sessionId.replace(/[^\w.-]+/g, "_")}.ndjson`;
}

/** One session's usage on one local day — the grain the overview's windows
 *  actually measure, so a session touched today no longer drags its whole
 *  lifetime into "today". */
export interface DailyUsageRow {
  session_id: string;
  /** Local day in the requested tz, `YYYY-MM-DD`. */
  day: string;
  /** The model the message was made by, when the backend named one. */
  model: string | null;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  messages: number;
  tool_calls: number;
  tool_errors: number;
}

export function fetchDailyUsage(tz: string): Promise<DailyUsageRow[]> {
  return getJson<{ rows: DailyUsageRow[] }>(`/usage/daily?tz=${encodeURIComponent(tz)}`).then(
    (r) => r.rows,
  );
}

/**
 * The shell's page and the service are different origins, so a link to the
 * export would be a cross-site navigation the service refuses. Fetch it and
 * save it from this page instead. In the desktop shell a webview download
 * drops into ~/Downloads without asking, so the save goes through a native
 * panel — and its answer comes back so the button can say where it went.
 */
export async function downloadExport(sessionId: string): Promise<string | undefined> {
  const res = await apiFetch(`/export?session_id=${encodeURIComponent(sessionId)}`);
  await throwOnError(res);
  const blob = await res.blob();
  if (inDesktopShell()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const saved = await invoke<string | null>("save_export", {
      fileName: exportFileName(sessionId),
      contents: new Uint8Array(await blob.arrayBuffer()),
    });
    return saved ?? undefined;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(sessionId);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return undefined;
}

/**
 * Newest stored sequence number for a session, or 0.
 *
 * Covers `(session_id, seq)`, so this is an index probe: it answers "has this
 * session moved" for a few hundred bytes, against a projection that has to be
 * rebuilt from every event it ever received. A reader that has to notice a
 * change it was not told about pays this instead of the view.
 *
 * It counts *stored* events. A message still being written lives in the
 * service's live overlay and never reaches the log, so a moving head means
 * something durable landed — a user turn, a finished message, a tool result —
 * not that the text on screen is still changing.
 */
export async function readHead(id: string): Promise<number> {
  const r = await getJson<{ events: { seq: number }[] }>(
    `/events?session_id=${encodeURIComponent(id)}&order=desc&limit=1`,
  );
  return r.events[0]?.seq ?? 0;
}

export async function readViewTail(id: string, turns: number, filesKey?: string): Promise<ViewTail> {
  const q = new URLSearchParams({ tail: String(turns) });
  if (filesKey) q.set("files_key", filesKey);
  return getJson<ViewTail>(`/sessions/${encodeURIComponent(id)}/view?${q}`);
}

/** Full-text search inside one session. Backed by the store's FTS index. */
export async function searchSession(
  id: string,
  q: string,
  limit = 300,
): Promise<{ hits: SearchHit[]; more: boolean }> {
  return getJson<{ hits: SearchHit[]; more: boolean }>(
    `/sessions/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
}

export async function importSession(id: string): Promise<void> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}/import`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? t("api.err.service", { status: res.status }));
  }
}

export async function renameSession(id: string, title: string): Promise<void> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  await throwOnError(res);
}

export async function archiveSession(id: string): Promise<void> {
  await throwOnError(await apiFetch(`/sessions/${encodeURIComponent(id)}/archive`, { method: "POST" }));
}

export async function abortSession(id: string): Promise<void> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? t("api.err.service", { status: res.status }));
  }
}

export async function revertSession(id: string, messageId: string): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(id)}/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_id: messageId }),
    }),
  );
}

export async function unrevertSession(id: string): Promise<void> {
  await throwOnError(await apiFetch(`/sessions/${encodeURIComponent(id)}/unrevert`, { method: "POST" }));
}

/** Opens a new session on another connection, with this session's briefing as its first prompt. */
export async function handoffSession(id: string, connectionId: string): Promise<string> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connection_id: connectionId }),
  });
  await throwOnError(res);
  const data = (await res.json()) as { id: string };
  return data.id;
}

/**
 * A new session with this one's messages: all of them, those before `before`,
 * or those up to and including `through`.
 */
export async function forkSession(
  id: string,
  at: { before: string } | { through: string } | "all",
): Promise<string> {
  const body = at === "all" ? {} : "before" in at ? { message_id: at.before } : { message_id: at.through, through: true };
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}/fork`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await throwOnError(res);
  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function summarizeSession(
  id: string,
  model?: { providerID: string; modelID: string },
): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(id)}/summarize`, {
      method: "POST",
      headers: model ? { "content-type": "application/json" } : undefined,
      body: model ? JSON.stringify({ model }) : undefined,
    }),
  );
}

/** Publishes the session; resolves with its share URL when the backend hands one back. */
export async function shareSession(id: string): Promise<string | undefined> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}/share`, { method: "POST" });
  await throwOnError(res);
  const body = (await res.json().catch(() => ({}))) as { url?: string | null };
  return body.url ?? undefined;
}

export async function unshareSession(id: string): Promise<void> {
  await throwOnError(await apiFetch(`/sessions/${encodeURIComponent(id)}/unshare`, { method: "POST" }));
}

export async function respondQuestion(
  requestId: string,
  decision: "reply" | "reject",
  answers?: string[][],
): Promise<void> {
  const res = await apiFetch(`/questions/${encodeURIComponent(requestId)}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, answers }),
  });
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
}

export async function respondPermission(
  requestId: string,
  decision: "allow" | "deny",
  scope?: "once" | "always",
): Promise<void> {
  const res = await apiFetch(`/permissions/${encodeURIComponent(requestId)}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, scope }),
  });
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
}

/** Whether this session stops asking, or follows the shared policy. */
export type SessionPolicyMode = "auto" | "inherit";

export async function readSessionPolicy(id: string): Promise<SessionPolicyMode> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}/policy`);
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
  const body = (await res.json()) as { mode?: string };
  return body.mode === "auto" ? "auto" : "inherit";
}

export async function setSessionPolicy(id: string, mode: SessionPolicyMode): Promise<void> {
  const res = await apiFetch(`/sessions/${encodeURIComponent(id)}/policy`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
}

export async function setGoal(sessionId: string, text: string): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/goal`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  );
}

export async function setGoalPaused(sessionId: string, paused: boolean): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/goal`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused }),
    }),
  );
}

export async function clearGoal(sessionId: string): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/goal`, { method: "DELETE" }),
  );
}

async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? t("api.err.service", { status: res.status }));
}

export interface ProviderPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: { label: string; value: string }[];
  when?: { key: string; op: "eq" | "neq"; value: string };
}

export interface ProviderMethod {
  index: number;
  type: "api" | "oauth";
  label: string;
  prompts?: ProviderPrompt[];
}

export interface ApiProvider {
  id: string;
  name: string;
  connected: boolean;
  methods: ProviderMethod[];
  /** An API key can be pasted, even though there is no sign-in method to pick. */
  canKey: boolean;
}

export interface OAuthStart {
  url: string;
  method: "auto" | "code";
  instructions: string;
}

export function listProviders(connectionId: string): Promise<{ providers: ApiProvider[] }> {
  return getJson(`/connections/${encodeURIComponent(connectionId)}/providers`);
}

export async function saveProviderKey(connectionId: string, providerId: string, key: string): Promise<void> {
  const res = await apiFetch(`/connections/${encodeURIComponent(connectionId)}/providers/${encodeURIComponent(providerId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  await throwOnError(res);
}

export async function removeProviderKey(connectionId: string, providerId: string): Promise<void> {
  const res = await apiFetch(`/connections/${encodeURIComponent(connectionId)}/providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
  await throwOnError(res);
}

export async function beginProviderLogin(
  connectionId: string,
  providerId: string,
  method: number,
  inputs?: Record<string, string>,
): Promise<OAuthStart> {
  const res = await apiFetch(`/connections/${encodeURIComponent(connectionId)}/providers/${encodeURIComponent(providerId)}/oauth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, ...(inputs ? { inputs } : {}) }),
  });
  await throwOnError(res);
  return (await res.json()) as OAuthStart;
}

export async function finishProviderLogin(
  connectionId: string,
  providerId: string,
  method: number,
  code: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const res = await apiFetch(
    `/connections/${encodeURIComponent(connectionId)}/providers/${encodeURIComponent(providerId)}/oauth/callback`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, ...(code ? { code } : {}) }),
      signal,
    },
  );
  await throwOnError(res);
}

export type OpencodeLaunchMode = "embed" | "external";

export type OpencodeRuntimeSource = "setting" | "env" | "path" | "missing" | "external";

/** What the shell found when it last inspected the local opencode binary. */
export type OpencodeRuntime = {
  source: OpencodeRuntimeSource;
  bin?: string;
  version?: string;
  error?: string;
  /** Unix seconds; the UI formats it in the reader's zone. */
  checked_at?: number;
};

export type OpencodeLaunch = {
  mode: OpencodeLaunchMode;
  state:
    | "starting"
    | "running"
    | "missing"
    | "restarting"
    | "stopped"
    | "external"
    | "authRequired"
    | "authFailed"
    | "unmanaged";
  url?: string;
  runtime?: OpencodeRuntime;
};

export function readOpencodeLaunch(): Promise<OpencodeLaunch> {
  return getJson<OpencodeLaunch>("/desktop/opencode");
}

export async function saveOpencodeMode(
  mode: OpencodeLaunchMode,
): Promise<{ mode: OpencodeLaunchMode; applied: "next-launch" }> {
  const res = await apiFetch("/desktop/opencode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  await throwOnError(res);
  return (await res.json()) as { mode: OpencodeLaunchMode; applied: "next-launch" };
}

export async function savePolicy(policy: Policy): Promise<void> {
  const res = await apiFetch("/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(policy),
  });
  await throwOnError(res);
}

export async function clearPolicy(): Promise<void> {
  await throwOnError(await apiFetch("/policy", { method: "DELETE" }));
}

export async function syncBackend(): Promise<{ connected: boolean; imported: number }> {
  const res = await apiFetch("/sync", { method: "POST" });
  const data = (await res.json().catch(() => ({}))) as {
    connected?: boolean;
    imported?: number;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error ?? t("api.err.service", { status: res.status }));
  return { connected: data.connected === true, imported: data.imported ?? 0 };
}

export async function connectBackend(body: {
  backend?: "opencode" | "acp";
  baseUrl?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  name?: string;
  directory?: string;
  username?: string;
  password?: string;
}): Promise<string> {
  const res = await apiFetch("/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? t("api.err.service", { status: res.status }));
  return data.id!;
}

export async function disconnectBackend(id: string): Promise<void> {
  await throwOnError(await apiFetch(`/connections/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

/** Drop a remembered address so the next launch does not dial it again. */
export async function forgetBackend(endpoint: string): Promise<void> {
  await throwOnError(
    await apiFetch("/connections/forget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }),
  );
}

export async function testPolicy(body: {
  tool: string;
  input: Record<string, unknown>;
  policy?: unknown;
}): Promise<PolicyDecision> {
  const res = await apiFetch("/policy/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as PolicyDecision & { error?: string };
  if (!res.ok) throw new Error(data.error ?? t("api.err.service", { status: res.status }));
  return data;
}

export interface PtySession {
  id: string;
  title: string;
  command: string;
  cwd: string;
  status: "running" | "exited";
}

export interface PtyShell {
  name: string;
  /** Reported so the picker can show which binary would actually run. It is not
   *  a capability: the service resolves the name to this path server-side. */
  path: string;
  /** Whether the backend will accept this name. False entries are reported
   *  rather than hidden, so a shell that is installed but not offered has a
   *  reason to show. */
  acceptable: boolean;
}

export interface PtyListing {
  sessions: PtySession[];
  shells: PtyShell[];
}

export function listTerminals(sessionId: string): Promise<PtyListing> {
  return getJson(`/sessions/${encodeURIComponent(sessionId)}/terminal`, { signal: AbortSignal.timeout(10_000) });
}

/**
 * `shell` is a name from the listing above, never a path: the service resolves
 * it against its own whitelist and refuses anything outside it, which is also
 * why an unknown name is a 400 rather than something to retry.
 */
export async function openTerminal(
  sessionId: string,
  opts: { title?: string; shell?: string } = {},
): Promise<PtySession> {
  const body: { title?: string; shell?: string } = {};
  if (opts.title) body.title = opts.title;
  if (opts.shell) body.shell = opts.shell;
  // No timeout meant a stuck spawn pinned the pane's `opening` latch forever
  // and every later "+" press silently no-oped.
  const res = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/terminal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as PtySession & { error?: string };
  if (!res.ok) throw new Error(data.error ?? t("api.err.service", { status: res.status }));
  return data;
}

export async function closeTerminal(sessionId: string, ptyId: string): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/terminal/${encodeURIComponent(ptyId)}`, {
      method: "DELETE",
    }),
  );
}

export async function resizeTerminal(sessionId: string, ptyId: string, rows: number, cols: number): Promise<void> {
  await throwOnError(
    await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/terminal/${encodeURIComponent(ptyId)}/size`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows, cols }),
    }),
  );
}

/**
 * The page socket. Strata dials OpenCode; this URL has neither the password nor the ticket.
 *
 * A WebSocket cannot carry a header either, so the token the service expects
 * rides in the query — the same place the event stream puts it.
 */
export async function terminalSocket(sessionId: string, ptyId: string): Promise<string> {
  const path = `/sessions/${encodeURIComponent(sessionId)}/terminal/${encodeURIComponent(ptyId)}/connect`;
  const base = inDesktopShell()
    ? `ws://127.0.0.1:7700${path}`
    : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api${path}`;
  const token = await apiToken();
  if (!token) return base;
  return `${base}?${new URLSearchParams({ token }).toString()}`;
}

/**
 * A command a session left running — a dev server, a watcher.
 *
 * The service owns it, which is why it has an id that outlives a turn. `pid` is
 * absent only when the spawn never produced one.
 *
 * The table outlives the process, so "not running" is not one thing: a command
 * that was stopped is stopped, one that vanished on its own is lost, and one
 * that was found still running after a restart — an orphan, cleaned up — is
 * neither.
 */
export interface DevProcess {
  id: string;
  session_id: string;
  command: string;
  cwd: string;
  pid?: number;
  started_at: number;
  exit_code: number | null;
  stopped: boolean;
  error?: string;
  last_line?: string;
  /** Where it is in its life. */
  state?: "running" | "stopped" | "lost" | "orphaned";
  /** The port it was asked to serve on, when the caller named one. */
  port?: number;
  /** Whether it has proved it can serve. */
  ready?: "yes" | "no" | "unknown";
  /** How long the port took to answer, when it answered. */
  ready_ms?: number;
  /** When it stopped, for a record that outlived its process. */
  stopped_at?: number;
}

export interface DevLogLine {
  at: number;
  stream: "out" | "err";
  text: string;
}

export function listDevProcesses(sessionId: string): Promise<{ processes: DevProcess[] }> {
  return getJson(`/dev?session=${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(10_000) });
}

/**
 * Every command every session left running.
 *
 * The overview answers "what is on port 3000" without knowing which session
 * started it, so the read is deliberately unscoped: the service keeps one
 * table and a reader with four sessions should not have to ask four times.
 */
export function listAllDevProcesses(): Promise<{ processes: DevProcess[] }> {
  return getJson(`/dev`, { signal: AbortSignal.timeout(10_000) });
}

export async function readDevLogs(
  processId: string,
  tail = 200,
): Promise<{ process: DevProcess; lines: DevLogLine[] }> {
  return getJson(`/dev/${encodeURIComponent(processId)}/logs?tail=${tail}`, {
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * What a stop achieved.
 *
 * A stop that leaves the port held is not a stop, and the reader has to be
 * told: the next command collides with it, and the collision looks like the
 * next command's fault.
 */
export interface DevStopResult {
  ok: boolean;
  clean: boolean;
  residual: number[];
  port?: number;
  port_free?: boolean;
}

export async function stopDevProcess(processId: string): Promise<DevStopResult> {
  const res = await apiFetch(`/dev/${encodeURIComponent(processId)}/stop`, { method: "POST" });
  if (!res.ok) await throwOnError(res);
  const result = (await res.json()) as DevStopResult;
  if (result.clean) return result;
  // The service says what survived, so the reader is told what survived
  // rather than being shown a stop that did not happen.
  const leftovers: string[] = [];
  if (result.residual.length > 0) leftovers.push(`still running: ${result.residual.join(", ")}`);
  if (result.port !== undefined && result.port_free === false) {
    leftovers.push(`port ${result.port} is still held`);
  }
  throw new Error(leftovers.length > 0 ? leftovers.join("; ") : "the command is still running");
}

/**
 * Dollars, at a precision that matches the size of the number.
 *
 * Four places on every figure is false precision once a session costs dollars
 * — `$5.9363` is noise past the cent — and throws away the only digit that
 * carries information when it costs fractions of one, where `$0.0013` would
 * otherwise round to `$0.00`.
 */
export function fmtUsd(n: number) {
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  return `$${n.toFixed(Math.abs(n) < 1 ? 4 : 2)}`;
}

/**
 * Always cents, for a column that is read down its length.
 *
 * `fmtUsd` widens to four places below a dollar so a lone session that cost
 * fractions of one does not print as `$0.00`. In a column where each row is
 * compared with the next, that rule makes the `$` step sideways row by row and
 * the decimal points never line up — the precision the reader wants least is
 * the one they cannot scan. Same figures, same order, aligned.
 */
export function fmtUsdFlat(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

/**
 * A duration at a size you can read at a glance.
 *
 * Milliseconds alone go to five digits on any real model call, and seconds alone
 * lose the sub-second tool calls that are the whole point of a timing view. Past
 * ten seconds the hundredths stop paying for the width they take, and past a
 * minute the figure wants to read as a clock rather than as a number.
 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} m ${String(Math.round((ms % 60_000) / 1_000)).padStart(2, "0")} s`;
}

/** Placeholder workspaces the adapter emits before a real directory is known. */
export function realWorkspace(ws?: string | null): string | undefined {
  if (!ws || ws === "unknown" || ws === "no workspace") return undefined;
  return ws;
}

/** A workspace's one-word name — the last path segment, or the root marker
 *  when the session sits at `/`. */
export function folderLabel(ws: string | null | undefined): string | undefined {
  const real = realWorkspace(ws ?? undefined);
  if (!real) return undefined;
  return real === "/" || real === "\\" ? t("path.root") : real.split(/[/\\]/).filter(Boolean).at(-1);
}

/**
 * The status vocabulary, in one place: which colour a dot takes, and which
 * dictionary key names it. Keys rather than finished words, so a caller renders
 * them with `t()` instead of freezing a language into a module-level object.
 */
export const STATUS_DOT: Record<string, string> = {
  active: "bg-status-active",
  completed: "bg-status-completed",
  error: "bg-status-error",
  cancelled: "bg-status-cancelled",
};

export const STATUS_LABEL: Record<string, MessageKey> = {
  active: "api.status.active",
  completed: "api.status.completed",
  error: "api.status.error",
  cancelled: "api.status.cancelled",
};

/**
 * The backend's own name, spelled the way its author does. `opencode` is a
 * product, not a lowercase word, and printing the raw field made a sidebar row
 * and the session's own popover disagree about what it is called.
 */
export function backendLabel(backend: string): string {
  if (backend === "opencode") return "OpenCode";
  if (backend === "acp") return "ACP";
  return backend;
}
