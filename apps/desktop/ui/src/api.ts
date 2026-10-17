import { inDesktopShell } from "./shell";
import { t } from "./i18n";
import type { MessageKey } from "./locales/zh";

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

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "image"; mime: string; data?: string; uri?: string }
  | { type: "file_ref"; path: string; range?: { start: number; end: number } };

export interface ToolCallView {
  call_id: string;
  tool: string;
  input: Record<string, unknown>;
  status: "pending" | "ok" | "error" | "interrupted";
  output?: string;
  latency_ms?: number;
  permission?: {
    request_id: string;
    decision?: "allow" | "deny";
    by?: "user" | "policy" | "auto";
    rule_id?: string;
    reason?: string;
  };
  /** Declaration order among the calls of this assistant message, starting at 0. */
  order?: number;
  /** The assistant message this call belongs to, when the backend names one. */
  msg_id?: string;
  /** CASF id of the child session a task tool opened. */
  child_session_id?: string;
}

export interface Turn {
  turn_id: string;
  user?: ContentBlock[];
  assistant: {
    content: ContentBlock[];
    msg_id?: string;
    partial?: boolean;
    model?: string;
    usage?: {
      input: number;
      output: number;
      reasoning?: number;
      cache_read?: number;
      cache_write?: number;
    };
    cost_usd?: number;
    latency_ms?: number;
    error?: string;
  }[];
  tool_calls: ToolCallView[];
  reverted?: boolean;
  /** a divider after this turn */
  compaction?: boolean;
}

export interface PendingPermission {
  request_id: string;
  decision?: "allow" | "deny";
  by?: "user" | "policy" | "auto";
  rule_id?: string;
  reason?: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface PendingQuestion {
  request_id: string;
  questions: {
    question: string;
    header: string;
    options: QuestionOption[];
    multiple?: boolean;
    custom?: boolean;
  }[];
}

export interface FileEdit {
  change: "add" | "modify" | "delete";
  additions: number;
  deletions: number;
  /** absent when no tool call explains this change — usually a shell command */
  diff?: string;
  call_id?: string;
  /** index into SessionView.turns, -1 when the turn is not in this session */
  turn_index: number;
  whole_file?: boolean;
}

export interface FileChange {
  path: string;
  change: "add" | "modify" | "delete";
  count: number;
  /** summed across every recorded change, so a lower bound when unexplained */
  additions: number;
  deletions: number;
  edits: FileEdit[];
  /** at least one recorded change has no diff to show */
  unexplained: boolean;
}

export interface SessionView {
  session_id: string;
  backend: string;
  workspace?: string;
  title?: string;
  /** set when this session was opened by a parent; the header links back */
  parent_session_id?: string;
  status: string;
  busy?: boolean;
  revert_turn_id?: string;
  turns: Turn[];
  pending_permissions: PendingPermission[];
  pending_questions?: PendingQuestion[];
  plan?: { content: string; status: "pending" | "in_progress" | "completed" }[];
  files_changed: FileChange[];
  totals: SessionRow["totals"] & {
    reasoning: number;
    tool_errors: number;
    permissions_denied: number;
  };
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

export interface Connection {
  id: string;
  backend: string;
  baseUrl: string;
  name?: string;
  directory?: string;
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
  prompt?: boolean;
  abort?: boolean;
  commands?: boolean;
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

export async function getJson<T>(p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(api(p), init);
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
  return (await res.json()) as T;
}

/**
 * The first read races the service, which is spawned beside the window and is
 * not listened for before the page paints. A connection failure is that race;
 * an HTTP error is the service already answering, and waiting would only hide it.
 */
export async function getJsonWhenUp<T>(path: string): Promise<T> {
  if (!inDesktopShell()) return getJson(path);
  const deadline = Date.now() + 8_000;
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
  const res = await fetch(api(opencodePath(sessionId, path, query)), { signal });
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
  const res = await fetch(api("/desktop/editor"), {
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
    await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/mcp`), {
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
  const res = await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(name)}/auth`), {
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
  const res = await fetch(
    api(`/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(name)}/auth/callback`),
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
    await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(name)}/connect`), {
      method: "POST",
    }),
  );
}

export async function disconnectMcp(sessionId: string, name: string): Promise<void> {
  await throwOnError(
    await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(name)}/disconnect`), {
      method: "POST",
    }),
  );
}

export function findFiles(sessionId: string, query: string, signal?: AbortSignal): Promise<string[] | undefined> {
  return readOpencode<string[]>(sessionId, "/find/file", { query, limit: 20, dirs: "false" }, signal);
}

export async function sendPrompt(sessionId: string, parts: PromptPart[], choice: PromptChoice): Promise<void> {
  await throwOnError(
    await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/prompt`), {
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
    await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/command`), {
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

export function exportFileName(sessionId: string): string {
  return `strata-${sessionId.replace(/[^\w.-]+/g, "_")}.ndjson`;
}

/**
 * The shell's page and the service are different origins, so a link to the
 * export would be a cross-site navigation the service refuses. Fetch it and
 * save it from this page instead. In the desktop shell a webview download
 * drops into ~/Downloads without asking, so the save goes through a native
 * panel — and its answer comes back so the button can say where it went.
 */
export async function downloadExport(sessionId: string): Promise<string | undefined> {
  const res = await fetch(api(`/export?session_id=${encodeURIComponent(sessionId)}`));
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
  const res = await fetch(api(`/sessions/${encodeURIComponent(id)}/import`), { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? t("api.err.service", { status: res.status }));
  }
}

export async function renameSession(id: string, title: string): Promise<void> {
  const res = await fetch(api(`/sessions/${encodeURIComponent(id)}/rename`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  await throwOnError(res);
}

export async function archiveSession(id: string): Promise<void> {
  await throwOnError(await fetch(api(`/sessions/${encodeURIComponent(id)}/archive`), { method: "POST" }));
}

export async function abortSession(id: string): Promise<void> {
  const res = await fetch(api(`/sessions/${encodeURIComponent(id)}/abort`), { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? t("api.err.service", { status: res.status }));
  }
}

export async function revertSession(id: string, messageId: string): Promise<void> {
  await throwOnError(
    await fetch(api(`/sessions/${encodeURIComponent(id)}/revert`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_id: messageId }),
    }),
  );
}

export async function unrevertSession(id: string): Promise<void> {
  await throwOnError(await fetch(api(`/sessions/${encodeURIComponent(id)}/unrevert`), { method: "POST" }));
}

export async function forkSession(id: string, messageId: string): Promise<string> {
  const res = await fetch(api(`/sessions/${encodeURIComponent(id)}/fork`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: messageId }),
  });
  await throwOnError(res);
  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function summarizeSession(id: string): Promise<void> {
  await throwOnError(await fetch(api(`/sessions/${encodeURIComponent(id)}/summarize`), { method: "POST" }));
}

/** Publishes the session; resolves with its share URL when the backend hands one back. */
export async function shareSession(id: string): Promise<string | undefined> {
  const res = await fetch(api(`/sessions/${encodeURIComponent(id)}/share`), { method: "POST" });
  await throwOnError(res);
  const body = (await res.json().catch(() => ({}))) as { url?: string | null };
  return body.url ?? undefined;
}

export async function unshareSession(id: string): Promise<void> {
  await throwOnError(await fetch(api(`/sessions/${encodeURIComponent(id)}/unshare`), { method: "POST" }));
}

export async function respondQuestion(
  requestId: string,
  decision: "reply" | "reject",
  answers?: string[][],
): Promise<void> {
  const res = await fetch(api(`/questions/${encodeURIComponent(requestId)}/respond`), {
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
  const res = await fetch(api(`/permissions/${encodeURIComponent(requestId)}/respond`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, scope }),
  });
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
}

/** Whether this session stops asking, or follows the shared policy. */
export type SessionPolicyMode = "auto" | "inherit";

export async function readSessionPolicy(id: string): Promise<SessionPolicyMode> {
  const res = await fetch(api(`/sessions/${encodeURIComponent(id)}/policy`));
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
  const body = (await res.json()) as { mode?: string };
  return body.mode === "auto" ? "auto" : "inherit";
}

export async function setSessionPolicy(id: string, mode: SessionPolicyMode): Promise<void> {
  const res = await fetch(api(`/sessions/${encodeURIComponent(id)}/policy`), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
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
  const res = await fetch(api(`/connections/${encodeURIComponent(connectionId)}/providers/${encodeURIComponent(providerId)}`), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  await throwOnError(res);
}

export async function removeProviderKey(connectionId: string, providerId: string): Promise<void> {
  const res = await fetch(api(`/connections/${encodeURIComponent(connectionId)}/providers/${encodeURIComponent(providerId)}`), {
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
  const res = await fetch(api(`/connections/${encodeURIComponent(connectionId)}/providers/${encodeURIComponent(providerId)}/oauth`), {
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
  const res = await fetch(
    api(`/connections/${encodeURIComponent(connectionId)}/providers/${encodeURIComponent(providerId)}/oauth/callback`),
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

export type OpencodeLaunch = {
  mode: OpencodeLaunchMode;
  state: "starting" | "running" | "missing" | "restarting" | "stopped" | "external" | "unmanaged";
  url?: string;
};

export function readOpencodeLaunch(): Promise<OpencodeLaunch> {
  return getJson<OpencodeLaunch>("/desktop/opencode");
}

export async function saveOpencodeMode(
  mode: OpencodeLaunchMode,
): Promise<{ mode: OpencodeLaunchMode; applied: "next-launch" }> {
  const res = await fetch(api("/desktop/opencode"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  await throwOnError(res);
  return (await res.json()) as { mode: OpencodeLaunchMode; applied: "next-launch" };
}

export async function savePolicy(policy: Policy): Promise<void> {
  const res = await fetch(api("/policy"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(policy),
  });
  await throwOnError(res);
}

export async function clearPolicy(): Promise<void> {
  await throwOnError(await fetch(api("/policy"), { method: "DELETE" }));
}

export async function syncBackend(): Promise<{ connected: boolean; imported: number }> {
  const res = await fetch(api("/sync"), { method: "POST" });
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
  const res = await fetch(api("/connect"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? t("api.err.service", { status: res.status }));
  return data.id!;
}

export async function disconnectBackend(id: string): Promise<void> {
  await throwOnError(await fetch(api(`/connections/${encodeURIComponent(id)}`), { method: "DELETE" }));
}

export async function testPolicy(body: {
  tool: string;
  input: Record<string, unknown>;
  policy?: unknown;
}): Promise<PolicyDecision> {
  const res = await fetch(api("/policy/test"), {
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

export function listTerminals(sessionId: string): Promise<{ sessions: PtySession[] }> {
  return getJson(`/sessions/${encodeURIComponent(sessionId)}/terminal`, { signal: AbortSignal.timeout(10_000) });
}

export async function openTerminal(sessionId: string, title?: string): Promise<PtySession> {
  // No timeout meant a stuck spawn pinned the pane's `opening` latch forever
  // and every later "+" press silently no-oped.
  const res = await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/terminal`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as PtySession & { error?: string };
  if (!res.ok) throw new Error(data.error ?? t("api.err.service", { status: res.status }));
  return data;
}

export async function closeTerminal(sessionId: string, ptyId: string): Promise<void> {
  await throwOnError(
    await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/terminal/${encodeURIComponent(ptyId)}`), {
      method: "DELETE",
    }),
  );
}

export async function resizeTerminal(sessionId: string, ptyId: string, rows: number, cols: number): Promise<void> {
  await throwOnError(
    await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/terminal/${encodeURIComponent(ptyId)}/size`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows, cols }),
    }),
  );
}

/** The page socket. Strata dials OpenCode; this URL has neither the password nor the ticket. */
export function terminalSocket(sessionId: string, ptyId: string): string {
  const path = `/sessions/${encodeURIComponent(sessionId)}/terminal/${encodeURIComponent(ptyId)}/connect`;
  if (inDesktopShell()) return `ws://127.0.0.1:7700${path}`;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api${path}`;
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
