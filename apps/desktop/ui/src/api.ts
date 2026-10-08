export interface SessionRow {
  summary: {
    session_id: string;
    backend: string;
    workspace: string | null;
    title: string | null;
    started_at: string;
    last_seq: number;
  };
  status: string;
  title?: string;
  totals: { input: number; output: number; cost_usd: number; tool_calls: number };
}

export interface SessionsResponse {
  sessions: SessionRow[];
  aggregate: { total: { cost_usd: number; input: number; output: number } };
}

export interface ContentBlock {
  type: string;
  text?: string;
}

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
    model?: string;
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

export interface SessionView {
  session_id: string;
  backend: string;
  workspace?: string;
  title?: string;
  status: string;
  turns: Turn[];
  pending_permissions: PendingPermission[];
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

export interface OptionsResponse {
  models: { providerID: string; modelID: string; name: string }[];
  agents: { name: string; mode?: string }[];
}

export const api = (p: string) => `/api${p}`;

export async function getJson<T>(p: string): Promise<T> {
  const res = await fetch(api(p));
  if (!res.ok) throw new Error(`service ${res.status}`);
  return (await res.json()) as T;
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

export function fmtUsd(n: number) {
  return `$${n.toFixed(4)}`;
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
