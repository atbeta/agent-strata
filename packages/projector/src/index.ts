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
  /** Declaration order among the calls of this assistant message, starting at 0. */
  order?: number;
  /** The assistant message this call belongs to, when the backend names one. */
  msg_id?: string;
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
    /** set when the backend finished the message by failing, and there may be no text */
    error?: string;
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

/** One change as the backend recorded it. */
interface ChangeRecord {
  change: FileChangeKind;
  diff?: string;
  call_id?: string;
  whole_file?: boolean;
}

type FileChangeKind = "add" | "modify" | "delete";

/** One recorded change to one file, with the text that changed if the backend sent it. */
export interface FileEditView {
  change: FileChangeKind;
  /** lines added and removed, counted out of the unified diff */
  additions: number;
  deletions: number;
  /** absent when the backend saw the file change but no call explains it — usually a shell command */
  diff?: string;
  /** the tool call that made the change */
  call_id?: string;
  /** index into SessionView.turns, or -1 when no call in this session made the change */
  turn_index: number;
  /** the diff covers the whole file rather than a region of it */
  whole_file?: boolean;
}

export interface FileChangeView {
  path: string;
  change: FileChangeKind;
  /** how many changes to this file the session recorded */
  count: number;
  /** summed across every change, so a lower bound when unexplained */
  additions: number;
  deletions: number;
  edits: FileEditView[];
  /** at least one recorded change has no diff to show */
  unexplained: boolean;
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
  files_changed: FileChangeView[];
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

/**
 * Count the added and removed lines in a unified diff. Counting here rather
 * than in each adapter means every backend that produces a diff gets the
 * numbers for free, including one we did not write.
 *
 * The `+++`/`---` file headers are the reason this cannot just count lines
 * that start with a sign: they appear before the first hunk, and so does any
 * header a diff might grow later. Everything up to the first `@@` is metadata.
 */
export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
    // "\\ No newline at end of file" and context lines count as neither
  }
  return { additions, deletions };
}

/** One shape for a path: separators unified, and a Windows drive path compared without case. */
function pathKey(path: string): string {
  const p = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p;
}

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
  const files = new Map<string, { path: string; change: FileChangeKind; records: ChangeRecord[] }>();
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
          // A re-import can append a partial snapshot after the finished
          // message. Applying it would mark a completed thought as still live.
          if (e.data.partial && old.partial !== true) break;
          addUsage(-1, old.usage, old.cost_usd);
          t.assistant[idx] = {
            content: e.data.content,
            msg_id: e.data.msg_id,
            partial: e.data.partial,
            model: e.data.model ?? old.model,
            usage: e.data.usage,
            cost_usd: e.data.cost_usd,
            latency_ms: e.data.latency_ms,
            error: e.data.error,
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
            error: e.data.error,
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
          order: e.data.order,
          msg_id: e.data.msg_id,
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
        const key = pathKey(e.data.path);
        const f = files.get(key) ?? { path: e.data.path, change: e.data.change, records: [] };
        f.change = e.data.change;
        f.records.push({
          change: e.data.change,
          diff: e.data.diff,
          call_id: e.data.call_id,
          whole_file: e.data.whole_file,
        });
        files.set(key, f);
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

  // Events arrive in the order the calls actually started, which for parallel
  // calls is not the order the assistant declared them. When the backend
  // stamped a declaration ordinal, restore that order so a reader sees the
  // sequence the model wrote about. Stable, so calls without an ordinal keep
  // their event order and stay after the ones that have one.
  //
  // The ordinal alone is not enough, and sorting on it alone was wrong in a way
  // that looked fine: it counts within one assistant message, and a turn can
  // hold several. Three messages declaring two, one and two calls produced
  // 0,0,1,1,2 across the turn, and sorting on that number interleaved the
  // messages with each other. So the message is the outer key and the ordinal
  // the inner one, which is also the grouping the transcript needs to put a
  // call beside the words that asked for it.
  for (const t of view.turns) {
    if (!t.tool_calls.some((c) => c.order !== undefined)) continue;
    const messageAt = new Map<string, number>();
    t.assistant.forEach((a, i) => {
      if (a.msg_id !== undefined) messageAt.set(a.msg_id, i);
    });
    const unknownMessage = t.assistant.length;
    const key = (c: ToolCallView) => (c.msg_id === undefined ? unknownMessage : (messageAt.get(c.msg_id) ?? unknownMessage));
    t.tool_calls = t.tool_calls
      .map((c, i) => ({ c, i }))
      .sort((a, b) => key(a.c) - key(b.c) || (a.c.order ?? Number.MAX_SAFE_INTEGER) - (b.c.order ?? Number.MAX_SAFE_INTEGER) || a.i - b.i)
      .map(({ c }) => c);
  }

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

  const turnOfCall = new Map<string, number>();
  view.turns.forEach((t, i) => {
    for (const c of t.tool_calls) turnOfCall.set(c.call_id, i);
  });
  view.files_changed = [...files.values()].map((f) => {
    const edits = f.records.map((r): FileEditView => {
      const lines = r.diff ? countPatchLines(r.diff) : { additions: 0, deletions: 0 };
      return {
        change: r.change,
        additions: lines.additions,
        deletions: lines.deletions,
        diff: r.diff,
        call_id: r.call_id,
        turn_index: r.call_id === undefined ? -1 : (turnOfCall.get(r.call_id) ?? -1),
        whole_file: r.whole_file,
      };
    });
    return {
      path: f.path,
      change: f.change,
      count: edits.length,
      additions: edits.reduce((n, e) => n + e.additions, 0),
      deletions: edits.reduce((n, e) => n + e.deletions, 0),
      edits,
      unexplained: edits.some((e) => !e.diff),
    };
  });
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
