import { describe, expect, test } from "bun:test";
import { OpencodeMapper, createIngestor } from "../src/index";
import { loadPolicy } from "@agent-strata/policy";
import type { Event } from "@opencode-ai/sdk/v2";
import { openStore } from "@agent-strata/store";
import { projectSession } from "@agent-strata/projector";
import type { EventInput } from "@agent-strata/schema";

const sid = "ses_1";

const sessionCreated = (): Event =>
  ({
    id: "e1",
    type: "session.created",
    properties: {
      sessionID: sid,
      info: { id: sid, directory: "/repo", title: "T", time: { created: 1, updated: 1 } },
    },
  }) as unknown as Event;

const msgUpdated = (info: object): Event =>
  ({ id: `m-${(info as {id:string}).id}`, type: "message.updated", properties: { sessionID: sid, info } }) as unknown as Event;

const partUpdated = (part: object): Event =>
  ({ id: `p-${(part as {id:string}).id}`, type: "message.part.updated", properties: { sessionID: sid, part, time: 0 } }) as unknown as Event;

const basicFixture = (): Event[] => [
  sessionCreated(),
  msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }),
  partUpdated({ id: "pt1", sessionID: sid, messageID: "u1", type: "text", text: "hello", time: { start: 10 } }),
  msgUpdated({
    id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
    time: { created: 20 }, providerID: "anthropic", modelID: "claude", agent: "build",
    mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }),
  partUpdated({ id: "pt2", sessionID: sid, messageID: "a1", type: "reasoning", text: "hmm", time: { start: 20 } }),
  partUpdated({ id: "pt3", sessionID: sid, messageID: "a1", type: "text", text: "answer" }),
  partUpdated({
    id: "pt4", sessionID: sid, messageID: "a1", type: "tool", callID: "call1", tool: "bash",
    state: { status: "running", input: { command: "ls" }, time: { start: 21 } },
  }),
  partUpdated({
    id: "pt4", sessionID: sid, messageID: "a1", type: "tool", callID: "call1", tool: "bash",
    state: { status: "completed", input: { command: "ls" }, output: "files", title: "ls", metadata: {}, time: { start: 21, end: 31 } },
  }),
  msgUpdated({
    id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
    time: { created: 20, completed: 50 }, providerID: "anthropic", modelID: "claude", agent: "build",
    mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0.25, finish: "stop",
    tokens: { input: 100, output: 40, reasoning: 5, cache: { read: 3, write: 2 } },
  }),
  {
    id: "t1",
    type: "todo.updated",
    properties: { sessionID: sid, todos: [{ content: "a", status: "pending", priority: "high" }] },
  } as unknown as Event,
  {
    id: "pa",
    type: "permission.asked",
    properties: {
      id: "perm1", sessionID: sid, permission: "bash",
      patterns: ["ls"], metadata: {}, always: [],
      tool: { messageID: "a1", callID: "call1" },
    },
  } as unknown as Event,
  {
    id: "pr",
    type: "permission.replied",
    properties: { sessionID: sid, requestID: "perm1", reply: "once" },
  } as unknown as Event,
];

describe("OpencodeMapper", () => {
  test("basic turn with reasoning+text+tool", () => {
    const m = new OpencodeMapper();
    const out = basicFixture().flatMap((e) => m.handle(e));
    expect(out.map((e) => e.type)).toEqual([
      "session.started",
      "turn.user",
      "turn.assistant", // partial stream snapshot from the first reasoning part
      "tool.call",
      "tool.result",
      "turn.assistant", // final completed message (same msg_id, replaces partial)
      "plan.updated",
      "permission.requested",
      "permission.resolved",
    ]);
    const assistants = out.filter((e) => e.type === "turn.assistant");
    expect(assistants.length).toBe(2);
    const partial = assistants[0]!.data as { partial?: boolean; msg_id?: string };
    expect(partial).toMatchObject({ partial: true, msg_id: "a1" });
    const ta = assistants.at(-1)!;
    const d = ta.data as { model: string; usage: { input: number; cache_read: number }; cost_usd: number; latency_ms: number; stop_reason: string; content: object[]; turn_id: string };
    expect(d.turn_id).toBe("u1");
    expect(d.model).toBe("anthropic/claude");
    expect(d.usage).toMatchObject({ input: 100, output: 40, reasoning: 5, cache_read: 3, cache_write: 2 });
    expect(d.cost_usd).toBe(0.25);
    expect(d.latency_ms).toBe(30);
    expect(d.stop_reason).toBe("stop");
    expect(d.content).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "text", text: "answer" },
    ]);
    const tr = out.find((e) => e.type === "tool.result")!;
    expect(tr.id).toBe("opencode:pt4:tool.result");
    expect((tr.data as { latency_ms: number }).latency_ms).toBe(10);
  });

  test("repeated part snapshots don't duplicate; deterministic ids dedupe in store", () => {
    const store = openStore(":memory:");
    const mapper = new OpencodeMapper();
    for (const e of basicFixture()) {
      const evts = mapper.handle(e);
      if (evts.length) store.append(evts);
    }
    const n1 = store.read({ session_id: `opencode:${sid}` }).length;
    // replay the whole stream through a fresh mapper (simulated re-ingest)
    const m2 = new OpencodeMapper();
    for (const e of basicFixture()) {
      const evts = m2.handle(e);
      if (evts.length) store.append(evts);
    }
    const n2 = store.read({ session_id: `opencode:${sid}` }).length;
    // all fixture events carry deterministic ids (incl. todo/permission) -> replay adds nothing
    expect(n2).toBe(n1);
    store.close();
  });

  test("part.updated before message.updated still lands in turn.user", () => {
    const m = new OpencodeMapper();
    const out = [
      m.handle(sessionCreated()),
      // user text part arrives before the user message.updated
      m.handle(partUpdated({ id: "pt", sessionID: sid, messageID: "u1", type: "text", text: "early" })),
      m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })),
      m.handle({ id: "i", type: "session.idle", properties: { sessionID: sid } } as unknown as Event),
    ].flat();
    const tu = out.find((e) => e.type === "turn.user")!;
    expect((tu.data as { content: object[] }).content).toEqual([{ type: "text", text: "early" }]);
  });

  test("question.asked maps options; idle emits session.status", () => {
    const m = new OpencodeMapper();
    const asked = m.handle({
      id: "q",
      type: "question.asked",
      properties: {
        id: "req1",
        sessionID: sid,
        questions: [
          {
            question: "Pick one",
            header: "Pick",
            options: [{ label: "a", description: "A" }],
            multiple: false,
          },
        ],
      },
    } as unknown as Event);
    expect(asked.some((e) => e.type === "session.started")).toBe(true);
    const q = asked.find((e) => e.type === "question.asked")!;
    expect(q.data).toMatchObject({
      request_id: "req1",
      questions: [{ header: "Pick", options: [{ label: "a", description: "A" }] }],
    });
    const idle = m.handle({
      id: "idle1",
      type: "session.idle",
      properties: { sessionID: sid },
    } as unknown as Event);
    expect(idle.find((e) => e.type === "session.status")!.data).toEqual({ state: "idle" });
  });

  test("turn.user echoes on first text part; idle doesn't re-emit", () => {
    const m = new OpencodeMapper();
    const out1 = [
      m.handle(sessionCreated()),
      m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })),
      m.handle(partUpdated({ id: "pt", sessionID: sid, messageID: "u1", type: "text", text: "hi" })),
    ].flat();
    expect(out1.filter((e) => e.type === "turn.user").length).toBe(1);
    const out2 = m.handle({
      id: "i", type: "session.idle", properties: { sessionID: sid },
    } as unknown as Event);
    expect(out2.filter((e) => e.type === "turn.user").length).toBe(0);
  });

  test("assistant part updates emit throttled partial turn.assistant", async () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } }));
    m.handle(partUpdated({ id: "pt", sessionID: sid, messageID: "u1", type: "text", text: "hi" }));
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2 }, providerID: "anthropic", modelID: "claude",
    }));
    const p1 = m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "h" }));
    expect(p1.filter((e) => e.type === "turn.assistant").length).toBe(1);
    // inside the throttle window -> dropped
    const p2 = m.handle(partUpdated({ id: "pb", sessionID: sid, messageID: "a1", type: "text", text: "he" }));
    expect(p2.filter((e) => e.type === "turn.assistant").length).toBe(0);
    await Bun.sleep(160);
    const p3 = m.handle(partUpdated({ id: "pc", sessionID: sid, messageID: "a1", type: "text", text: "hel" }));
    const partials = p3.filter((e) => e.type === "turn.assistant");
    expect(partials.length).toBe(1);
    expect(partials[0]!.data).toMatchObject({ partial: true, msg_id: "a1", turn_id: "u1" });
  });

  test("partial snapshots merge into the final message in projection", () => {
    const store = openStore(":memory:");
    const m = new OpencodeMapper();
    for (const e of basicFixture()) {
      const evts = m.handle(e);
      if (evts.length) store.append(evts);
    }
    const view = projectSession(store.read({ session_id: `opencode:${sid}` }));
    const turn = view.turns.find((t) => t.turn_id === "u1")!;
    expect(turn.assistant.length).toBe(1);
    expect(turn.assistant[0]!.partial).toBeUndefined();
    expect(turn.assistant[0]!.content).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "text", text: "answer" },
    ]);
    expect(view.totals.input).toBe(100);
    expect(view.totals.cost_usd).toBe(0.25);
    store.close();
  });

  test("permission.asked -> permission.requested; replied -> resolved with shared id", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const asked = m.handle({
      id: "pa",
      type: "permission.asked",
      properties: {
        id: "perm1", sessionID: sid, permission: "bash",
        patterns: ["rm -rf /"], metadata: {}, always: ["rm"],
        tool: { messageID: "a1", callID: "call1" },
      },
    } as unknown as Event);
    const req = asked.find((e) => e.type === "permission.requested")!;
    const rd = req.data as { request_id: string; call_id: string; tool: string; input: { command: string } };
    expect(rd).toMatchObject({ request_id: "perm1", call_id: "call1", tool: "bash" });
    expect(rd.input.command).toBe("rm -rf /");
    const replied = m.handle({
      id: "pr",
      type: "permission.replied",
      properties: { sessionID: sid, requestID: "perm1", reply: "reject" },
    } as unknown as Event);
    const res = replied.find((e) => e.type === "permission.resolved")!;
    expect(res.id).toBe("opencode:perm1:permission.resolved");
    expect(res.data).toMatchObject({ decision: "deny", by: "user", scope: "once" });
  });

  test("todo.updated -> plan.updated drops unknown statuses; patch -> file.changed", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const out = m.handle({
      id: "t",
      type: "todo.updated",
      properties: {
        sessionID: sid,
        todos: [
          { content: "a", status: "pending", priority: "high" },
          { content: "b", status: "cancelled", priority: "low" },
          { content: "c", status: "completed", priority: "low" },
        ],
      },
    } as unknown as Event);
    expect((out[0]!.data as { entries: object[] }).entries).toEqual([
      { content: "a", status: "pending" },
      { content: "c", status: "completed" },
    ]);
    const fc = m.handle(partUpdated({
      id: "pp", sessionID: sid, messageID: "a1", type: "patch", hash: "h", files: ["x.ts", "y.ts"],
    }));
    expect(fc.map((e) => [e.id, e.type])).toEqual([
      ["opencode:pp:file:x.ts", "file.changed"],
      ["opencode:pp:file:y.ts", "file.changed"],
    ]);
  });

  test("lazy session.started for unknown session; later real created dedupes", () => {
    const store = openStore(":memory:");
    const m = new OpencodeMapper({ directory: "/lazy" });
    store.append(m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })));
    store.append(m.handle(sessionCreated()));
    const evs = store.read({ session_id: `opencode:${sid}` });
    expect(evs.filter((e) => e.type === "session.started").length).toBe(1);
    const started = evs[0]!;
    // lazy event has same deterministic id -> real one dedupes, lazy wins in store
    expect((started.data as { workspace: string }).workspace).toBe("/lazy");
    store.close();
  });

  test("projectSession over mapped events", () => {
    const store = openStore(":memory:");
    const m = new OpencodeMapper();
    for (const e of basicFixture()) {
      const evts = m.handle(e);
      if (evts.length) store.append(evts);
    }
    const view = projectSession(store.read({ session_id: `opencode:${sid}` }));
    expect(view.turns.length).toBe(1);
    expect(view.turns[0]!.tool_calls[0]).toMatchObject({ tool: "bash", status: "ok" });
    expect(view.totals.input).toBe(100);
    expect(view.totals.cost_usd).toBeCloseTo(0.25);
    store.close();
  });
});

describe("createIngestor seam", () => {
  const asked = (permission: string, patterns: string[], id = "perm1"): Event =>
    ({
      id: `pa-${id}`,
      type: "permission.asked",
      properties: {
        id, sessionID: sid, permission, patterns, metadata: {}, always: [],
      },
    }) as unknown as Event;

  test("(c) policy allow/deny reply and emit resolved", async () => {
    const replies: { requestID: string; reply: string; message?: string }[] = [];
    const store = openStore(":memory:");
    const policy = loadPolicy({
      version: 1,
      rules: [
        { id: "ok", effect: "allow", tool: "bash", when: { command: { matches: "^ls" } } },
        { id: "no", effect: "deny", tool: "bash", when: { command: { matches: "^rm" } } },
      ],
    });
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: store,
      policy,
      reply: async (requestID, reply, message) => {
        replies.push({ requestID, reply, message });
      },
    });
    ing.handle(sessionCreated());
    ing.handle(asked("bash", ["ls"], "perm1"));
    ing.handle(asked("bash", ["rm -rf /"], "perm2"));
    await Bun.sleep(50);
    expect(replies).toEqual([
      { requestID: "perm1", reply: "once", message: undefined },
      { requestID: "perm2", reply: "reject", message: expect.anything() },
    ]);
    const evs = store.read({ session_id: `opencode:${sid}` });
    const resolved = evs.filter((e) => e.type === "permission.resolved");
    expect(resolved.map((e) => (e.data as { decision: string; by: string }).decision)).toEqual(["allow", "deny"]);
    store.close();
  });

  test("(a) pending onAsk does not block later events", async () => {
    const store = openStore(":memory:");
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: store,
      onAsk: () => new Promise(() => {}), // never resolves
      reply: async () => {},
    });
    ing.handle(sessionCreated());
    ing.handle(asked("bash", ["xyz-unknown"])); // default ask -> onAsk hangs
    // a later event must still be mapped and stored
    ing.handle(partUpdated({ id: "pt", sessionID: sid, messageID: "u1", type: "text", text: "later" }));
    await Bun.sleep(50);
    const evs = store.read({ session_id: `opencode:${sid}` });
    expect(evs.some((e) => e.type === "permission.requested")).toBe(true);
    store.close();
  });

  test("(b) reply throwing leaves stream usable and stores no resolved", async () => {
    const store = openStore(":memory:");
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: store,
      policy: loadPolicy({ version: 1, rules: [{ id: "ok", effect: "allow", tool: "*" }] }),
      reply: async () => {
        throw new Error("network down");
      },
    });
    ing.handle(sessionCreated());
    ing.handle(asked("bash", ["ls"]));
    await Bun.sleep(50);
    ing.handle(partUpdated({ id: "pt", sessionID: sid, messageID: "u1", type: "text", text: "after" }));
    const evs = store.read({ session_id: `opencode:${sid}` });
    expect(evs.some((e) => e.type === "permission.resolved")).toBe(false);
    expect(evs.some((e) => e.type === "permission.requested")).toBe(true);
    store.close();
  });
});

// offline replay of a recorded real-server event stream
describe("live fixture replay", () => {
  test("opencode-live-deepseek.jsonl projects like the allow path", async () => {
    const text = await Bun.file(
      new URL("./fixtures/opencode-live-deepseek.jsonl", import.meta.url),
    ).text();
    const store = openStore(":memory:");
    const mapper = new OpencodeMapper({ directory: "/tmp/strata-e2e" });
    let sessionID = "";
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line) as Event;
      for (const out of mapper.handle(evt)) {
        sessionID = out.session_id;
        store.append([out]);
      }
    }
    // fixture must end at the idle signal for its session
    const last = JSON.parse(
      text.trimEnd().split("\n").at(-1)!,
    ) as Event;
    const lastProps = last.properties as { sessionID?: string; status?: { type: string } };
    expect(lastProps.sessionID).toBe(sessionID.replace(/^opencode:/, ""));
    const idle =
      last.type === "session.idle" ||
      (last.type === "session.status" && lastProps.status?.type === "idle");
    expect(idle).toBe(true);

    const evs = store.read({ session_id: sessionID });
    expectAllowPath(evs);
    store.close();
  });
});

// gated live test
const E2E = process.env.AGENT_STRATA_OPENCODE_E2E === "1";
const HAS_KEY = !!process.env.DEEPSEEK_API_KEY;
const port = Number(process.env.OPENCODE_PORT ?? 4096);
const dir = process.env.OPENCODE_DIR ?? "/tmp";

// resolves when a session.status idle (or session.idle) event for sessionID
// arrives through onEvent; rejects after timeoutMs
function waitForIdle(
  sessionID: string,
  onEvent: (cb: (evt: Event) => void) => void,
  timeoutMs = 120_000,
) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`session ${sessionID} did not reach idle within ${timeoutMs}ms`)),
      timeoutMs,
    );
    onEvent((evt) => {
      const props = evt.properties as { sessionID?: string; status?: { type: string } };
      if (props.sessionID !== sessionID) return;
      if (evt.type === "session.status" && props.status?.type === "idle") {
        clearTimeout(timer);
        resolve();
      }
      if (evt.type === "session.idle") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function prompt(
  client: { session: { prompt: (p: unknown) => Promise<unknown> } },
  sessionID: string,
  text: string,
) {
  await client.session.prompt({
    sessionID,
    directory: dir,
    parts: [{ type: "text", text }],
  });
}

const casf = (store: ReturnType<typeof openStore>, sessionID: string) =>
  store.read({ session_id: `opencode:${sessionID}` });

function expectAllowPath(evs: ReturnType<ReturnType<typeof openStore>["read"]>) {
  expect(evs[0]?.type).toBe("session.started");
  expect(JSON.stringify(evs.find((e) => e.type === "turn.user")!.data)).toContain(
    "echo agent-strata-e2e",
  );
  expect(evs.some((e) => e.type === "permission.requested")).toBe(true);
  const res = evs.find((e) => e.type === "permission.resolved")!;
  expect((res.data as { decision: string }).decision).toBe("allow");
  const tc = evs.find((e) => e.type === "tool.call")!;
  expect((tc.data as { tool: string }).tool).toBe("bash");
  const tr = evs.find((e) => e.type === "tool.result")!;
  const trd = tr.data as { status: string; output?: string };
  expect(trd.status).toBe("ok");
  expect(trd.output).toContain("agent-strata-e2e");
  const assistants = evs.filter((e) => e.type === "turn.assistant");
  expect(assistants.length).toBeGreaterThanOrEqual(2);
  const last = assistants.at(-1)!.data as {
    model?: string;
    stop_reason?: string;
    usage?: { input: number; output: number; cache_read?: number };
    content?: { type: string; text?: string }[];
  };
  expect(last.model).toBe("deepseek/deepseek-flash");
  expect(last.stop_reason).not.toBe("tool-calls");
  expect(
    (last.content ?? []).some((b) => b.type === "text" && b.text?.includes("agent-strata-e2e")),
  ).toBe(true);
  expect(
    assistants.some(
      (e) =>
        ((e.data as { usage?: { cache_read?: number } }).usage?.cache_read ?? 0) > 0,
    ),
  ).toBe(true);

  const view = projectSession(evs);
  const pending = [...view.turns.flatMap((t) => t.tool_calls), ...view.orphans].filter(
    (c) => c.status === "pending",
  );
  expect(pending.length).toBe(0);
  expect(view.totals.input).toBeGreaterThan(0);
  expect(view.totals.output).toBeGreaterThan(0);
  expect(view.totals.tool_calls).toBeGreaterThan(0);
  expect(view.totals.cost_usd).toBeGreaterThan(0);
}

describe.skipIf(!E2E)("opencode live e2e", () => {
  test("session.created -> session.started end-to-end", async () => {
    const { connectOpencode } = await import("../src/index");
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
    const store = openStore(":memory:");
    const client = createOpencodeClient({ baseUrl: `http://localhost:${port}`, directory: dir });
    let sessionID = "";
    let sessionCreated!: (evt: Event) => void;
    const created = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no session.created within 10s")), 10_000);
      sessionCreated = (evt) => {
        const props = evt.properties as { sessionID?: string };
        if (evt.type === "session.created" && props.sessionID === sessionID) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    const conn = await connectOpencode({
      baseUrl: `http://localhost:${port}`,
      directory: dir,
      sink: store,
      onEvent: (evt) => sessionCreated(evt),
    });
    const sess = await client.session.create({ directory: dir });
    sessionID = sess.data!.id;
    await created;
    conn.stop();
    const evs = store.read({ session_id: `opencode:${sessionID}` });
    expect(evs[0]?.type).toBe("session.started");
    store.close();
  });
});

describe.skipIf(!(E2E && HAS_KEY))("opencode live e2e (deepseek)", () => {
  test("allow path: prompt -> bash echo -> permission allow -> tool.result -> turn.assistant", async () => {
    const { connectOpencode } = await import("../src/index");
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
    const store = openStore(":memory:");
    const policy = loadPolicy({
      version: 1,
      rules: [{ id: "echo-ok", effect: "allow", tool: "bash", when: { command: { matches: "^echo\\b" } } }],
    });
    const client = createOpencodeClient({ baseUrl: `http://localhost:${port}`, directory: dir });
    const listeners = new Set<(evt: Event) => void>();
    const conn = await connectOpencode({
      baseUrl: `http://localhost:${port}`,
      directory: dir,
      sink: store,
      policy,
      onEvent: (evt) => {
        for (const cb of listeners) cb(evt);
      },
    });
    const sess = await client.session.create({ directory: dir });
    const sessionID = sess.data!.id;
    const text = "Use the bash tool to run exactly: echo agent-strata-e2e — then reply with its output.";
    const idle = waitForIdle(sessionID, (cb) => listeners.add(cb));
    await prompt(client as never, sessionID, text);
    await idle;
    if (!casf(store, sessionID).some((e) => e.type === "permission.requested")) {
      // model may not have called the tool: retry once
      const idle2 = waitForIdle(sessionID, (cb) => listeners.add(cb));
      await prompt(client as never, sessionID, text);
      await idle2;
    }
    conn.stop();

    const evs = casf(store, sessionID);
    expectAllowPath(evs);
    const res = evs.find((e) => e.type === "permission.resolved")!;
    expect((res.data as { by: string }).by).toBe("policy");
    store.close();
  }, 180_000);

  test("deny path: rm denied by policy, session still reaches idle", async () => {
    const { connectOpencode } = await import("../src/index");
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
    const store = openStore(":memory:");
    const policy = loadPolicy({
      version: 1,
      rules: [{ id: "no-rm", effect: "deny", tool: "bash", when: { command: { matches: "^rm\\b" } } }],
    });
    const client = createOpencodeClient({ baseUrl: `http://localhost:${port}`, directory: dir });
    const listeners = new Set<(evt: Event) => void>();
    const conn = await connectOpencode({
      baseUrl: `http://localhost:${port}`,
      directory: dir,
      sink: store,
      policy,
      onEvent: (evt) => {
        for (const cb of listeners) cb(evt);
      },
    });
    const sess = await client.session.create({ directory: dir });
    const sessionID = sess.data!.id;
    const text = "Use the bash tool to run exactly: rm -f /tmp/strata-e2e/nonexistent.txt — then tell me the result.";
    const idle = waitForIdle(sessionID, (cb) => listeners.add(cb));
    await prompt(client as never, sessionID, text);
    await idle;
    conn.stop();

    const evs = casf(store, sessionID);
    expect(evs.some((e) => e.type === "permission.requested")).toBe(true);
    const res = evs.find((e) => e.type === "permission.resolved")!;
    expect((res.data as { decision: string }).decision).toBe("deny");
    expect((res.data as { by: string }).by).toBe("policy");
    const results = evs.filter((e) => e.type === "tool.result");
    const okResult = results.find(
      (e) => (e.data as { status: string }).status === "ok",
    );
    expect(okResult).toBeUndefined();
    store.close();
  }, 180_000);
});

describe("connectOpencode lifecycle", () => {
  test("stop() aborts the SSE fetch signal", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    let fetchSignal: AbortSignal | undefined;
    const fakeFetch = async (input: Request | URL | string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(
            enc.encode('data: {"type":"server.connected","properties":{}}\n\n'),
          );
          // stream stays open forever
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal!.aborted).toBe(false);
    conn.stop();
    expect(fetchSignal!.aborted).toBe(true);
    store.close();
  });

  test("connect timeout aborts the fetch and rejects", async () => {
    const { connectOpencode } = await import("../src/index");
    let fetchSignal: AbortSignal | undefined;
    const fakeFetch = async (input: Request | URL | string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      // stream that never emits anything
      const body = new ReadableStream<Uint8Array>({ start() {} });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const store = openStore(":memory:");
    await expect(
      connectOpencode({
        baseUrl: "http://fake",
        sink: store,
        fetch: fakeFetch as typeof fetch,
        connectTimeoutMs: 50,
      }),
    ).rejects.toThrow(/no events within/);
    expect(fetchSignal?.aborted).toBe(true);
    store.close();
  });
});
