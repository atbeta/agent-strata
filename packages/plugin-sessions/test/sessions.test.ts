import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@agent-strata/schema";
import type { PluginContext, StrataPlugin, ToolCallRequest } from "@agent-strata/plugin-sdk";
import type { SessionView, ToolCallView, Turn } from "@agent-strata/projector";
import type { SearchHit, SessionSummary } from "@agent-strata/store";
import { digest } from "../src/digest";
import { createSessionsPlugin, manifest, type SessionsHost } from "../src/index";

const CALLER = "opencode:caller";
const WS = "/repo";

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: id,
    backend: "opencode",
    workspace: WS,
    title: `session ${id}`,
    started_at: "2026-11-18T00:00:00Z",
    last_seq: 1,
    last_ts: "2026-11-18T10:00:00Z",
    mapper: null,
    parent_session_id: null,
    ...over,
  } as SessionSummary;
}

function turn(id: string, user: string, assistant: string, tools: ToolCallView[] = []): Turn {
  return {
    turn_id: id,
    user: user ? [{ type: "text", text: user } as ContentBlock] : undefined,
    assistant: assistant
      ? [{ content: [{ type: "text", text: assistant } as ContentBlock] }]
      : [],
    tool_calls: tools,
  };
}

function toolCall(over: Partial<ToolCallView> = {}): ToolCallView {
  return { call_id: "c1", tool: "dev_start", input: { command: "bun dev" }, status: "ok", ...over };
}

function view(over: Partial<SessionView> = {}): SessionView {
  return {
    session_id: "opencode:ses1",
    backend: "opencode",
    workspace: WS,
    title: "the one",
    status: "completed",
    busy: false,
    turns: [],
    orphans: [],
    pending_permissions: [],
    pending_questions: [],
    file_changes: [],
    ...over,
  } as SessionView;
}

function host(over: Partial<SessionsHost> = {}): SessionsHost {
  return {
    list: () => [],
    search: () => [],
    view: () => {
      throw new Error("no such session");
    },
    workspaceOf: (id) => (id === CALLER ? WS : undefined),
    ...over,
  };
}

const ctx: PluginContext = {
  pluginId: "sessions",
  resolveSession: (id: string) => (id.includes(":") ? id : `opencode:${id}`),
  dataDir: "/tmp",
  config: {},
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  emit: async () => {},
} as unknown as PluginContext;

async function plugin(h: SessionsHost, config: Record<string, unknown> = {}): Promise<StrataPlugin> {
  const p = createSessionsPlugin(h);
  await p.initialize({ ...ctx, config } as unknown as PluginContext);
  return p;
}

function req(tool: string, input: Record<string, unknown> = {}, sessionId = CALLER): ToolCallRequest {
  return { tool, sessionId, input, signal: new AbortController().signal };
}

describe("sessions_list", () => {
  test("lists only the caller's workspace, newest rows as given, with paging", async () => {
    const seen: Parameters<SessionsHost["list"]>[0][] = [];
    const rows = Array.from({ length: 30 }, (_, i) => summary(`opencode:s${i}`));
    const p = await plugin(
      host({
        list: (opts) => {
          seen.push(opts);
          return rows.slice(0, opts.limit);
        },
      }),
    );
    const out = await p.callTool(req("list", { limit: 20 }));
    expect(seen[0]).toEqual({ workspace: WS, limit: 21, rootsOnly: false });
    expect(out.output).toContain(`sessions in ${WS}:`);
    expect(out.output).toContain("opencode:s0 | opencode | 2026-11-18T10:00:00Z | session opencode:s0");
    expect(out.output).toContain("next_cursor: 20");
    const page2 = await p.callTool(req("list", { limit: 20, cursor: 20 }));
    expect(page2.output).toContain("opencode:s20");
    expect(page2.output).not.toContain("next_cursor");
  });

  test("child sessions are marked and roots_only is forwarded", async () => {
    let rootsOnly: boolean | undefined;
    const p = await plugin(
      host({
        list: (opts) => {
          rootsOnly = opts.rootsOnly;
          return [summary("opencode:child", { parent_session_id: "opencode:parent" } as Partial<SessionSummary>)];
        },
      }),
    );
    const out = await p.callTool(req("list", { roots_only: true }));
    expect(rootsOnly).toBe(true);
    expect(out.output).toContain("↳ opencode:child");
  });

  test("a caller without a workspace gets the scoped error", async () => {
    const p = await plugin(host());
    const out = await p.callTool(req("list", {}, "opencode:elsewhere"));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("no workspace");
  });
});

describe("sessions_search", () => {
  const hit = (sessionId: string, ts: string, snippet: string): SearchHit =>
    ({ event: { session_id: sessionId, ts } as SearchHit["event"], snippet });
  /** A hit that carries the ids an event really has. */
  const anchored = (
    sessionId: string,
    ts: string,
    snippet: string,
    data: Record<string, unknown>,
  ): SearchHit =>
    ({ event: { session_id: sessionId, ts, data } as unknown as SearchHit["event"], snippet });

  test("searches the workspace and labels hits with session titles", async () => {
    const p = await plugin(
      host({
        list: () => [summary("opencode:s1", { title: "fix the thing" } as Partial<SessionSummary>)],
        search: (q, opts) => {
          expect(opts?.workspace).toBe(WS);
          return [hit("opencode:s1", "2026-11-18T09:00:00Z", "the [guard] fails")];
        },
      }),
    );
    const out = await p.callTool(req("search", { query: "guard fails" }));
    expect(out.output).toContain("opencode:s1 | fix the thing | 2026-11-18T09:00:00Z");
    expect(out.output).toContain("the [guard] fails");
  });

  test("rejects an empty query", async () => {
    const p = await plugin(host());
    const out = await p.callTool(req("search", { query: "   " }));
    expect(out.isError).toBe(true);
  });

  test("a hit says which turn it is in, in both numberings", async () => {
    // The transcript numbers its turns from one; `from_turn` from zero.
    // A hit carrying only one of them made the reader do the arithmetic,
    // and get it wrong a turn at a time.
    const turns = [turn("t1", "one", "first"), turn("t2", "two", "second")];
    const p = await plugin(
      host({
        list: () => [summary("opencode:s1", { title: "fix the thing" } as Partial<SessionSummary>)],
        search: () => [
          anchored("opencode:s1", "2026-11-18T09:00:00Z", "the [guard] fails", { turn_id: "t2" }),
        ],
        view: () => view({ session_id: "opencode:s1", turns }),
      }),
    );
    const out = await p.callTool(req("search", { query: "guard fails" }));
    expect(out.output).toContain("turn 2 (from_turn=1)");
  });

  test("a hit on tool output is traced back through the call that made it", async () => {
    // A tool result carries no turn of its own; the projector binds it
    // to one through the call that produced it.
    const calls = [toolCall({ call_id: "c9" })];
    const turns = [turn("t1", "one", "first", calls)];
    const p = await plugin(
      host({
        list: () => [summary("opencode:s1", { title: "fix the thing" } as Partial<SessionSummary>)],
        search: () => [
          anchored("opencode:s1", "2026-11-18T09:00:00Z", "the [guard] fails", { call_id: "c9" }),
        ],
        view: () => view({ session_id: "opencode:s1", turns }),
      }),
    );
    const out = await p.callTool(req("search", { query: "guard fails" }));
    expect(out.output).toContain("turn 1 (from_turn=0)");
  });

  test("hits from one turn are one line", async () => {
    // A query about a symbol often matches a dozen tool results inside
    // the same turn, and a dozen lines that all say the same turn is a
    // dozen lines of noise.
    const p = await plugin(
      host({
        list: () => [summary("opencode:s1", { title: "fix the thing" } as Partial<SessionSummary>)],
        search: () => [
          anchored("opencode:s1", "2026-11-18T09:00:00Z", "first [guard] fails", { turn_id: "t1" }),
          anchored("opencode:s1", "2026-11-18T09:00:01Z", "second [guard] fails", { turn_id: "t1" }),
          anchored("opencode:s1", "2026-11-18T09:00:02Z", "elsewhere", { turn_id: "t2" }),
        ],
        view: () =>
          view({ session_id: "opencode:s1", turns: [turn("t1", "a", "b"), turn("t2", "c", "d")] }),
      }),
    );
    const out = await p.callTool(req("search", { query: "guard fails" }));
    // Two hits in one turn fold into one line; another turn stands alone.
    expect(out.output).toContain("turn 1 (from_turn=0) ×2");
    expect(out.output).toContain("turn 2 (from_turn=1)");
    expect(out.output).toContain("first [guard] fails");
    expect(out.output).toContain("second [guard] fails");
  });

  test("a hit whose session cannot be read is still shown", async () => {
    // The snippet is worth having even when the turn it came from is
    // out of reach.
    const p = await plugin(
      host({
        list: () => [summary("opencode:s1", { title: "fix the thing" } as Partial<SessionSummary>)],
        search: () => [
          anchored("opencode:s1", "2026-11-18T09:00:00Z", "the [guard] fails", { turn_id: "t9" }),
        ],
      }),
    );
    const out = await p.callTool(req("search", { query: "guard fails" }));
    expect(out.output).toContain("the [guard] fails");
    expect(out.output).not.toContain("from_turn=");
  });
});

describe("the read scope", () => {
  test("the default scope keeps a read inside the caller's workspace", async () => {
    const p = await plugin(
      host({
        view: (id) => view({ session_id: id, workspace: "/other-repo" }),
      }),
    );
    const out = await p.callTool(req("read", { session_id: "opencode:ses1" }));
    expect(out.isError).toBe(true);
    expect(out.output).toContain("no such session");
  });

  test("the global scope reads a session in another workspace", async () => {
    const p = await plugin(
      host({
        view: (id) => view({ session_id: id, workspace: "/other-repo" }),
      }),
      { scope: "global" },
    );
    const out = await p.callTool(req("read", { session_id: "opencode:ses1" }));
    expect(out.isError).not.toBe(true);
    expect(out.output).toContain("== session opencode:ses1 ==");
  });

  test("the global scope lists across workspaces", async () => {
    const seen: Parameters<SessionsHost["list"]>[0][] = [];
    const p = await plugin(
      host({
        list: (opts) => {
          seen.push(opts);
          return [summary("opencode:other", { workspace: "/other-repo" })];
        },
      }),
      { scope: "global" },
    );
    const out = await p.callTool(req("list"));
    expect(seen[0]!.workspace).toBeUndefined();
    expect(out.output).toContain("sessions in every workspace:");
  });
});

describe("sessions_read", () => {
  const viewWith = (turns: Turn[], over: Partial<SessionView> = {}) =>
    view({ session_id: "opencode:ses1", turns, ...over });

  test("reads a same-workspace session, resolving a native id", async () => {
    const p = await plugin(host({ view: (id) => viewWith([turn("t1", "hi", "there")], { session_id: id }) }));
    const out = await p.callTool(req("read", { session_id: "ses1" }));
    expect(out.output).toContain("== session opencode:ses1 ==");
    expect(out.output).toContain("[user] hi");
    expect(out.output).toContain("[assistant] there");
  });

  test("other workspaces and unknown ids answer identically", async () => {
    const p = await plugin(
      host({
        view: (id) => {
          if (id === "opencode:other") return viewWith([], { session_id: id, workspace: "/other" });
          throw new Error("no such session");
        },
      }),
    );
    const foreign = await p.callTool(req("read", { session_id: "opencode:other" }));
    const missing = await p.callTool(req("read", { session_id: "opencode:gone" }));
    expect(foreign.isError).toBe(true);
    expect(missing.isError).toBe(true);
    // identical shape — nothing says the id exists but lives elsewhere
    expect(foreign.output).toBe(missing.output.replace("opencode:gone", "opencode:other"));
  });

  test("pages by turn index from the tail by default", async () => {
    const turns = Array.from({ length: 30 }, (_, i) => turn(`t${i}`, `q${i}`, `a${i}`));
    const p = await plugin(host({ view: () => viewWith(turns) }));
    const out = await p.callTool(req("read", { session_id: "opencode:ses1", max_turns: 5 }));
    expect(out.output).toContain("showing 26-30");
    expect(out.output).toContain("[user] q29");
    expect(out.output).toContain("earlier_from_turn: 20");
    expect(out.output).not.toContain("next_from_turn");
    const earlier = await p.callTool(req("read", { session_id: "opencode:ses1", from_turn: 25, max_turns: 5 }));
    expect(earlier.output).toContain("showing 26-30");
    expect(earlier.output).toContain("earlier_from_turn: 20");
    const first = await p.callTool(req("read", { session_id: "opencode:ses1", from_turn: 0, max_turns: 5 }));
    expect(first.output).toContain("showing 1-5");
    expect(first.output).toContain("next_from_turn: 5");
    expect(first.output).not.toContain("earlier_from_turn");
  });
});

describe("digest", () => {
  test("thinking is omitted, tool calls render compactly, long text is cut", () => {
    const t: Turn = {
      turn_id: "t1",
      user: [{ type: "text", text: "do it" } as ContentBlock],
      assistant: [
        {
          content: [
            { type: "thinking", text: "secret reasoning" } as ContentBlock,
            { type: "text", text: "on it" } as ContentBlock,
          ],
        },
      ],
      tool_calls: [toolCall({ output: "log line" })],
    };
    const out = digest(view({ turns: [t] }));
    expect(out.text).not.toContain("secret reasoning");
    expect(out.text).toContain('[tool] dev_start {"command":"bun dev"} → ok');
    expect(out.text).toContain("log line");

    const long: Turn = {
      turn_id: "t2",
      assistant: [{ content: [{ type: "text", text: "x".repeat(4000) } as ContentBlock] }],
      tool_calls: [],
    };
    const cut = digest(view({ turns: [long] }));
    expect(cut.text).toContain("+2500 chars");
  });

  test("raw gives the original text instead of a digest of it", () => {
    // The digest cuts a long reply to 1500 characters, which is where a
    // file listing or a token check disappears. Raw is the reader asking
    // for the whole thing.
    const body = "z".repeat(3000);
    const long: Turn = {
      turn_id: "t1",
      assistant: [{ content: [{ type: "text", text: body } as ContentBlock] }],
      tool_calls: [],
    };
    const digested = digest(view({ turns: [long] }));
    expect(digested.text).toContain("+1500 chars");
    expect(digested.text).not.toContain(body);

    const raw = digest(view({ turns: [long] }), { raw: true });
    expect(raw.text).toContain(body);
    expect(raw.text).not.toContain("+1500 chars");
  });

  test("a query returns only the turns that mention it", () => {
    // A reader who knows what they are looking for does not want the
    // whole session read back at them.
    const turns = [
      turn("t0", "about the deploy", "shipped"),
      turn("t1", "nothing to see", "indeed"),
      turn("t2", "the registry again", "yes"),
    ];
    const out = digest(view({ turns }), { query: "registry" });
    expect(out.text).toContain("the registry again");
    expect(out.text).not.toContain("nothing to see");
    expect(out.text).toContain("turn 3 (from_turn=2)");
    expect(out.matched).toEqual([2]);
  });

  test("the query cursor points at the next match, not the next turn", () => {
    // Paging by turn would land the reader on a page with nothing in it.
    const turns = [
      turn("t0", "first hit", "a"),
      turn("t1", "nothing", "b"),
      turn("t2", "nothing", "c"),
      turn("t3", "second hit", "d"),
    ];
    // One match a page, so there is a next page to point at.
    const out = digest(view({ turns }), { query: "hit", maxTurns: 1 });
    expect(out.nextFrom).toBe(3);
    expect(out.text).toContain("next_from_turn: 3");
  });

  test("the back cursor starts the previous page of matches", () => {
    const turns = [
      turn("t0", "hit one", "a"),
      turn("t1", "hit two", "b"),
      turn("t2", "hit three", "c"),
      turn("t3", "hit four", "d"),
    ];
    const page = digest(view({ turns }), { query: "hit", maxTurns: 2 });
    expect(page.matched).toEqual([0, 1]);
    expect(page.nextFrom).toBe(2);
    // The next page starts at match 2, and going back from there lands
    // on the page before this one.
    const second = digest(view({ turns }), { query: "hit", maxTurns: 2, from: 2 });
    expect(second.matched).toEqual([2, 3]);
    expect(second.earlierFrom).toBe(0);
  });

  test("a match is found in the text as written, not as digested", () => {
    // The digest cuts a long reply to 1500 characters. A match beyond
    // that cut must still be found, or the hit is lost exactly where
    // the detail is.
    const long = "x".repeat(2000) + " needle " + "y".repeat(2000);
    const out = digest(view({ turns: [turn("t0", long, "ok")] }), { query: "needle" });
    expect(out.matched).toEqual([0]);
  });

  test("every word has to appear unless the reader says otherwise", () => {
    const turns = [turn("t0", "alpha only", "a"), turn("t1", "alpha and beta", "b")];
    expect(digest(view({ turns }), { query: "alpha beta" }).matched).toEqual([1]);
    expect(digest(view({ turns }), { query: "alpha beta", match: "any" }).matched).toEqual([0, 1]);
  });

  test("a turn that would exceed max_chars becomes the next page", () => {
    const turns = Array.from({ length: 4 }, (_, i) =>
      turn(`t${i}`, "q".repeat(2000), "a".repeat(2000)),
    );
    const page = digest(view({ turns }), { from: 0, maxTurns: 4, maxChars: 4000 });
    expect(page.nextFrom).not.toBeNull();
    expect(page.to).toBeLessThan(4);
    // at least one turn always lands, even oversized
    expect(page.to).toBeGreaterThan(0);
  });
});

describe("manifest", () => {
  test("exposes the three read tools as sessions_* with a read-only policy", () => {
    expect(manifest.id).toBe("sessions");
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(["list", "read", "search"]);
    for (const tool of manifest.tools) {
      expect(tool.policy).toEqual({ default: "allow", risk: "read" });
    }
  });
});
