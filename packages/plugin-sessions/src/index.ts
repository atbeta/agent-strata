// sessions_* as a builtin plugin: cross-session memory for every backend.
//
// One backend's own history is useless to another's, but the layer sees them
// all — so an agent on OpenCode can recall what an ACP session did in the
// same workspace. That is the whole feature: three read-only tools over the
// store the service already keeps.
//
// Scope is the workspace, not "everything": a session in /repo-a cannot read
// /repo-b's transcripts. Sessions in other workspaces are invisible — the
// tool answers "no such session" rather than "exists but denied", because a
// session that cannot see it should not learn it is there.
//
// Everything returned comes from the store — committed events. A turn the
// backend is still streaming is in flight, not memory, and is not read here.

import type {
  PluginContext,
  PluginManifest,
  PluginTool,
  StrataPlugin,
  ToolCallRequest,
  ToolCallResult,
} from "@agent-strata/plugin-sdk";
import type { SessionView } from "@agent-strata/projector";
import type { SearchHit, SessionSummary } from "@agent-strata/store";
import { digest } from "./digest";

/**
 * What the plugin is allowed to see of the host — the service's read-only
 * `sessions` injection plus the workspace lookup every builtin already gets.
 * Kept narrow on purpose: a plugin that can read sessions cannot create one.
 */
export interface SessionsHost {
  list(opts: { workspace?: string; limit?: number; rootsOnly?: boolean }): SessionSummary[];
  search(query: string, opts: { workspace?: string; sessionId?: string; limit?: number }): SearchHit[];
  view(sessionId: string): SessionView;
  /** The calling session's workspace; sessions_* only ever sees inside it. */
  workspaceOf(sessionId: string): string | undefined;
}

export const manifest: PluginManifest = {
  id: "sessions",
  name: "Session memory",
  version: "1.0.0",
  description: "Read other sessions in this workspace — list, search, and read transcripts the store holds.",
  entry: { kind: "builtin" },
  provides: ["tools"],
  permissions: {},
  resources: [],
  tools: [
    {
      name: "list",
      description: [
        "List sessions in this session's workspace, newest first — what the agent",
        "worked on here before, regardless of backend.",
        "",
        "Pages by `cursor` (an offset): when the result ends with `next_cursor: N`,",
        "pass N to continue. `roots_only` drops subagent child sessions.",
        "",
        "Only sessions in the caller's workspace are visible; the store is a",
        "rebuildable cache, so a session removed upstream may still appear until",
        "the next sync.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "Rows to return, 1-100 (default 20)." },
          cursor: { type: "integer", description: "Page offset from a previous `next_cursor`." },
          roots_only: { type: "boolean", description: "Only sessions without a parent." },
        },
      },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "search",
      description: [
        "Full-text search over the stored events of sessions in this workspace.",
        "Returns matching snippets with the session and time each came from.",
        "Use this to recall where something was decided or built, then",
        "sessions_read to get the context around it.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to search for; matched across titles, prompts, replies and tool output." },
          limit: { type: "integer", description: "Hits to return, 1-50 (default 10)." },
          cursor: { type: "integer", description: "Page offset from a previous `next_cursor`." },
        },
        required: ["query"],
      },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "read",
      description: [
        "Read a session's transcript as a compact digest — user asks, assistant",
        "replies, and each tool call's name, input and short output. Thinking",
        "blocks are omitted; long text is truncated.",
        "",
        "Pages by turn index: without `from_turn` it returns the most recent",
        "turns; `earlier_from_turn` continues toward older context and",
        "`next_from_turn` toward newer. Only committed",
        "events are visible — a turn still streaming is not readable yet.",
        "Sessions outside the caller's workspace answer \"no such session\".",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "A session id from sessions_list or sessions_search; native backend ids also resolve." },
          from_turn: { type: "integer", description: "First turn to include, 0-based (turns count from the session's start)." },
          max_turns: { type: "integer", description: "Turns to return, up to 50 (default 15)." },
          max_chars: { type: "integer", description: "Total size cap, 500-20000 (default 6000)." },
        },
        required: ["session_id"],
      },
      policy: { default: "allow", risk: "read" },
    },
  ],
};

const intOpt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;

function err(message: string): ToolCallResult {
  return { output: `error: ${message}`, isError: true };
}

export function createSessionsPlugin(host: SessionsHost): StrataPlugin {
  let ctx: PluginContext;

  const callerWorkspace = (req: ToolCallRequest): string | ToolCallResult => {
    const ws = host.workspaceOf(req.sessionId);
    return ws ?? err("this session has no workspace; sessions_* reads are scoped to one");
  };

  const pageOf = <T>(rows: T[], offset: number, limit: number): { shown: T[]; next: number | null } => ({
    shown: rows.slice(offset, offset + limit),
    next: rows.length > offset + limit ? offset + limit : null,
  });

  const list = (req: ToolCallRequest): ToolCallResult => {
    const ws = callerWorkspace(req);
    if (typeof ws !== "string") return ws;
    const limit = Math.min(Math.max(intOpt(req.input.limit) ?? 20, 1), 100);
    const offset = Math.max(intOpt(req.input.cursor) ?? 0, 0);
    const rows = host.list({ workspace: ws, limit: offset + limit + 1, rootsOnly: req.input.roots_only === true });
    const { shown, next } = pageOf(rows, offset, limit);
    const lines = shown.map((row) => {
      const child = row.parent_session_id ? "↳ " : "";
      const title = row.title ?? "(untitled)";
      return `${child}${row.session_id} | ${row.backend} | ${row.last_ts} | ${title}`;
    });
    const body = [
      `sessions in ${ws}${req.input.roots_only === true ? " (roots only)" : ""}:`,
      ...(lines.length > 0 ? lines : ["(none)"]),
      ...(next === null ? [] : [`next_cursor: ${next}`]),
    ];
    return { output: body.join("\n") };
  };

  const search = (req: ToolCallRequest): ToolCallResult => {
    const ws = callerWorkspace(req);
    if (typeof ws !== "string") return ws;
    const query = typeof req.input.query === "string" ? req.input.query.trim() : "";
    if (!query) return err("query is required");
    const limit = Math.min(Math.max(intOpt(req.input.limit) ?? 10, 1), 50);
    const offset = Math.max(intOpt(req.input.cursor) ?? 0, 0);
    const hits = host.search(query, { workspace: ws, limit: offset + limit + 1 });
    const { shown, next } = pageOf(hits, offset, limit);
    const titles = new Map(host.list({ workspace: ws, limit: 2000 }).map((row) => [row.session_id, row.title]));
    const lines = shown.map(
      (hit) => `${hit.event.session_id} | ${titles.get(hit.event.session_id) ?? "(untitled)"} | ${hit.event.ts}\n   ${hit.snippet}`,
    );
    return {
      output: [
        `hits for "${query}" in ${ws}:`,
        ...(lines.length > 0 ? lines : ["(none)"]),
        ...(next === null ? [] : [`next_cursor: ${next}`]),
      ].join("\n"),
    };
  };

  const read = (req: ToolCallRequest): ToolCallResult => {
    const ws = callerWorkspace(req);
    if (typeof ws !== "string") return ws;
    const raw = typeof req.input.session_id === "string" ? req.input.session_id.trim() : "";
    if (!raw) return err("session_id is required");
    let view: SessionView;
    try {
      view = host.view(ctx.resolveSession(raw));
    } catch {
      return err(`no such session: ${raw}`);
    }
    // Other workspaces answer exactly like a session that does not exist.
    if (view.workspace !== ws) return err(`no such session: ${raw}`);
    const from = intOpt(req.input.from_turn);
    const page = digest(view, {
      from,
      maxTurns: Math.min(Math.max(intOpt(req.input.max_turns) ?? 15, 1), 50),
      maxChars: intOpt(req.input.max_chars),
    });
    const cursors = [
      page.nextFrom === null ? [] : [`next_from_turn: ${page.nextFrom}`],
      page.earlierFrom === null ? [] : [`earlier_from_turn: ${page.earlierFrom}`],
    ].flat();
    return { output: cursors.length > 0 ? `${page.text}\n\n${cursors.join("\n")}` : page.text };
  };

  return {
    async initialize(pluginCtx) {
      ctx = pluginCtx;
    },
    listTools(): PluginTool[] {
      return manifest.tools.map((tool) => ({ name: tool.name, description: tool.description, input: tool.input }));
    },
    async callTool(req) {
      switch (req.tool) {
        case "list":
          return list(req);
        case "search":
          return search(req);
        case "read":
          return read(req);
        default:
          return err(`unknown tool: ${req.tool}`);
      }
    },
    async shutdown() {},
  };
}
