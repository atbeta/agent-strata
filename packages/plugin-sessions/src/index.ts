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
  settings: {
    type: "object",
    properties: {
      scope: {
        type: "enum",
        enum: ["workspace", "global"],
        default: "workspace",
        title: "Read scope",
        description: "Which workspaces sessions_* may read",
      },
    },
  },
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
        "",
        "A hit that belongs to a known turn says so: `turn 41 (from_turn=40)`",
        "is where to look, and `from_turn=40` is the value to pass to",
        "sessions_read to land on it — no arithmetic needed.",
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
        "",
        "The header names the range, both numberings, and where each",
        "direction goes next: `showing 41-42 (1-based) | from_turn=40 |",
        "next_from_turn: 42 | earlier_from_turn: 25`. Pass `from_turn=40`",
        "back to reach the same page — the range reads 1-based and the",
        "parameter is 0-based, and the header says so.",
        "",
        "With `query`, it returns only the turns that mention it, and the",
        "cursors point at the next and previous turn that matched —",
        "paging by turn would land on an empty page.",
        "Sessions outside the caller's workspace answer \"no such session\".",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "A session id from sessions_list or sessions_search; native backend ids also resolve." },
          from_turn: { type: "integer", description: "First turn to include, 0-based (turns count from the session's start)." },
          max_turns: { type: "integer", description: "Turns to return, up to 50 (default 15)." },
          max_chars: { type: "integer", description: "Total size cap, 500-20000 (default 6000)." },
          raw: { type: "boolean", description: "Give the original text instead of a digest of it: per-field cuts are lifted, so a whole file or a whole tool output arrives whole. The page's own size cap still applies." },
          query: { type: "string", description: "Read only the turns that mention this, instead of the whole session. The text is searched as written, not as digested, so a match is never lost to a cut. `next_from_turn` then points at the next turn that matched." },
          context: { type: "integer", description: "Turns to show either side of a matched turn (default 0, max 5)." },
          match: { type: "enum", enum: ["all", "any"], description: "Whether every word must appear (all, default) or one of them (any)." },
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
  /** The reader's choices: the manifest's defaults over the host's state. */
  let settings: Record<string, unknown> = {};

  /**
   * Where the reads may look.
   *
   * "workspace" - the caller's own workspace and nowhere else. A session
   * with no workspace has none to confine them to, so the reads refuse.
   * "global" - every workspace on this machine. The reader asked for
   * that, so the other workspaces answer as they would to their own reader.
   */
  const readScope = (
    req: ToolCallRequest,
  ): { workspace?: string; error?: ToolCallResult } => {
    if (settings.scope === "global") return {};
    const ws = host.workspaceOf(req.sessionId);
    if (!ws) {
      return { error: err("this session has no workspace; sessions_* reads are scoped to one") };
    }
    return { workspace: ws };
  };

  const pageOf = <T>(rows: T[], offset: number, limit: number): { shown: T[]; next: number | null } => ({
    shown: rows.slice(offset, offset + limit),
    next: rows.length > offset + limit ? offset + limit : null,
  });

  const list = (req: ToolCallRequest): ToolCallResult => {
    const scope = readScope(req);
    if (scope.error) return scope.error;
    const ws = scope.workspace;
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
      `sessions in ${ws ?? "every workspace"}${req.input.roots_only === true ? " (roots only)" : ""}:`,
      ...(lines.length > 0 ? lines : ["(none)"]),
      ...(next === null ? [] : [`next_cursor: ${next}`]),
    ];
    return { output: body.join("\n") };
  };

  const search = (req: ToolCallRequest): ToolCallResult => {
    const scope = readScope(req);
    if (scope.error) return scope.error;
    const ws = scope.workspace;
    const query = typeof req.input.query === "string" ? req.input.query.trim() : "";
    if (!query) return err("query is required");
    const limit = Math.min(Math.max(intOpt(req.input.limit) ?? 10, 1), 50);
    const offset = Math.max(intOpt(req.input.cursor) ?? 0, 0);
    const hits = host.search(query, { workspace: ws, limit: offset + limit + 1 });
    const { shown, next } = pageOf(hits, offset, limit);
    const titles = new Map(host.list({ workspace: ws, limit: 2000 }).map((row) => [row.session_id, row.title]));
    const turns = turnOf(hits);
    // Hits from one turn are one place to look, so they are one line.
    // A query about a symbol often matches a dozen tool results inside
    // the same turn, and a dozen lines that all say the same turn is a
    // dozen lines of noise.
    const groups: { hit: SearchHit; members: SearchHit[] }[] = [];
    const byKey = new Map<string, { hit: SearchHit; members: SearchHit[] }>();
    for (const hit of shown) {
      const turn = turns.get(hit);
      // Without a turn there is nothing to fold into: these stay apart.
      const key = turn === undefined ? undefined : `${hit.event.session_id}#${turn}`;
      const group = key === undefined ? undefined : byKey.get(key);
      if (group) {
        group.members.push(hit);
        continue;
      }
      const fresh = { hit, members: [hit] };
      groups.push(fresh);
      if (key !== undefined) byKey.set(key, fresh);
    }
    const lines = groups.map(({ hit, members }) => {
      const turn = turns.get(hit);
      const anchor = turn === undefined ? "" : ` | turn ${turn + 1} (from_turn=${turn})`;
      const many = members.length > 1 ? ` ×${members.length}` : "";
      const head = `${hit.event.session_id} | ${titles.get(hit.event.session_id) ?? "(untitled)"} | ${hit.event.ts}${anchor}${many}`;
      return [head, ...members.map((m) => `   ${m.snippet}`)].join("\n");
    });
    return {
      output: [
        `hits for "${query}" in ${ws ?? "every workspace"}:`,
        ...(lines.length > 0 ? lines : ["(none)"]),
        ...(next === null ? [] : [`next_cursor: ${next}`]),
      ].join("\n"),
    };
  };

  /**
   * Where each hit sits, as a turn the reader can walk to.
   *
   * A tool result carries no turn of its own — the projector binds it to
   * one through the call that produced it — so a match on tool output is
   * traced back through that call, the way the desktop traces it.
   * Without this a reader has a snippet and no way to reach the turn it
   * came from, which is the whole cost of reading a session by paging.
   *
   * The transcript numbers its turns from one; the parameter that asks
   * for a turn numbers them from zero. So the anchor carries both, and
   * the reader pastes the second one without arithmetic.
   */
  const turnOf = (hits: readonly SearchHit[]): Map<SearchHit, number> => {
    const anchors = new Map<SearchHit, number>();
    const bySession = new Map<string, { turns: Map<string, number>; calls: Map<string, number> }>();
    for (const hit of hits) {
      const sessionId = hit.event.session_id;
      let maps = bySession.get(sessionId);
      if (!maps) {
        const turns = new Map<string, number>();
        const calls = new Map<string, number>();
        try {
          host.view(sessionId).turns.forEach((turn, i) => {
            turns.set(turn.turn_id, i);
            for (const call of turn.tool_calls) calls.set(call.call_id, i);
          });
        } catch {
          // A session that is gone answers like one that never matched:
          // the hit is still worth showing, it just cannot be walked to.
        }
        maps = { turns, calls };
        bySession.set(sessionId, maps);
      }
      // The ids are only on the events that have them, and a hit's
      // event may carry no data at all — so this reads them defensively.
      const data = hit.event.data as { turn_id?: unknown; call_id?: unknown } | undefined;
      const turnId = typeof data?.turn_id === "string" ? data.turn_id : undefined;
      const callId = typeof data?.call_id === "string" ? data.call_id : undefined;
      let at: number | undefined;
      if (turnId !== undefined) at = maps.turns.get(turnId);
      if (at === undefined && callId !== undefined) at = maps.calls.get(callId);
      if (at === undefined) continue;
      anchors.set(hit, at);
    }
    return anchors;
  };

  const read = (req: ToolCallRequest): ToolCallResult => {
    const scope = readScope(req);
    if (scope.error) return scope.error;
    const ws = scope.workspace;
    const raw = typeof req.input.session_id === "string" ? req.input.session_id.trim() : "";
    if (!raw) return err("session_id is required");
    let view: SessionView;
    try {
      view = host.view(ctx.resolveSession(raw));
    } catch {
      return err(`no such session: ${raw}`);
    }
    // Other workspaces answer exactly like a session that does not exist -
    // unless the reader opened every workspace up, which is the whole of
    // what the global scope means.
    if (ws !== undefined && view.workspace !== ws) return err(`no such session: ${raw}`);
    const from = intOpt(req.input.from_turn);
    const page = digest(view, {
      from,
      maxTurns: Math.min(Math.max(intOpt(req.input.max_turns) ?? 15, 1), 50),
      maxChars: intOpt(req.input.max_chars),
      raw: req.input.raw === true,
      query: typeof req.input.query === "string" ? req.input.query : undefined,
      context: intOpt(req.input.context),
      match: req.input.match === "any" ? "any" : undefined,
    });
    // The cursors are in the digest's own header, beside the range they
    // belong to. A cursor at the foot of a long transcript is a cursor
    // nobody reads.
    return { output: page.text };
  };

  return {
    async initialize(pluginCtx) {
      ctx = pluginCtx;
      settings = pluginCtx.config;
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
