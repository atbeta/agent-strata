import { describe, expect, test } from "bun:test";
import { connectAcpAgent, AcpRecorder, type OnAsk } from "../src/index";
import { openStore } from "@agent-strata/store";
import { projectSession } from "@agent-strata/projector";
import { loadPolicy } from "@agent-strata/policy";
import { parseEvent, type EventInput } from "@agent-strata/schema";
import { fileURLToPath } from "node:url";

const MOCK = fileURLToPath(new URL("./fixtures/mock-agent.ts", import.meta.url));
const BUN = process.execPath; // bun binary

const policy = loadPolicy({
  version: 1,
  default: "ask",
  rules: [
    { id: "allow-git", effect: "allow", tool: "execute", when: { command: { matches: "^git\\b" } } },
    { id: "deny-rm", effect: "deny", tool: "execute", when: { command: { matches: "^rm\\b" } } },
  ],
});

async function connect(sink: { append(e: EventInput[]): unknown }, onAsk?: OnAsk) {
  return connectAcpAgent({
    command: BUN,
    args: [MOCK],
    agentName: "mock",
    sink,
    policy,
    onAsk,
  });
}

const types = (s: ReturnType<typeof openStore>, sid: string) =>
  s.read({ session_id: sid }).map((e) => e.type);

describe("adapter-acp integration (real subprocess)", () => {
  test("basic scenario: coalesced chunks, permission allow, tool result, usage/cost", async () => {
    const store = openStore(":memory:");
    const agent = await connect(store);
    const sid = await agent.newSession("/tmp");
    const resp = await agent.prompt(sid, "basic");
    expect(resp.stopReason).toBe("end_turn");
    await agent.close();

    expect(types(store, sid)).toEqual([
      "session.started",
      "turn.user",
      "turn.assistant",
      "tool.call",
      "permission.requested",
      "permission.resolved",
      "tool.result",
      "turn.assistant",
      "session.ended",
    ]);
    const evs = store.read({ session_id: sid });
    const resolved = evs.find((e) => e.type === "permission.resolved")!;
    const rd = resolved.data as { decision: string; by: string; rule_id: string };
    expect(rd).toMatchObject({ decision: "allow", by: "policy", rule_id: "allow-git" });
    const result = evs.find((e) => e.type === "tool.result")!;
    expect((result.data as { output: string }).output).toBe("outcome:a1");

    const view = projectSession(evs);
    expect(view.turns.length).toBe(1);
    const t = view.turns[0]!;
    expect(t.assistant.length).toBe(2);
    const blocks = t.assistant.flatMap((a) => a.content);
    expect(blocks[0]).toMatchObject({ type: "thinking", text: "thinking..." });
    expect(blocks[1]).toMatchObject({ type: "text", text: "part one. part two." });
    expect(t.assistant.at(-1)!.usage).toMatchObject({
      input: 11, output: 7, reasoning: 3, cache_read: 2, cache_write: 1,
    });
    expect(view.totals.cost_usd).toBeCloseTo(0.0123);
    expect(t.tool_calls[0]!.status).toBe("ok");
    expect(view.status).toBe("completed");
  });

  test("deny scenario: policy rejects rm, agent sees reject, result is error", async () => {
    const store = openStore(":memory:");
    const agent = await connect(store);
    const sid = await agent.newSession("/tmp");
    await agent.prompt(sid, "deny");
    await agent.close();

    const evs = store.read({ session_id: sid });
    const resolved = evs.find((e) => e.type === "permission.resolved")!;
    expect((resolved.data as { decision: string }).decision).toBe("deny");
    expect((resolved.data as { rule_id: string }).rule_id).toBe("deny-rm");
    const result = evs.find((e) => e.type === "tool.result")!;
    expect((result.data as { status: string; output: string })).toMatchObject({
      status: "error",
      output: "outcome:r1",
    });
    const view = projectSession(evs);
    expect(view.turns[0]!.tool_calls[0]!.status).toBe("error");
    expect(view.totals.permissions_denied).toBe(1);
    store.close();
  });

  test("ask scenario: no matching rule -> onAsk allows", async () => {
    const store = openStore(":memory:");
    const asked: string[] = [];
    const agent = await connect(store, async (req) => {
      asked.push(req.data.input.command as string);
      return { decision: "allow" };
    });
    const sid = await agent.newSession("/tmp");
    await agent.prompt(sid, "ask");
    await agent.close();
    expect(asked).toEqual(["npm install"]);
    const evs = store.read({ session_id: sid });
    const resolved = evs.find((e) => e.type === "permission.resolved")!;
    expect((resolved.data as { by: string }).by).toBe("user");
    const result = evs.find((e) => e.type === "tool.result")!;
    expect((result.data as { output: string }).output).toBe("outcome:a1");
    store.close();
  });

  test("diff scenario: file.changed add + modify", async () => {
    const store = openStore(":memory:");
    const agent = await connect(store);
    const sid = await agent.newSession("/tmp");
    await agent.prompt(sid, "diff");
    await agent.close();
    const view = projectSession(store.read({ session_id: sid }));
    expect(view.files_changed).toEqual([
      { path: "new.ts", change: "add", count: 1 },
      { path: "old.ts", change: "modify", count: 1 },
    ]);
    const fc = store.read({ session_id: sid }).find(
      (e) => e.type === "file.changed" && (e.data as { path: string }).path === "old.ts",
    )!;
    expect((fc.data as { diff: string }).diff).toContain("const b = 2");
    store.close();
  });

  test("crash scenario: session.ended error", async () => {
    const store = openStore(":memory:");
    const agent = await connect(store);
    const sid = await agent.newSession("/tmp");
    try {
      await agent.prompt(sid, "crash");
    } catch {
      // prompt may reject on agent exit
    }
    await Bun.sleep(300);
    const evs = store.read({ session_id: sid });
    const ended = evs.find((e) => e.type === "session.ended");
    expect(ended).toBeDefined();
    expect((ended!.data as { reason: string; error: string }).reason).toBe("error");
    expect((ended!.data as { error: string }).error).toContain("42");
    await agent.close().catch(() => {});
    store.close();
  });
});

describe("AcpRecorder unit", () => {
  const mkRecorder = () => {
    const appended: EventInput[][] = [];
    const r = new AcpRecorder({ agentName: "m", sink: { append: (e) => appended.push(e) } });
    const s = r.startSession("acp-1", "acp:m:acp-1");
    s.turnId = "t1";
    return { r, s, appended, flat: () => appended.flat() };
  };

  test("chunk coalescing", async () => {
    const { r, s, flat } = mkRecorder();
    const chunk = (k: string, t: string) =>
      r.sessionUpdate({
        sessionId: "acp-1",
        update: { sessionUpdate: k, content: { type: "text", text: t } } as never,
      });
    await chunk("agent_message_chunk", "a");
    await chunk("agent_message_chunk", "b");
    await chunk("agent_thought_chunk", "c");
    r.endTurn("acp-1", "end_turn");
    const ev = flat().find((e) => e.type === "turn.assistant")!;
    expect((ev.data as { content: unknown[] }).content).toEqual([
      { type: "text", text: "ab" },
      { type: "thinking", text: "c" },
    ]);
    expect(s.buffer.length).toBe(0);
  });

  test("tool_call_update before tool_call emits call first; result once", async () => {
    const { r, flat } = mkRecorder();
    await r.sessionUpdate({
      sessionId: "acp-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        title: "ls",
        kind: "execute",
        rawInput: { command: "ls" },
        status: "in_progress",
      } as never,
    });
    await r.sessionUpdate({
      sessionId: "acp-1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] } as never,
    });
    await r.sessionUpdate({
      sessionId: "acp-1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] } as never,
    });
    const evs = flat();
    expect(evs.filter((e) => e.type === "tool.call").length).toBe(1);
    expect(evs.filter((e) => e.type === "tool.result").length).toBe(1);
    const tc = evs.find((e) => e.type === "tool.call")!;
    expect(tc.id).toBe("acp:m:acp-1:c1:tool.call");
    parseEvent({ ...tc, id: tc.id ?? "x", seq: 1 });
  });

  test("options selection matrix: policy deny picks reject_once, else reject_always", async () => {
    const appended: EventInput[][] = [];
    const pol = loadPolicy({
      version: 1,
      rules: [{ id: "no", effect: "deny", tool: "*", when: { command: { matches: "rm" } } }],
    });
    const mk = (options: { optionId: string; kind: string }[]) =>
      new AcpRecorder({ agentName: "m", sink: { append: (e) => appended.push(e) }, policy: pol });
    const r1 = mk([]);
    r1.startSession("s1", "acp:m:s1");
    r1.sessions.get("s1")!.turnId = "t";
    const res1 = await r1.requestPermission({
      sessionId: "s1",
      options: [
        { optionId: "r1", name: "r", kind: "reject_once" },
        { optionId: "r2", name: "ra", kind: "reject_always" },
      ],
      toolCall: { toolCallId: "c", title: "rm x", kind: "execute", rawInput: { command: "rm x" } },
    });
    expect(res1.outcome).toEqual({ outcome: "selected", optionId: "r1" });
    // only reject_always offered
    const res2 = await r1.requestPermission({
      sessionId: "s1",
      options: [{ optionId: "r2", name: "ra", kind: "reject_always" }],
      toolCall: { toolCallId: "c2", title: "rm y", kind: "execute", rawInput: { command: "rm y" } },
    });
    expect(res2.outcome).toEqual({ outcome: "selected", optionId: "r2" });
    // policy allow picks allow_once; missing allow_once -> falls to ask -> auto deny without onAsk
    const polAllow = loadPolicy({ version: 1, rules: [{ id: "ok", effect: "allow", tool: "*" }] });
    const r2 = new AcpRecorder({ agentName: "m", sink: { append: (e) => appended.push(e) }, policy: polAllow });
    r2.startSession("s2", "acp:m:s2");
    const res3 = await r2.requestPermission({
      sessionId: "s2",
      options: [{ optionId: "a2", name: "aa", kind: "allow_always" }],
      toolCall: { toolCallId: "c", title: "t", kind: "execute", rawInput: {} },
    });
    // no allow_once option -> treated as ask -> no onAsk -> cancelled + auto deny
    expect(res3.outcome).toEqual({ outcome: "cancelled" });
    const resolved = appended.flat().find((e) => e.type === "permission.resolved" && (e.data as { request_id: string }).request_id);
    expect(resolved).toBeDefined();
  });

  test("ask with no onAsk answers reject, not cancel", async () => {
    const appended: EventInput[][] = [];
    const r = new AcpRecorder({ agentName: "m", sink: { append: (e) => appended.push(e) } });
    r.startSession("s", "acp:m:s");
    const res = await r.requestPermission({
      sessionId: "s",
      options: [
        { optionId: "a1", name: "allow", kind: "allow_once" },
        { optionId: "r1", name: "reject", kind: "reject_once" },
      ],
      toolCall: { toolCallId: "c", title: "t", kind: "execute", rawInput: {} },
    });
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "r1" });
    const resolved = appended.flat().find((e) => e.type === "permission.resolved")!;
    expect(resolved.data).toMatchObject({ decision: "deny", by: "auto", reason: "no handler" });
    // only reject_always offered -> still selected
    const res2 = await r.requestPermission({
      sessionId: "s",
      options: [{ optionId: "r2", name: "reject", kind: "reject_always" }],
      toolCall: { toolCallId: "c2", title: "t", kind: "execute", rawInput: {} },
    });
    expect(res2.outcome).toEqual({ outcome: "selected", optionId: "r2" });
    // neither reject kind offered -> cancelled
    const res3 = await r.requestPermission({
      sessionId: "s",
      options: [{ optionId: "a1", name: "allow", kind: "allow_once" }],
      toolCall: { toolCallId: "c3", title: "t", kind: "execute", rawInput: {} },
    });
    expect(res3.outcome).toEqual({ outcome: "cancelled" });
  });

  test("policy never selects allow_always on its own", async () => {
    const appended: EventInput[][] = [];
    const pol = loadPolicy({ version: 1, rules: [{ id: "ok", effect: "allow", tool: "*" }] });
    const r = new AcpRecorder({ agentName: "m", sink: { append: (e) => appended.push(e) }, policy: pol });
    r.startSession("s", "acp:m:s");
    const res = await r.requestPermission({
      sessionId: "s",
      options: [
        { optionId: "once", name: "once", kind: "allow_once" },
        { optionId: "always", name: "always", kind: "allow_always" },
      ],
      toolCall: { toolCallId: "c", title: "t", kind: "execute", rawInput: {} },
    });
    expect(res.outcome).toEqual({ outcome: "selected", optionId: "once" });
  });
});
