import { describe, expect, test } from "bun:test";
import {
  OpencodeMapper,
  snapshotEvents,
  rebuildEvents,
  OPENCODE_MAPPER_VERSION,
} from "../src/index";
import type { Event } from "@opencode-ai/sdk/v2";
import { openStore } from "@agent-strata/store";
import { projectSession } from "@agent-strata/projector";
import { type AssistantStep } from "@agent-strata/schema";
import { sid, sessionCreated, msgUpdated, partUpdated, basicFixture } from "./helpers";

describe("OpencodeMapper", () => {
  test("each model call inside a message lands as a step, deduped by part id", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    const open = {
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20 }, providerID: "p", modelID: "m", agent: "build", mode: "build",
      path: { cwd: "/repo", root: "/repo" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    m.handle(msgUpdated(open));
    const step = {
      id: "ps1", sessionID: sid, messageID: "a1", type: "step-finish",
      reason: "tool-calls", cost: 0.1,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
    };
    m.handle(partUpdated(step));
    // The same step part delivered again is the same call, not a second one.
    m.handle(partUpdated({ ...step, id: "ps1" }));
    const out = m.handle(
      msgUpdated({ ...open, time: { created: 20, completed: 50 }, cost: 0.12, finish: "stop" }),
    );
    const ta = out.find((e) => e.type === "turn.assistant")!;
    const d = ta.data as { steps?: AssistantStep[] };
    expect(d.steps).toEqual([
      {
        reason: "tool-calls",
        usage: { input: 10, output: 5, reasoning: 2, cache_read: 1, cache_write: 0 },
        cost_usd: 0.1,
      },
    ]);
  });

  test("a step-finish part emits no turn events of its own", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    const out = m.handle(
      partUpdated({
        id: "ps9", sessionID: sid, messageID: "a1", type: "step-finish",
        reason: "stop", cost: 0.01,
        tokens: { input: 3, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    // Bookkeeping, not content: nothing for the transcript, nothing for the ledger.
    expect(out.filter((e) => e.type.startsWith("turn.") || e.type.startsWith("tool."))).toEqual([]);
  });

  test("a subtask part is the subagent session's opening message", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    const out = m.handle(
      partUpdated({
        id: "pt7", sessionID: sid, messageID: "u1", type: "subtask",
        prompt: "find the auth flow", description: "locate auth", agent: "explore",
      }),
    );
    const tu = out.find((e) => e.type === "turn.user")!;
    expect((tu.data as { content: unknown[] }).content).toEqual([
      { type: "subtask", prompt: "find the auth flow", description: "locate auth", agent: "explore" },
    ]);
  });


  test("a json_schema answer lands as structured on the finished message", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    const out = m.handle(
      msgUpdated({
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
        time: { created: 20, completed: 30 }, providerID: "p", modelID: "m", agent: "build",
        mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0.02, finish: "stop",
        tokens: { input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
        structured: { answer: 42 },
      }),
    );
    const ta = out.find((e) => e.type === "turn.assistant")!;
    expect((ta.data as { structured?: unknown }).structured).toEqual({ answer: 42 });
  });

  test("text keeps native clocks from partial snapshots through the final message", () => {
    const start = Date.parse("2026-10-22T10:00:00.000Z");
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: start } }));
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: start }, providerID: "p", modelID: "m",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    const partial = m.handle(partUpdated({
      id: "pt1", sessionID: sid, messageID: "a1", type: "text", text: "answer",
      time: { start: start + 1000, end: start + 2000 },
    }));
    expect(partial.find((e) => e.type === "turn.assistant")?.data).toMatchObject({
      partial: true,
      content: [{ type: "text", text: "answer", started_ms: start + 1000, ended_ms: start + 2000 }],
    });
    m.handle(partUpdated({
      id: "pt2", sessionID: sid, messageID: "a1", type: "text", text: "fixture clock",
      time: { start: 20, end: 30 },
    }));
    const final = m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: start, completed: start + 5000 }, providerID: "p", modelID: "m",
      cost: 0, finish: "stop",
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    expect(final.find((e) => e.type === "turn.assistant")?.data).toMatchObject({
      content: [
        { type: "text", text: "answer", started_ms: start + 1000, ended_ms: start + 2000 },
        { type: "text", text: "fixture clock" },
      ],
    });
  });

  test("basic turn with reasoning+text+tool", () => {
    const m = new OpencodeMapper();
    const out = basicFixture().flatMap((e) => m.handle(e));
    expect(out.map((e) => e.type)).toEqual([
      "session.started",
      "session.status", // busy — the user message is work evidence on its own
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
    const d = ta.data as { model: string; agent: string; variant: string; usage: { input: number; cache_read: number }; cost_usd: number; latency_ms: number; stop_reason: string; content: object[]; turn_id: string };
    expect(d.turn_id).toBe("u1");
    expect(d.model).toBe("anthropic/claude");
    expect(d.agent).toBe("build");
    expect(d.variant).toBe("high");
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

  test("a negative token count clamps to zero instead of failing schema", () => {
    const m = new OpencodeMapper();
    const out = [
      sessionCreated(),
      msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }),
      msgUpdated({
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
        time: { created: 20, completed: 50 }, providerID: "p", modelID: "m",
        agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" },
        cost: 0, finish: "stop",
        tokens: { input: 100, output: -7, reasoning: -1, cache: { read: -2, write: 0 } },
      }),
    ].flatMap((e) => m.handle(e));
    const ta = out.find((e) => e.type === "turn.assistant")!;
    const d = ta.data as { usage: { input: number; output: number; reasoning?: number; cache_read?: number } };
    expect(d.usage).toMatchObject({ input: 100, output: 0, reasoning: 0, cache_read: 0 });
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

  test("a finished assistant message ignores later part snapshots", async () => {
    const m = new OpencodeMapper();
    for (const e of basicFixture()) m.handle(e);
    await Bun.sleep(160);
    const again = m.handle(
      partUpdated({ id: "pt3", sessionID: sid, messageID: "a1", type: "text", text: "answer again" }),
    );
    expect(again.filter((e) => e.type === "turn.assistant")).toEqual([]);
  });


describe("a failed assistant message", () => {
  test("keeps the backend's error when the message has no parts", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const out = m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20, completed: 50 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: {
        name: "APIError",
        data: { message: "Model exo-free has been deprecated.", statusCode: 410, isRetryable: false },
      },
    }));
    expect(out.find((e) => e.type === "turn.assistant")!.data).toMatchObject({
      content: [],
      stop_reason: "error",
      error: "Model exo-free has been deprecated.",
    });
  });
});


describe("what the user sent", () => {
  const userTurn = (out: { type: string; data: unknown }[]) =>
    out.filter((e) => e.type === "turn.user").at(-1)?.data as { content: object[] } | undefined;

  test("the text OpenCode adds when it reads an attached file stays out of the user's words", () => {
    const m = new OpencodeMapper();
    const out = [
      m.handle(sessionCreated()),
      m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })),
      m.handle(partUpdated({ id: "t1", sessionID: sid, messageID: "u1", type: "text", text: "@a.ts explain" })),
      m.handle(partUpdated({ id: "t2", sessionID: sid, messageID: "u1", type: "text", synthetic: true, text: "Called the Read tool with the following input: {}" })),
      m.handle(partUpdated({ id: "t3", sessionID: sid, messageID: "u1", type: "text", synthetic: true, text: "<path>a.ts</path><content>secret</content>" })),
      m.handle(partUpdated({
        id: "f1", sessionID: sid, messageID: "u1", type: "file", mime: "text/plain", filename: "a.ts",
        url: "file:///repo/a.ts", source: { type: "file", path: "a.ts", text: { value: "@a.ts", start: 0, end: 5 } },
      })),
    ].flat();
    expect(userTurn(out)!.content).toEqual([
      { type: "text", text: "@a.ts explain" },
      { type: "file_ref", path: "a.ts" },
    ]);
  });

  test("an image the user attached is an image, not a file name", () => {
    const m = new OpencodeMapper();
    const url = "data:image/png;base64,iVBORw0KGgo=";
    const out = [
      m.handle(sessionCreated()),
      m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })),
      m.handle(partUpdated({ id: "t1", sessionID: sid, messageID: "u1", type: "text", text: "what colour" })),
      m.handle(partUpdated({ id: "f1", sessionID: sid, messageID: "u1", type: "file", mime: "image/png", filename: "red.png", url })),
      m.handle(partUpdated({ id: "f2", sessionID: sid, messageID: "u1", type: "file", mime: "image/png", filename: "r.png", url: "https://x/r.png" })),
      m.handle(partUpdated({ id: "f3", sessionID: sid, messageID: "u1", type: "file", mime: "application/pdf", filename: "spec.pdf", url: "data:application/pdf;base64,JVBERi0=" })),
      m.handle(partUpdated({ id: "f4", sessionID: sid, messageID: "u1", type: "file", mime: "image/svg+xml", url: "data:image/svg+xml;utf8,<svg/>" })),
      m.handle({ id: "i", type: "session.idle", properties: { sessionID: sid } } as unknown as Event),
    ].flat();
    expect(userTurn(out)!.content).toEqual([
      { type: "text", text: "what colour" },
      { type: "image", mime: "image/png", data: "iVBORw0KGgo=" },
      // the desktop only shows images from data: and blob: URLs
      //
      // Each carries its mime: an attachment has no workspace path, so without
      // it the transcript would show three bare names and a dropped PDF would
      // read exactly like a mentioned text file.
      { type: "file_ref", path: "r.png", mime: "image/png" },
      { type: "file_ref", path: "spec.pdf", mime: "application/pdf" },
      { type: "file_ref", path: "image/svg+xml", mime: "image/svg+xml" },
    ]);
  });

  test("text OpenCode marks ignored stays out too", () => {
    const m = new OpencodeMapper();
    const out = [
      m.handle(sessionCreated()),
      m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })),
      m.handle(partUpdated({ id: "t1", sessionID: sid, messageID: "u1", type: "text", text: "hi" })),
      m.handle(partUpdated({ id: "t2", sessionID: sid, messageID: "u1", type: "text", ignored: true, text: "skip me" })),
    ].flat();
    expect(userTurn(out)!.content).toEqual([{ type: "text", text: "hi" }]);
  });

  test("an image in an assistant message is an image in its reply", () => {
    const m = new OpencodeMapper();
    const assistant = (time: object) =>
      msgUpdated({
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1", time,
        providerID: "p", modelID: "m", cost: 0, finish: "stop",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      });
    const out = [
      m.handle(sessionCreated()),
      m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })),
      m.handle(partUpdated({ id: "t1", sessionID: sid, messageID: "u1", type: "text", text: "draw" })),
      m.handle(assistant({ created: 2 })),
      m.handle(partUpdated({ id: "f1", sessionID: sid, messageID: "a1", type: "file", mime: "image/png", url: "data:image/png;base64,AA==" })),
      m.handle(assistant({ created: 2, completed: 3 })),
    ].flat();
    const reply = out.filter((e) => e.type === "turn.assistant" && !(e.data as { partial?: boolean }).partial).at(-1)!;
    expect((reply.data as { content: object[] }).content).toEqual([{ type: "image", mime: "image/png", data: "AA==" }]);
  });

  test("a message with images is stored once, whole, live and after a restart", () => {
    const store = openStore(":memory:");
    const big = (c: string) => `data:image/png;base64,${c.repeat(4096)}`;
    const userInfo = { id: "u1", sessionID: sid, role: "user", time: { created: 10 } };
    const userParts = [
      { id: "t1", sessionID: sid, messageID: "u1", type: "text", text: "compare" },
      { id: "f1", sessionID: sid, messageID: "u1", type: "file", mime: "image/png", filename: "a.png", url: big("A") },
      { id: "f2", sessionID: sid, messageID: "u1", type: "file", mime: "image/png", filename: "b.png", url: big("B") },
    ];
    const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
    const assistantInfo = {
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20 }, providerID: "p", modelID: "m", cost: 0, tokens,
    };
    const withImages = (evs: { type: string; data: unknown }[]) =>
      evs.filter(
        (e) => e.type === "turn.user" && (e.data as { content: { type: string }[] }).content.some((b) => b.type === "image"),
      );

    const live = new OpencodeMapper();
    const liveOut = [
      sessionCreated(),
      msgUpdated(userInfo),
      ...userParts.map(partUpdated),
      msgUpdated(assistantInfo),
      { id: "i", type: "session.idle", properties: { sessionID: sid } } as unknown as Event,
    ].flatMap((e) => live.handle(e));
    const liveImages = withImages(liveOut);
    expect(liveImages).toHaveLength(1);
    expect(
      (liveImages[0]!.data as { content: { type: string }[] }).content.filter((b) => b.type === "image"),
    ).toHaveLength(2);
    store.append(liveOut);

    const restarted = new OpencodeMapper();
    const imported = snapshotEvents(sid, { id: sid, directory: "/repo", title: "T", time: { created: 1, updated: 2 } }, [
      { info: userInfo, parts: userParts },
      {
        info: { ...assistantInfo, time: { created: 20, completed: 30 }, finish: "stop" },
        parts: [{ id: "a1t", sessionID: sid, messageID: "a1", type: "text", text: "same" }],
      },
    ] as never).flatMap((e) => restarted.handle(e));
    store.append(imported);
    expect(withImages(store.read({ session_id: `opencode:${sid}` }))).toHaveLength(1);
    store.close();
  });

  test("a user message that is only OpenCode's own text leaves no bubble, and its reply still lands", () => {
    const store = openStore(":memory:");
    const m = new OpencodeMapper();
    const assistant = (time: object) =>
      msgUpdated({
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1", time,
        providerID: "p", modelID: "m", agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, finish: "stop",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      });
    const evs = [
      sessionCreated(),
      msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } }),
      partUpdated({ id: "t1", sessionID: sid, messageID: "u1", type: "text", synthetic: true, text: "Continue if you have next steps" }),
      assistant({ created: 2 }),
      partUpdated({ id: "t2", sessionID: sid, messageID: "a1", type: "text", text: "done", time: { start: 2, end: 3 } }),
      assistant({ created: 2, completed: 3 }),
      { id: "i", type: "session.idle", properties: { sessionID: sid } } as unknown as Event,
    ];
    for (const e of evs) {
      const out = m.handle(e);
      expect(out.filter((x) => x.type === "turn.user")).toEqual([]);
      if (out.length) store.append(out);
    }
    const view = projectSession(store.read({ session_id: `opencode:${sid}` }));
    expect(view.turns.some((t) => t.user && t.user.length > 0)).toBe(false);
    expect(JSON.stringify(view.turns)).toContain("done");
    store.close();
  });

  test("an imported or rebuilt session leaves out the same text and keeps the image", () => {
    const info = { id: sid, directory: "/repo", title: "T", time: { created: 1, updated: 2 } };
    const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
    const reply = (id: string, parentID: string) => ({
      info: {
        id, sessionID: sid, role: "assistant", parentID,
        time: { created: 20, completed: 30 }, providerID: "p", modelID: "m", cost: 0, tokens, finish: "stop",
      },
      parts: [{ id: `${id}t`, sessionID: sid, messageID: id, type: "text", text: "ok" }],
    });
    const evs = rebuildEvents(
      snapshotEvents(sid, info, [
        {
          info: { id: "u1", sessionID: sid, role: "user", time: { created: 10 } },
          parts: [
            { id: "t1", sessionID: sid, messageID: "u1", type: "text", text: "@a.ts and this" },
            { id: "t2", sessionID: sid, messageID: "u1", type: "text", synthetic: true, text: "Called the Read tool with the following input: {}" },
            { id: "t3", sessionID: sid, messageID: "u1", type: "text", synthetic: true, text: "<path>a.ts</path><content>secret</content>" },
            {
              id: "f1", sessionID: sid, messageID: "u1", type: "file", mime: "text/plain", filename: "a.ts",
              url: "file:///repo/a.ts", source: { type: "file", path: "a.ts", text: { value: "@a.ts", start: 0, end: 5 } },
            },
            { id: "f2", sessionID: sid, messageID: "u1", type: "file", mime: "image/png", filename: "red.png", url: "data:image/png;base64,iVBORw0KGgo=" },
          ],
        },
        reply("a1", "u1"),
        {
          info: { id: "u2", sessionID: sid, role: "user", time: { created: 40 } },
          parts: [{ id: "t4", sessionID: sid, messageID: "u2", type: "text", synthetic: true, text: "Continue if you have next steps" }],
        },
        reply("a2", "u2"),
      ] as never),
      "/repo",
    );
    const users = evs.filter((e) => e.type === "turn.user").map((e) => e.data as { turn_id: string; content: object[] });
    expect(users).toEqual([
      {
        turn_id: "u1",
        content: [
          { type: "text", text: "@a.ts and this" },
          { type: "file_ref", path: "a.ts" },
          { type: "image", mime: "image/png", data: "iVBORw0KGgo=" },
        ],
      },
    ]);
    expect(evs.filter((e) => e.type === "turn.assistant").map((e) => (e.data as { turn_id: string }).turn_id)).toEqual(["u1", "u2"]);
  });

  test("the mapping version moved, so stored sessions are rebuilt", () => {
    expect(OPENCODE_MAPPER_VERSION).toBe("opencode-16");
  });

  test("a reasoning part keeps the clock the backend reported", () => {
    const m = new OpencodeMapper();
    const start = Date.parse("2026-10-22T10:00:00.000Z");
    const end = start + 4200;
    const out = [
      sessionCreated(),
      msgUpdated({
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
        time: { created: start }, providerID: "p", modelID: "m", cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      partUpdated({
        id: "pr", sessionID: sid, messageID: "a1", type: "reasoning", text: "hmm",
        time: { start, end },
      }),
    ].flatMap((e) => m.handle(e));
    const snap = out.find((e) => e.type === "turn.assistant");
    const content = snap && (snap.data as { content: object[] }).content;
    expect(content).toEqual([{ type: "thinking", text: "hmm", started_ms: start, ended_ms: end }]);
  });
});

});
