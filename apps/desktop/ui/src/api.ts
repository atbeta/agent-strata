import { inDesktopShell } from "./shell";

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
  totals: { input: number; output: number; cost_usd: number; tool_calls: number };
}

export interface SessionsResponse {
  sessions: SessionRow[];
  aggregate: { total: { cost_usd: number; input: number; output: number } };
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
  }[];
  tool_calls: ToolCallView[];
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

export interface SessionView {
  session_id: string;
  backend: string;
  workspace?: string;
  title?: string;
  status: string;
  busy?: boolean;
  turns: Turn[];
  pending_permissions: PendingPermission[];
  pending_questions?: PendingQuestion[];
  plan?: { content: string; status: "pending" | "in_progress" | "completed" }[];
  files_changed: { path: string; change: "add" | "modify" | "delete"; count: number }[];
  totals: SessionRow["totals"] & {
    reasoning: number;
    tool_errors: number;
    permissions_denied: number;
  };
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
  };
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
  if (!res.ok) throw new Error(`service ${res.status}`);
  return (await res.json()) as T;
}

export async function importSession(id: string): Promise<void> {
  const res = await fetch(api(`/sessions/${encodeURIComponent(id)}/import`), { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `service ${res.status}`);
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
    throw new Error(body.error ?? `service ${res.status}`);
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
  if (!res.ok) throw new Error(`service ${res.status}`);
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
  if (!res.ok) throw new Error(`service ${res.status}`);
}

async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? `service ${res.status}`);
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
  if (!res.ok) throw new Error(data.error ?? `service ${res.status}`);
  return { connected: data.connected === true, imported: data.imported ?? 0 };
}

export async function connectBackend(body: {
  baseUrl: string;
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
  if (!res.ok) throw new Error(data.error ?? `service ${res.status}`);
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
  if (!res.ok) throw new Error(data.error ?? `service ${res.status}`);
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

export const STATUS_LABEL: Record<string, string> = {
  active: "running",
  completed: "done",
  error: "error",
  cancelled: "stopped",
};
