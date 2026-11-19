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
