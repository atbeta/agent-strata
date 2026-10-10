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
  extension?: "opencode";
}

export interface CommandInfo {
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";
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

export async function getJson<T>(p: string): Promise<T> {
  const res = await fetch(api(p));
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
  return (await res.json()) as T;
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

export function readCapabilities(sessionId: string): Promise<SessionCapabilities> {
  return getJson<SessionCapabilities>(`/sessions/${encodeURIComponent(sessionId)}/capabilities`);
}

export function readCommands(sessionId: string): Promise<CommandInfo[] | undefined> {
  return readOpencode<CommandInfo[]>(sessionId, "/command");
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
 * save it from this page instead.
 */
export async function downloadExport(sessionId: string): Promise<void> {
  const res = await fetch(api(`/export?session_id=${encodeURIComponent(sessionId)}`));
  await throwOnError(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = exportFileName(sessionId);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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

export async function deleteSession(id: string): Promise<void> {
  await throwOnError(await fetch(api(`/sessions/${encodeURIComponent(id)}`), { method: "DELETE" }));
}

export async function abortSession(id: string): Promise<void> {
  const res = await fetch(api(`/sessions/${encodeURIComponent(id)}/abort`), { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? t("api.err.service", { status: res.status }));
  }
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

async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? t("api.err.service", { status: res.status }));
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

export function fmtUsd(n: number) {
  return `$${n.toFixed(4)}`;
}

/** Placeholder workspaces the adapter emits before a real directory is known. */
export function realWorkspace(ws?: string | null): string | undefined {
  if (!ws || ws === "unknown" || ws === "no workspace") return undefined;
  return ws;
}

export const STATUS_DOT: Record<string, string> = {
  active: "bg-status-active",
  completed: "bg-status-completed",
  error: "bg-status-error",
  cancelled: "bg-status-cancelled",
};

/**
 * Dead today — nothing imports it — but kept so the status vocabulary has one
 * home. Values are dictionary keys rather than finished words: a caller renders
 * them with `t()` instead of freezing a language into a module-level object.
 */
export const STATUS_LABEL: Record<string, MessageKey> = {
  active: "api.status.active",
  completed: "api.status.completed",
  error: "api.status.error",
  cancelled: "api.status.cancelled",
};
