import type { ContentBlock, Event, Usage } from "@agent-strata/schema";

export interface PermissionInfo {
  request_id: string;
  decision?: "allow" | "deny";
  by?: "user" | "policy" | "auto";
  rule_id?: string;
  reason?: string;
}

export interface ToolCallView {
  call_id: string;
  tool: string;
  input: Record<string, unknown>;
  status: "pending" | "ok" | "error" | "interrupted";
  output?: string;
  latency_ms?: number;
  permission?: PermissionInfo;
}

export interface Turn {
  turn_id: string;
  user?: ContentBlock[];
  assistant: {
    content: ContentBlock[];
    msg_id?: string;
    partial?: boolean;
    model?: string;
    usage?: Usage;
    cost_usd?: number;
    latency_ms?: number;
  }[];
  tool_calls: ToolCallView[];
}

export interface Totals {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  tool_calls: number;
  tool_errors: number;
  permissions_denied: number;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionPrompt {
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
  parent_session_id?: string;
  /** hidden from the sidebar, same cut as the official desktop */
  archived?: boolean;
  deleted?: boolean;
  status: "active" | "completed" | "cancelled" | "error";
  /** backend is mid-generation; last session.status wins */
  busy: boolean;
  turns: Turn[];
  orphans: ToolCallView[];
  pending_permissions: PermissionInfo[];
  pending_questions: QuestionPrompt[];
  plan?: { content: string; status: "pending" | "in_progress" | "completed" }[];
  files_changed: { path: string; change: "add" | "modify" | "delete"; count: number }[];
  totals: Totals;
}

const zeroTotals = (): Totals => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 0,
  tool_calls: 0,
  tool_errors: 0,
  permissions_denied: 0,
});

export function projectSession(events: Event[]): SessionView {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  if (sorted.length === 0) throw new Error("no events");
  const sessionId = sorted[0]!.session_id;
  for (const e of sorted) {
    if (e.session_id !== sessionId) throw new Error("mixed session_ids");
  }

  const view: SessionView = {
    session_id: sessionId,
    backend: sorted[0]!.source.backend,
    status: "active",
    busy: false,
    turns: [],
    orphans: [],
    pending_permissions: [],
    pending_questions: [],
    files_changed: [],
    totals: zeroTotals(),
  };

  const turns = new Map<string, Turn>();
  const calls = new Map<string, ToolCallView>();
  const requests = new Map<string, PermissionInfo>();
  // permission.requested can arrive before its tool.call (opencode emits
  // permission.asked first) — index by call_id so a late call still attaches
  const requestsByCall = new Map<string, PermissionInfo>();
  const files = new Map<string, { change: "add" | "modify" | "delete"; count: number }>();
  const questions = new Map<string, QuestionPrompt>();
  const orphanResults: { call_id: string; status: string; output?: string; latency_ms?: number }[] = [];

  const getTurn = (id: string): Turn => {
    let t = turns.get(id);
    if (!t) {
      t = { turn_id: id, assistant: [], tool_calls: [] };
      turns.set(id, t);
      view.turns.push(t);
    }
    return t;
  };

  for (const e of sorted) {
    switch (e.type) {
      case "session.started":
        view.workspace = e.data.workspace;
        view.title = e.data.title;
        if (e.data.parent_session_id) view.parent_session_id = e.data.parent_session_id;
        break;
      case "session.ended":
        view.status = e.data.reason;
        view.busy = false;
        break;
      case "session.status":
        view.busy = e.data.state === "busy";
        break;
      case "session.updated":
        if (e.data.title !== undefined) view.title = e.data.title;
        if (e.data.workspace !== undefined) view.workspace = e.data.workspace;
        if (e.data.archived !== undefined) view.archived = e.data.archived;
        if (e.data.parent_session_id) view.parent_session_id = e.data.parent_session_id;
        break;
      case "session.deleted":
        view.deleted = true;
        view.busy = false;
        break;
      case "turn.user": {
        const t = getTurn(e.data.turn_id);
        t.user = e.data.content;
        break;
      }
      case "turn.assistant": {
        const t = getTurn(e.data.turn_id);
        const addUsage = (sign: 1 | -1, u?: Usage, cost?: number) => {
          if (u) {
            view.totals.input += sign * u.input;
            view.totals.output += sign * u.output;
            view.totals.reasoning += sign * (u.reasoning ?? 0);
            view.totals.cache_read += sign * (u.cache_read ?? 0);
            view.totals.cache_write += sign * (u.cache_write ?? 0);
          }
          view.totals.cost_usd += sign * (cost ?? 0);
        };
        // a snapshot with a msg_id already seen replaces that entry — this is
        // how streaming partials resolve into the final completed message
        const idx = e.data.msg_id
          ? t.assistant.findIndex((a) => a.msg_id === e.data.msg_id)
          : -1;
        if (idx >= 0) {
          const old = t.assistant[idx]!;
          addUsage(-1, old.usage, old.cost_usd);
          t.assistant[idx] = {
            content: e.data.content,
            msg_id: e.data.msg_id,
            partial: e.data.partial,
            model: e.data.model ?? old.model,
            usage: e.data.usage,
            cost_usd: e.data.cost_usd,
            latency_ms: e.data.latency_ms,
          };
        } else {
          t.assistant.push({
            content: e.data.content,
            msg_id: e.data.msg_id,
            partial: e.data.partial,
            model: e.data.model,
            usage: e.data.usage,
            cost_usd: e.data.cost_usd,
            latency_ms: e.data.latency_ms,
          });
        }
        addUsage(1, e.data.usage, e.data.cost_usd);
        break;
      }
      case "tool.call": {
        const t = getTurn(e.data.turn_id);
        const call: ToolCallView = {
          call_id: e.data.call_id,
          tool: e.data.tool,
          input: e.data.input,
          status: "pending",
        };
        t.tool_calls.push(call);
        calls.set(e.data.call_id, call);
        const pendingReq = requestsByCall.get(e.data.call_id);
        if (pendingReq) {
          call.permission = pendingReq;
          requestsByCall.delete(e.data.call_id);
        }
        view.totals.tool_calls++;
        break;
      }
      case "tool.result": {
        const call = calls.get(e.data.call_id);
        if (!call) {
          orphanResults.push(e.data);
          break;
        }
        call.status = e.data.status;
        call.output = e.data.output;
        call.latency_ms = e.data.latency_ms;
        if (e.data.status === "error" || e.data.status === "interrupted")
          view.totals.tool_errors++;
        break;
      }
      case "permission.requested": {
        const p: PermissionInfo = { request_id: e.data.request_id };
        requests.set(p.request_id, p);
        if (e.data.call_id) {
          const call = calls.get(e.data.call_id);
          if (call) call.permission = p;
          else requestsByCall.set(e.data.call_id, p);
        } else view.pending_permissions.push(p);
        break;
      }
      case "permission.resolved": {
        const p = requests.get(e.data.request_id);
        if (p) {
          p.decision = e.data.decision;
          p.by = e.data.by;
          p.rule_id = e.data.rule_id;
          p.reason = e.data.reason;
          if (e.data.decision === "deny") view.totals.permissions_denied++;
        }
        break;
      }
      case "file.changed": {
        const f = files.get(e.data.path) ?? { change: e.data.change, count: 0 };
        f.change = e.data.change;
        f.count++;
        files.set(e.data.path, f);
        break;
      }
      case "plan.updated":
        view.plan = e.data.entries;
        break;
      case "question.asked":
        questions.set(e.data.request_id, {
          request_id: e.data.request_id,
          questions: e.data.questions,
        });
        break;
      case "question.resolved":
        questions.delete(e.data.request_id);
        break;
    }
  }

  view.pending_questions = [...questions.values()];
  if (!view.title) {
    for (const t of view.turns) {
      const block = t.user?.find((b) => b.type === "text" && b.text.trim());
      if (block?.type === "text") {
        view.title = block.text.trim().slice(0, 80);
        break;
      }
    }
  }

  if (view.status !== "active") {
    for (const c of calls.values()) {
      if (c.status === "pending") c.status = "interrupted";
    }
  }

  for (const o of orphanResults) {
    view.orphans.push({
      call_id: o.call_id,
      tool: "<unknown>",
      input: {},
      status: o.status as ToolCallView["status"],
      output: o.output,
      latency_ms: o.latency_ms,
    });
  }

  view.files_changed = [...files.entries()].map(([path, f]) => ({
    path,
    change: f.change,
    count: f.count,
  }));
  return view;
}

export function aggregate(views: SessionView[]): {
  by_backend: Record<string, Totals>;
  by_model: Record<string, { input: number; output: number; cost_usd: number; turns: number }>;
  total: Totals;
} {
  const by_backend: Record<string, Totals> = {};
  const by_model: Record<string, { input: number; output: number; cost_usd: number; turns: number }> = {};
  const total = zeroTotals();

  const addTotals = (dst: Totals, src: Totals) => {
    for (const k of Object.keys(dst) as (keyof Totals)[]) dst[k] += src[k];
  };

  for (const v of views) {
    by_backend[v.backend] ??= zeroTotals();
    addTotals(by_backend[v.backend]!, v.totals);
    addTotals(total, v.totals);
    for (const turn of v.turns) {
      for (const a of turn.assistant) {
        const m = a.model ?? "unknown";
        by_model[m] ??= { input: 0, output: 0, cost_usd: 0, turns: 0 };
        by_model[m]!.input += a.usage?.input ?? 0;
        by_model[m]!.output += a.usage?.output ?? 0;
        by_model[m]!.cost_usd += a.cost_usd ?? 0;
        by_model[m]!.turns++;
      }
    }
  }
  return { by_backend, by_model, total };
}
