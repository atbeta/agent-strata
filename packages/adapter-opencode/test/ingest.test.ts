import { describe, expect, test } from "bun:test";
import {
  OpencodeMapper,
  createIngestor,
  OPENCODE_MAPPER_VERSION,
} from "../src/index";
import { loadPolicy } from "@agent-strata/policy";
import type { Event } from "@opencode-ai/sdk/v2";
import { openStore } from "@agent-strata/store";
import { sid, sessionCreated, partUpdated, basicFixture, snapshotFixture, recordingSink } from "./helpers";

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

  test("a user's always allow is replied always", async () => {
    const replies: { requestID: string; reply: string }[] = [];
    const store = openStore(":memory:");
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: store,
      onAsk: async () => ({ decision: "allow", scope: "always" }),
      reply: async (requestID, reply) => {
        replies.push({ requestID, reply });
      },
    });
    ing.handle(sessionCreated());
    ing.handle(asked("bash", ["ls"], "permA"));
    await Bun.sleep(20);
    expect(replies).toEqual([{ requestID: "permA", reply: "always" }]);
    const resolved = store.read({ session_id: `opencode:${sid}` }).find((e) => e.type === "permission.resolved");
    expect(resolved?.data).toMatchObject({ decision: "allow", by: "user", scope: "always" });
    store.close();
  });

  test("a user's once allow, and a deny, are not replied always", async () => {
    const replies: string[] = [];
    const once = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append() {} },
      onAsk: async () => ({ decision: "allow" }),
      reply: async (_id, reply) => {
        replies.push(reply);
      },
    });
    once.handle(sessionCreated());
    once.handle(asked("bash", ["ls"], "permOnce"));
    const deny = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append() {} },
      onAsk: async () => ({ decision: "deny", scope: "always" }),
      reply: async (_id, reply) => {
        replies.push(reply);
      },
    });
    deny.handle(sessionCreated());
    deny.handle(asked("bash", ["rm x"], "permDeny"));
    await Bun.sleep(20);
    expect(replies).toEqual(["once", "reject"]);
  });

  test("a reply that already happened does not ask OpenCode again", async () => {
    const replies: string[] = [];
    let resolveAsk: ((ans: { decision: "allow" | "deny"; external?: boolean }) => void) | undefined;
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append() {} },
      onAsk: () =>
        new Promise((resolve) => {
          resolveAsk = resolve;
        }),
      onSettled: (_id, decision) => resolveAsk?.({ decision, external: true }),
      reply: async (_id, reply) => {
        replies.push(reply);
      },
    });
    ing.handle(sessionCreated());
    ing.handle(asked("bash", ["ls"], "perm1"));
    ing.handle({
      id: "pr",
      type: "permission.replied",
      properties: { sessionID: sid, requestID: "perm1", reply: "once" },
    } as unknown as Event);
    await Bun.sleep(20);
    expect(replies).toEqual([]);
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

  test("(b) reply throwing leaves stream usable and a replay can retry", async () => {
    const store = openStore(":memory:");
    let replies = 0;
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: store,
      policy: loadPolicy({ version: 1, rules: [{ id: "ok", effect: "allow", tool: "*" }] }),
      reply: async () => {
        replies++;
        if (replies === 1) throw new Error("network down");
      },
    });
    ing.handle(sessionCreated());
    ing.handle(asked("bash", ["ls"]));
    await Bun.sleep(50);
    ing.handle(partUpdated({ id: "pt", sessionID: sid, messageID: "u1", type: "text", text: "after" }));
    let evs = store.read({ session_id: `opencode:${sid}` });
    expect(evs.some((e) => e.type === "permission.resolved")).toBe(false);
    expect(evs.some((e) => e.type === "permission.requested")).toBe(true);

    ing.handle(asked("bash", ["ls"]));
    await Bun.sleep(50);
    evs = store.read({ session_id: `opencode:${sid}` });
    expect(replies).toBe(2);
    expect(evs.some((e) => e.type === "permission.resolved")).toBe(true);
    store.close();
  });

  test("an ask replayed while still pending does not prompt again", async () => {
    let asks = 0;
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append() {} },
      onAsk: () => {
        asks += 1;
        return new Promise(() => {}); // user still thinking
      },
      reply: async () => {},
    });
    ing.handle(sessionCreated());
    // the pending-permission list is re-polled every sync and replays the ask
    ing.handle(asked("bash", ["ls"], "perm1"));
    ing.handle(asked("bash", ["ls"], "perm1"));
    await Bun.sleep(20);
    expect(asks).toBe(1);
    // answered elsewhere: the inflight marker clears, and a later re-ask is new work
    ing.handle({
      id: "pr",
      type: "permission.replied",
      properties: { sessionID: sid, requestID: "perm1", reply: "once" },
    } as unknown as Event);
    ing.handle(asked("bash", ["ls"], "perm1"));
    await Bun.sleep(20);
    expect(asks).toBe(2);
  });

  test("question.replied settles the pending question without answering", async () => {
    const settled: string[] = [];
    const replied: string[] = [];
    let resolveQ: ((ans: { decision: "reply" | "reject"; external?: boolean }) => void) | undefined;
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append() {} },
      onQuestion: () =>
        new Promise((resolve) => {
          resolveQ = resolve;
        }),
      onQuestionSettled: (id) => {
        settled.push(id);
        resolveQ?.({ decision: "reply", external: true });
      },
      reply: async () => {},
      replyQuestion: async (id) => {
        replied.push(id);
      },
      rejectQuestion: async () => {},
    });
    ing.handle(sessionCreated());
    ing.handle({
      id: "qa1",
      type: "question.asked",
      properties: {
        id: "q1",
        sessionID: sid,
        questions: [
          { question: "proceed?", header: "?", options: [{ label: "yes", description: "" }] },
        ],
      },
    } as unknown as Event);
    ing.handle({
      id: "qr1",
      type: "question.replied",
      properties: { sessionID: sid, requestID: "q1", answers: [["yes"]] },
    } as unknown as Event);
    await Bun.sleep(20);
    expect(settled).toEqual(["q1"]);
    expect(replied).toEqual([]);
  });

  test("streaming snapshots go to publish, never to append", () => {
    const { appended, published, sink } = recordingSink();
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink,
      reply: async () => {},
    });
    for (const e of basicFixture()) ing.handle(e);
    expect(
      appended.some((e) => e.type === "turn.assistant" && (e.data as { partial?: boolean }).partial === true),
    ).toBe(false);
    expect(appended.some((e) => e.type === "turn.assistant")).toBe(true);
    expect(published.map((e) => e.type)).toEqual(["turn.assistant"]);
    expect(published[0]!.data).toMatchObject({ partial: true, msg_id: "a1" });
  });

  test("a session seen from its creation records the mapping that wrote it", () => {
    const marked: [string, string][] = [];
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append: () => {}, markMapped: (id, version) => marked.push([id, version]) },
      reply: async () => {},
    });
    ing.handle(sessionCreated());
    expect(marked).toEqual([[`opencode:${sid}`, OPENCODE_MAPPER_VERSION]]);
  });

  test("an imported session does not record a mapping on its own", () => {
    const marked: [string, string][] = [];
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append: () => {}, markMapped: (id, version) => marked.push([id, version]) },
      reply: async () => {},
    });
    for (const e of snapshotFixture()) ing.handle(e);
    expect(marked).toEqual([]);
  });
});
