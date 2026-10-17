import { describe, expect, test } from "bun:test";
import {
  normalizeOpencodeEvent,
  OpencodeMapper,
  createIngestor,
  snapshotEvents,
  rebuildEvents,
  OPENCODE_REBUILT_TYPES,
  OPENCODE_MAPPER_VERSION,
  STREAM_SNAPSHOT_MS,
  SETTLE_DELAY_MS,
  SETTLE_QUIET_MS,
  SETTLE_STALL_MS,
  pickableProviders,
} from "../src/index";
import { loadPolicy } from "@agent-strata/policy";
import type { Event } from "@opencode-ai/sdk/v2";
import { openStore } from "@agent-strata/store";
import { projectSession } from "@agent-strata/projector";
import { makeEvent, type EventInput } from "@agent-strata/schema";

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

// OpenCode's stored record of a session, as GET /session/:id and /session/:id/message return it
const snapshotFixture = (): Event[] => {
  const info = { id: sid, directory: "/repo", title: "T", time: { created: 1, updated: 2 } };
  const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
  const messages = [
    {
      info: { id: "u1", sessionID: sid, role: "user", time: { created: 10 } },
      parts: [{ id: "pt1", sessionID: sid, messageID: "u1", type: "text", text: "hello" }],
    },
    {
      info: {
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
        time: { created: 20, completed: 50 }, providerID: "p", modelID: "m", cost: 0.1, tokens, finish: "stop",
      },
      parts: [
        { id: "pt2", sessionID: sid, messageID: "a1", type: "text", text: "answer" },
        {
          id: "pt3", sessionID: sid, messageID: "a1", type: "tool", callID: "call1", tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "files", title: "ls", metadata: {}, time: { start: 21, end: 31 } },
        },
      ],
    },
    {
      info: {
        id: "a2", sessionID: sid, role: "assistant", parentID: "u1",
        time: { created: 60 }, providerID: "p", modelID: "m", cost: 0, tokens,
      },
      parts: [{ id: "pt4", sessionID: sid, messageID: "a2", type: "text", text: "still writ" }],
    },
  ];
  return snapshotEvents(sid, info, messages as never);
};

describe("OpencodeMapper", () => {
  test("session and message clocks come from OpenCode, not ingest time", () => {
    const created = Date.parse("2026-10-01T08:00:00.000Z");
    const updated = Date.parse("2026-10-03T11:30:00.000Z");
    const m = new OpencodeMapper();
    const started = m.handle({
      id: "e1",
      type: "session.created",
      properties: {
        sessionID: sid,
        info: { id: sid, directory: "/repo", title: "T", time: { created, updated } },
      },
    } as unknown as Event);
    expect(started[0]!.ts).toBe(new Date(updated).toISOString());
    const done = Date.parse("2026-10-03T11:29:00.000Z");
    const assistant = m.handle(
      msgUpdated({
        id: "a1",
        sessionID: sid,
        role: "assistant",
        parentID: "u1",
        time: { created: done - 1000, completed: done },
        providerID: "deepseek",
        modelID: "deepseek-v4-pro",
        agent: "build",
        mode: "build",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        finish: "stop",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    const turn = assistant.find((e) => e.type === "turn.assistant");
    expect(turn?.ts).toBe(new Date(done).toISOString());
  });

  test("a global event with data instead of properties still updates the title", () => {
    const evt = normalizeOpencodeEvent({
      directory: "/repo",
      payload: {
        id: "g1",
        type: "session.updated",
        data: {
          sessionID: sid,
          info: {
            id: sid,
            directory: "/repo",
            title: "Renamed",
            time: { created: 1, updated: 2 },
          },
        },
      },
    });
    expect(evt?.type).toBe("session.updated");
    const out = new OpencodeMapper().handle(evt!);
    expect(out.find((e) => e.type === "session.updated")?.data).toMatchObject({
      title: "Renamed",
      workspace: "/repo",
    });
  });

  test("session.updated emits only when title, directory, or archive changes", () => {
    const m = new OpencodeMapper();
    const created = Date.parse("2026-10-01T08:00:00.000Z");
    const renamedAt = Date.parse("2026-10-04T09:00:00.000Z");
    const archivedAt = Date.parse("2026-10-05T09:00:00.000Z");
    m.handle({
      id: "e1",
      type: "session.created",
      properties: {
        sessionID: sid,
        info: { id: sid, directory: "/repo", title: "T", time: { created, updated: created } },
      },
    } as unknown as Event);
    const costOnly = m.handle({
      id: "e2",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "T",
          time: { created, updated: renamedAt - 1000 },
        },
      },
    } as unknown as Event);
    expect(costOnly.filter((e) => e.type === "session.updated")).toEqual([]);
    const renamed = m.handle({
      id: "e3",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "Renamed",
          time: { created, updated: renamedAt },
        },
      },
    } as unknown as Event);
    const meta = renamed.find((e) => e.type === "session.updated");
    expect(meta?.data).toMatchObject({ title: "Renamed", workspace: "/repo", archived: false });
    expect(meta?.ts).toBe(new Date(renamedAt).toISOString());
    const archived = m.handle({
      id: "e4",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "Renamed",
          time: { created, updated: archivedAt, archived: archivedAt },
        },
      },
    } as unknown as Event);
    expect(archived.find((e) => e.type === "session.updated")?.data).toMatchObject({ archived: true });
    const deleted = m.handle({
      id: "e5",
      type: "session.deleted",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "Renamed",
          time: { created, updated: archivedAt },
        },
      },
    } as unknown as Event);
    expect(deleted.some((e) => e.type === "session.deleted")).toBe(true);
  });

  test("an archived session.created is hidden without waiting for a later update", () => {
    const m = new OpencodeMapper();
    const archived = Date.parse("2026-10-02T00:00:00.000Z");
    const out = m.handle({
      id: "e1",
      type: "session.created",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "Old",
          time: { created: archived, updated: archived, archived },
        },
      },
    } as unknown as Event);
    expect(out.map((e) => e.type)).toEqual(["session.started", "session.updated"]);
    expect(out[1]?.data).toMatchObject({ archived: true, title: "Old" });
  });

  test("session.updated records a revert point and clears it", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const set = m.handle({
      id: "e2",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "T",
          time: { created: 1, updated: 2 },
          revert: { messageID: "u1" },
        },
      },
    } as unknown as Event);
    expect(set.find((e) => e.type === "session.updated")?.data).toMatchObject({
      revert: { turn_id: "u1" },
    });
    const cleared = m.handle({
      id: "e3",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "T",
          time: { created: 1, updated: 3 },
        },
      },
    } as unknown as Event);
    expect(cleared.find((e) => e.type === "session.updated")?.data).toMatchObject({
      revert: null,
    });
    const later = m.handle({
      id: "e4",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "Renamed",
          time: { created: 1, updated: 4 },
        },
      },
    } as unknown as Event);
    expect(later.find((e) => e.type === "session.updated")?.data).not.toHaveProperty("revert");
  });

  test("a revert clear does not reuse the never-reverted event id", () => {
    const m = new OpencodeMapper();
    const updated = (revert?: { messageID: string }): Event =>
      ({
        id: "e",
        type: "session.updated",
        properties: {
          sessionID: sid,
          info: {
            id: sid,
            directory: "/repo",
            title: "T",
            time: { created: 1, updated: 2 },
            ...(revert ? { revert } : {}),
          },
        },
      }) as unknown as Event;
    const first = m.handle(updated()).find((e) => e.type === "session.updated");
    m.handle(updated({ messageID: "u1" }));
    const third = m.handle(updated()).find((e) => e.type === "session.updated");
    expect(third?.data).toMatchObject({ revert: null });
    expect(third?.id).not.toBe(first?.id);
  });

  test("session.created that already has a revert records it", () => {
    const m = new OpencodeMapper();
    const out = m.handle({
      id: "e1",
      type: "session.created",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "T",
          time: { created: 1, updated: 1 },
          revert: { messageID: "u1" },
        },
      },
    } as unknown as Event);
    expect(out.find((e) => e.type === "session.updated")?.data).toMatchObject({
      revert: { turn_id: "u1" },
    });
  });

  test("a compaction part emits one session.compacted", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const part = { id: "pc1", sessionID: sid, messageID: "a1", type: "compaction", auto: true };
    const first = m.handle(partUpdated(part));
    const evs = first.filter((e) => e.type === "session.compacted");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.id).toBe("opencode:pc1:compaction");
    expect(evs[0]!.data).toEqual({ message_id: "a1", auto: true });
    const second = m.handle(partUpdated(part));
    expect(second.filter((e) => e.type === "session.compacted")).toEqual([]);
    expect(OPENCODE_REBUILT_TYPES).toContain("session.compacted");
  });

  test("a compaction part is stamped by the message that asked for it", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const created = Date.parse("2026-05-12T09:00:00.000Z");
    m.handle(
      msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created } }),
    );
    const part = { id: "pc2", sessionID: sid, messageID: "u1", type: "compaction", auto: true };
    const evs = m.handle(partUpdated(part)).filter((e) => e.type === "session.compacted");
    // No ingest clock — connecting today must not pull the session to the top.
    expect(evs[0]!.ts).toBe(new Date(created).toISOString());
  });

  test("a compaction part ahead of its message takes the session clock", () => {
    const m = new OpencodeMapper();
    const updated = Date.parse("2026-09-20T08:00:00.000Z");
    const info = {
      id: sid,
      directory: "/repo",
      title: "Snapshot",
      time: { created: 1, updated },
    };
    const messages = [
      {
        info: { id: "u1", sessionID: sid, role: "user", time: { created: 10 } },
        parts: [
          { id: "pt1", sessionID: sid, messageID: "u1", type: "text", text: "hi" },
          { id: "pc9", sessionID: sid, messageID: "u1", type: "compaction", auto: true },
        ],
      },
    ];
    const out = snapshotEvents(sid, info as never, messages as never).flatMap((e) =>
      m.handle(e),
    );
    const ev = out.find((e) => e.type === "session.compacted");
    // Parts replay before their message on import — the session's own updated
    // clock is the fallback, still never the ingest moment.
    expect(ev?.ts).toBe(new Date(updated).toISOString());
  });

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

  test("a finished turn says idle when the backend never did", () => {
    // The case that left a dead session breathing in every list. Measured on a
    // real one: a turn that finished after a permission was granted ended on
    // `permission.replied` and `session.updated`, with no `session.idle` behind
    // it. `busy` is only ever cleared by an incoming idle, so it stayed true
    // forever — a running dot on a conversation that ended hours ago, with
    // nothing able to tell it apart from a live one.
    const m = new OpencodeMapper();
    m.handle({
      id: "s1", type: "session.status", properties: { sessionID: sid, status: { type: "busy" } },
    } as unknown as Event);

    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20, completed: 50 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0.25, finish: "stop",
      tokens: { input: 100, output: 40, reasoning: 5, cache: { read: 3, write: 2 } },
    }));
    const settled = m.flushSettles();
    expect(settled.find((e) => e.type === "session.status")!.data).toEqual({ state: "idle" });
  });

  test("a turn still running is not cut short by the fallback", () => {
    // Two assistant messages in one turn. The second is created *after* the
    // first has completed, so claiming idleness at the first completion lands
    // in the gap between two halves of the same run — the projector clears
    // `busy` while the session is still working, which is worse than leaving it
    // set, because the run goes on with nothing marking it.
    const m = new OpencodeMapper();
    m.handle({
      id: "s1", type: "session.status", properties: { sessionID: sid, status: { type: "busy" } },
    } as unknown as Event);

    const assistant = (id: string, time: object) =>
      msgUpdated({
        id, sessionID: sid, role: "assistant", parentID: "u1",
        time, providerID: "anthropic", modelID: "claude",
        agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, finish: "stop",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });

    m.handle(assistant("a1", { created: 20, completed: 30 }));
    // The window passes with nothing following it.
    expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(true);

    // A second half arriving after an idle is too late to un-say it, so the
    // order that matters is the real one: the second message is already open
    // when the first completes.
    const m2 = new OpencodeMapper();
    m2.handle({
      id: "s1", type: "session.status", properties: { sessionID: sid, status: { type: "busy" } },
    } as unknown as Event);
    m2.handle(assistant("a2", { created: 31 }));
    m2.handle(assistant("a1", { created: 20, completed: 30 }));
    expect(m2.flushSettles().some((e) => e.type === "session.status")).toBe(false);
  });

  test("the fallback stays quiet for a session that was never busy", () => {
    // Idempotence, and the guard against announcing idleness nobody asked for.
    const m = new OpencodeMapper();
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20, completed: 50 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, finish: "stop",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(false);
  });

  test("an idle that arrived on its own is not followed by a second one", () => {
    const m = new OpencodeMapper();
    m.handle({
      id: "s1", type: "session.status", properties: { sessionID: sid, status: { type: "busy" } },
    } as unknown as Event);
    m.handle({
      id: "s2", type: "session.idle", properties: { sessionID: sid },
    } as unknown as Event);
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20, completed: 50 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, finish: "stop",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(false);
  });

  test("a message stuck open past the quiet window says idle anyway", () => {
    // The case that kept a real session breathing for three hours: the turn's
    // last message ran a tool that sat awaiting a permission the reader never
    // saw. The message never completed, so the completed-message settle never
    // queued, and the guard turned the fallback off for as long as the message
    // stayed open. Past the quiet window with no running tool, the message is
    // a stall, not a pause.
    let now = 1_000_000;
    const m = new OpencodeMapper({ now: () => now });
    m.handle({
      id: "s1", type: "session.status", properties: { sessionID: sid, status: { type: "busy" } },
    } as unknown as Event);
    // the second half is already open when the first completes, so the
    // completion queues a settle the open message blocks
    m.handle(msgUpdated({
      id: "a2", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 31 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20, completed: 30 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, finish: "stop",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(false);
    now += SETTLE_QUIET_MS + 1;
    const settled = m.flushSettles();
    expect(settled.find((e) => e.type === "session.status")!.data).toEqual({ state: "idle" });
  });

  test("the idle fallback does not leave a live snapshot behind", () => {
    // The stream flush runs on its own timer. Announcing idle while the open
    // message stayed held published one more partial afterwards, and the
    // composer read that partial as a run that abort could not end.
    let now = 1_000;
    const m = new OpencodeMapper({ now: () => now });
    m.handle({
      id: "s1", type: "session.status", properties: { sessionID: sid, status: { type: "busy" } },
    } as unknown as Event);
    m.handle(msgUpdated({
      id: "a2", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 31 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    now = 1_000;
    m.handle(partUpdated({
      id: "pt", sessionID: sid, messageID: "a2", type: "text", text: "still",
    }));
    // Inside the snapshot window, so the message stays held instead of flushing.
    now = 1_020;
    m.handle(partUpdated({
      id: "pt", sessionID: sid, messageID: "a2", type: "text", text: "still open",
    }));
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20, completed: 30 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, finish: "stop",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    now += SETTLE_QUIET_MS + 1;
    expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(true);
    now += STREAM_SNAPSHOT_MS;
    expect(m.flushStreaming()).toEqual([]);
  });

  test("a running tool keeps the quiet window from speaking", () => {
    // A long tool call is quiet for minutes while it works; the session is
    // genuinely running and must not read as idle.
    let now = 1_000_000;
    const m = new OpencodeMapper({ now: () => now });
    m.handle({
      id: "s1", type: "session.status", properties: { sessionID: sid, status: { type: "busy" } },
    } as unknown as Event);
    m.handle(msgUpdated({
      id: "a2", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 31 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    m.handle(partUpdated({
      id: "pt2", sessionID: sid, messageID: "a2", type: "tool", callID: "c1", tool: "bash",
      state: { status: "running", input: { command: "sleep 300" }, time: { start: 32 } },
    }));
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20, completed: 30 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, finish: "stop",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    now += SETTLE_QUIET_MS + 1;
    expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(false);
  });

  test("settleTimerMs asks for the short beat while a completion waits, and the rest of the window while stalled", () => {
    let now = 1_000_000;
    const m = new OpencodeMapper({ now: () => now });
    expect(m.settleTimerMs()).toBeUndefined();
    m.handle({
      id: "s1", type: "session.status", properties: { sessionID: sid, status: { type: "busy" } },
    } as unknown as Event);
    m.handle(msgUpdated({
      id: "a2", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 31 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20, completed: 30 }, providerID: "anthropic", modelID: "claude",
      agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, finish: "stop",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    // stalled: the open message just went quiet, so the whole window remains
    expect(m.settleTimerMs()).toBe(SETTLE_QUIET_MS);
    now += SETTLE_QUIET_MS - 500;
    expect(m.settleTimerMs()).toBe(500);
    // past the window with nothing running, the flush speaks and the timer ends
    now += 500;
    expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(true);
    expect(m.settleTimerMs()).toBeUndefined();
  });

  describe("a correction that can still arrive when nothing else does", () => {
    const busy = (m: OpencodeMapper) =>
      m.handle({
        id: "s1", type: "session.status", properties: { sessionID: sid, status: { type: "busy" } },
      } as unknown as Event);

    const assistant = (id: string, time: object) =>
      msgUpdated({
        id, sessionID: sid, role: "assistant", parentID: "u1",
        time, providerID: "anthropic", modelID: "claude",
        agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0, finish: "stop",
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });

    const runningTool = (callID: string, tool: string, command: string, start: number) =>
      partUpdated({
        id: callID, sessionID: sid, messageID: "a1", type: "tool", callID, tool,
        state: { status: "running", input: { command }, time: { start } },
      });

    test("a run that ends without a message completing still gets corrected", () => {
      // The abort case. The reader stops a run, the backend drops it, and no
      // message ever reports completion — so nothing queued a settle,
      // `settleTimerMs()` answered undefined, and no timer was ever armed.
      // `busy` then survived for the life of the session and every composer
      // kept queueing messages sent to a conversation nobody was in.
      let now = 1_000_000;
      const m = new OpencodeMapper({ now: () => now });
      busy(m);
      m.handle(assistant("a1", { created: 20 }));
      m.handle(runningTool("c1", "bash", "sleep 300", 21));

      // A claim alone is a run that may be starting, and the tool is running:
      // the correction is held to the tool's own ceiling, and the timer names
      // it. What matters is that a timer exists at all.
      expect(m.settleTimerMs()).toBe(SETTLE_STALL_MS);
      now += SETTLE_QUIET_MS + 1;
      // The tool is still reported running, so it has not been given up on yet
      // — but a timer is armed for the rest of its ceiling, which is the part
      // that used to be missing.
      expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(false);
      expect(m.settleTimerMs()).toBe(SETTLE_STALL_MS - SETTLE_QUIET_MS - 1);
      // Past the ceiling on a session that has said nothing at all, the tool is
      // a dropped run and the correction arrives on its own.
      now += SETTLE_STALL_MS - SETTLE_QUIET_MS - 1;
      expect(m.flushSettles().find((e) => e.type === "session.status")!.data).toEqual({ state: "idle" });
    });

    test("a running tool delays the correction, it does not cancel it", () => {
      // A long tool is quiet while it works and the session really is running,
      // so it has to hold the correction back. What it must not do is hold it
      // forever: the old code asked for *no timer at all* once the quiet window
      // passed with a tool still running, on the reasoning that becoming ready
      // needs a new event. A dropped run produces no new event, so that is
      // precisely the case the guard was written for.
      let now = 1_000_000;
      const m = new OpencodeMapper({ now: () => now });
      busy(m);
      m.handle(assistant("a1", { created: 20 }));
      m.handle(assistant("a2", { created: 31 }));
      m.handle(runningTool("c1", "bash", "sleep 300", 32));
      // a1 completing after a2 is what must not announce idleness mid-run.
      m.handle(assistant("a1", { created: 20, completed: 30 }));

      now += SETTLE_QUIET_MS - 500;
      // Not ready — the tool owns the answer until its own ceiling — but the
      // timer names the moment it could speak rather than giving up on it.
      expect(m.settleTimerMs()).toBe(SETTLE_STALL_MS - SETTLE_QUIET_MS + 500);
      expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(false);

      now += SETTLE_STALL_MS - SETTLE_QUIET_MS + 500;
      expect(m.flushSettles().find((e) => e.type === "session.status")!.data).toEqual({ state: "idle" });
    });

    test("a completed message with a tool still running is not idle", () => {
      // The mirror of the case above, and it went the other way. Every
      // assistant message reported completion, so the old shortcut returned
      // ready before it ever looked at tool parts — a turn whose last event was
      // a tool that had not reported back was announced idle 250ms in, while it
      // was still working.
      let now = 1_000_000;
      const m = new OpencodeMapper({ now: () => now });
      busy(m);
      m.handle(assistant("a1", { created: 20 }));
      m.handle(runningTool("c1", "bash", "sleep 300", 21));
      m.handle(assistant("a1", { created: 20, completed: 30 }));

      now += SETTLE_DELAY_MS + 1;
      expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(false);
      // Once the tool lands, the turn really is over and the correction speaks.
      m.handle(partUpdated({
        id: "c1", sessionID: sid, messageID: "a1", type: "tool", callID: "c1", tool: "bash",
        state: { status: "completed", input: { command: "sleep 300" }, output: "ok", metadata: {}, time: { start: 21, end: 40 } },
      }));
      expect(m.flushSettles().some((e) => e.type === "session.status")).toBe(true);
    });
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

  test("a finished assistant message ignores later part snapshots", async () => {
    const m = new OpencodeMapper();
    for (const e of basicFixture()) m.handle(e);
    await Bun.sleep(160);
    const again = m.handle(
      partUpdated({ id: "pt3", sessionID: sid, messageID: "a1", type: "text", text: "answer again" }),
    );
    expect(again.filter((e) => e.type === "turn.assistant")).toEqual([]);
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

  test("a file change is stamped when it happened, not when we connected", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 1_700_000_000_000, completed: 1_700_000_060_000 },
      providerID: "anthropic", modelID: "claude", agent: "build", mode: "build",
      path: { cwd: "/repo", root: "/repo" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    const fc = m.handle(partUpdated({
      id: "pp", sessionID: sid, messageID: "a1", type: "patch", hash: "h", files: ["x.ts"],
    }));
    // Without a source clock the store takes the ingest clock, so replaying a
    // session on every connect moved every file change to the connect moment
    // and the session list sorted by that.
    expect(fc[0]!.ts).toBe("2023-11-14T22:14:20.000Z");
  });

  test("a patch with no message time keeps the ingest clock rather than inventing one", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const fc = m.handle(partUpdated({
      id: "pp", sessionID: sid, messageID: "never-seen", type: "patch", hash: "h", files: ["x.ts"],
    }));
    expect(fc[0]!.ts).toBeTruthy();
    expect(Number.isNaN(Date.parse(fc[0]!.ts as string))).toBe(false);
    // and it must not be a made-up epoch either
    expect(Date.parse(fc[0]!.ts as string)).toBeGreaterThan(1_700_000_000_000);
  });

  test("a session met through a message re-stamps its start once the real time arrives", () => {
    const store = openStore(":memory:");
    const m = new OpencodeMapper({ directory: "/repo" });
    // first sight is a message, so there is nothing yet to put on the clock
    store.append(m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } })));
    const blind = store.read({ session_id: `opencode:${sid}` }).find((e) => e.type === "session.started")!;
    const blindTs = blind.ts;

    // the session event carries the backend's own clock
    store.append(
      m.handle({
        id: "sc", type: "session.created",
        properties: {
          sessionID: sid,
          info: {
            id: sid, directory: "/repo", title: "T",
            time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
          },
        },
      } as unknown as Event),
    );

    const after = store.read({ session_id: `opencode:${sid}` }).filter((e) => e.type === "session.started");
    // same event, corrected in place — not a second row
    expect(after).toHaveLength(1);
    expect(after[0]!.ts).not.toBe(blindTs);
    expect(after[0]!.ts).toBe(new Date(1_700_000_060_000).toISOString());
    store.close();
  });

  test("lazy session.started is corrected when the real session.created arrives", () => {
    const store = openStore(":memory:");
    const m = new OpencodeMapper({ directory: "/lazy" });
    store.append(m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })));
    const created = sessionCreated();
    const props = created.properties as { info: { parentID?: string } };
    props.info.parentID = "ses_parent";
    store.append(m.handle(created));
    const evs = store.read({ session_id: `opencode:${sid}` });
    expect(evs.filter((e) => e.type === "session.started").length).toBe(1);
    expect((evs[0]!.data as { workspace: string }).workspace).toBe("/lazy");
    const view = projectSession(evs);
    expect(view.workspace).toBe("/repo");
    expect(view.title).toBe("T");
    expect(view.parent_session_id).toBe("opencode:ses_parent");
    const row = store.listSessions().find((s) => s.session_id === `opencode:${sid}`);
    expect(row?.workspace).toBe("/repo");
    expect(row?.title).toBe("T");
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
    const appended: EventInput[] = [];
    const published: EventInput[] = [];
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: {
        append: (e) => appended.push(...e),
        publish: (e) => published.push(...e),
      },
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

  test("a request that stays quiet for minutes is not cut by Bun's idle timeout", async () => {
    const { connectOpencode } = await import("../src/index");
    let fetchInit: RequestInit | undefined;
    const fakeFetch = async (_input: Request | URL | string, init?: RequestInit) => {
      fetchInit = init;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    expect((fetchInit as { timeout?: unknown } | undefined)?.timeout).toBe(false);
    conn.stop();
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

  test("a quiet server spends the connect timeout once", async () => {
    const { connectOpencode } = await import("../src/index");
    const fakeFetch = async (_input: Request | URL | string, _init?: RequestInit) =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const store = openStore(":memory:");
    const started = Date.now();
    await expect(
      connectOpencode({
        baseUrl: "http://fake",
        sink: store,
        fetch: fakeFetch as typeof fetch,
        connectTimeoutMs: 300,
      }),
    ).rejects.toThrow(/no events within/);
    expect(Date.now() - started).toBeLessThan(500);
    store.close();
  });

  test("a closed event stream is opened again", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    let eventOpens = 0;
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/global/event") || url.endsWith("/event")) {
        eventOpens += 1;
        const stay = eventOpens > 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
              if (!stay) ctrl.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json([]);
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    const deadline = Date.now() + 4_000;
    while (eventOpens < 2 && Date.now() < deadline) await Bun.sleep(50);
    expect(eventOpens).toBeGreaterThanOrEqual(2);
    conn.stop();
    store.close();
  });

  test("a prompt OpenCode rejects does not repeat the text", async () => {
    const { connectOpencode } = await import("../src/index");
    const secret = "secret-prompt-value-xx";
    const enc = new TextEncoder();
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/global/event") || url.endsWith("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.includes("prompt_async")) return Response.json({ message: `rejected ${secret}` }, { status: 400 });
      return Response.json([]);
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    const failed = conn.prompt("ses", [{ type: "text", text: secret }]);
    await expect(failed).rejects.toThrow("prompt was not accepted");
    await expect(failed.catch((err: Error) => err.message)).resolves.not.toContain(secret);
    conn.stop();
    store.close();
  });

  test("a prompt that is never accepted fails and keeps the text out", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      const signal = input instanceof Request ? input.signal : undefined;
      if (url.includes("/global/event") || url.endsWith("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.includes("prompt_async")) {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        });
      }
      return Response.json([]);
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
      promptAcceptMs: 80,
    });
    const started = Date.now();
    await expect(conn.prompt("ses", [{ type: "text", text: "hello from the composer" }])).rejects.toThrow(
      "prompt was not accepted",
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    conn.stop();
    store.close();
  });
});

describe("rebuild from OpenCode's own record", () => {
  test("a rebuild maps only rebuildable, durable events", () => {
    const evs = rebuildEvents(snapshotFixture(), "/repo");
    expect(evs.every((e) => OPENCODE_REBUILT_TYPES.includes(e.type))).toBe(true);
    expect(evs.some((e) => e.type === "turn.assistant" && (e.data as { partial?: boolean }).partial)).toBe(false);
    expect(evs.map((e): string => e.type).sort()).toEqual(
      ["session.started", "tool.call", "tool.result", "turn.assistant", "turn.user"].sort(),
    );
  });

  test("a rebuild replaces the transcript and keeps what only the live stream saw", () => {
    const store = openStore(":memory:");
    const casfId = `opencode:${sid}`;
    store.append([
      makeEvent({
        id: "opencode:pt3:tool.call",
        session_id: casfId,
        source: { backend: "opencode" },
        type: "tool.call",
        data: { turn_id: "a1", call_id: "call1", tool: "bash", input: {} },
      } as EventInput),
      makeEvent({
        id: "opencode:perm1:permission.requested",
        session_id: casfId,
        source: { backend: "opencode" },
        type: "permission.requested",
        data: { request_id: "perm1", call_id: "call1", tool: "bash", input: {} },
      } as EventInput),
    ]);
    store.replaceSession(casfId, rebuildEvents(snapshotFixture(), "/repo"), {
      replaceTypes: OPENCODE_REBUILT_TYPES,
      mapper: OPENCODE_MAPPER_VERSION,
    });
    const evs = store.read({ session_id: casfId });
    expect(evs.filter((e) => e.type === "tool.call")).toHaveLength(1);
    expect(evs.find((e) => e.type === "tool.call")!.data).toMatchObject({ input: { command: "ls" } });
    expect(evs.some((e) => e.type === "permission.requested")).toBe(true);
    expect(store.sessionMapper(casfId)).toBe(OPENCODE_MAPPER_VERSION);
    store.close();
  });

  test("a stored session puts its calls in the user's turn", () => {
    const evs = rebuildEvents(snapshotFixture(), "/repo");
    expect(evs.map((e) => e.type)).toEqual([
      "session.started",
      "turn.user",
      "tool.call",
      "tool.result",
      "turn.assistant",
    ]);
    expect(evs.find((e) => e.type === "tool.call")!.data).toMatchObject({ turn_id: "u1", msg_id: "a1" });
  });
});

describe("file changes come from the call that made them", () => {
  const assistant = () =>
    msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  const patch = "Index: D:\\r\\x.ts\n===\n--- D:\\r\\x.ts\n+++ D:\\r\\x.ts\n@@ -1 +1 @@\n-a\n+b\n";

  test("an edit records OpenCode's own diff, and the patch part does not repeat it", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(assistant());
    const out = [
      m.handle(partUpdated({
        id: "pe", sessionID: sid, messageID: "a1", type: "tool", callID: "c-edit", tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "D:\\r\\x.ts", oldString: "a", newString: "b" },
          output: "", title: "",
          metadata: { diff: patch, filediff: { file: "D:\\r\\x.ts", patch, additions: 1, deletions: 1 } },
          time: { start: 1, end: 2 },
        },
      })),
      m.handle(partUpdated({
        id: "pp", sessionID: sid, messageID: "a1", type: "patch", hash: "h", files: ["D:/r/x.ts", "D:/r/y.ts"],
      })),
    ].flat();
    const changes = out.filter((e) => e.type === "file.changed");
    expect(changes.map((e) => e.data)).toEqual([
      { path: "D:\\r\\x.ts", change: "modify", diff: patch, call_id: "c-edit" },
      { path: "D:/r/y.ts", change: "modify" },
    ]);
    expect(changes[0]!.id).toBe("opencode:pe:file");
  });

  test("a write records the whole file and says whether it is new", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(assistant());
    const out = m.handle(partUpdated({
      id: "pw", sessionID: sid, messageID: "a1", type: "tool", callID: "c-write", tool: "write",
      state: {
        status: "completed", input: { filePath: "/r/new.ts", content: "a\nb\n" }, output: "", title: "",
        metadata: { filepath: "/r/new.ts", exists: false }, time: { start: 1, end: 2 },
      },
    }));
    const change = out.find((e) => e.type === "file.changed")!;
    expect(change.data).toMatchObject({ path: "/r/new.ts", change: "add", whole_file: true, call_id: "c-write" });
    expect((change.data as { diff: string }).diff).toContain("+a");
  });

  test("a failed edit records no change", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(assistant());
    const out = m.handle(partUpdated({
      id: "pf", sessionID: sid, messageID: "a1", type: "tool", callID: "c-fail", tool: "edit",
      state: {
        status: "error", input: { filePath: "/r/x.ts", oldString: "a", newString: "b" },
        error: "oldString not found", time: { start: 1, end: 2 },
      },
    }));
    expect(out.some((e) => e.type === "file.changed")).toBe(false);
  });
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

describe("text that arrives as deltas", () => {
  const streaming = (now: () => number) => {
    const m = new OpencodeMapper({ now });
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } }));
    m.handle(partUpdated({ id: "pu", sessionID: sid, messageID: "u1", type: "text", text: "hi" }));
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2 }, providerID: "p", modelID: "m",
    }));
    return m;
  };
  const delta = (partID: string, text: string, field = "text"): Event =>
    ({
      id: `d-${partID}-${text}`,
      type: "message.part.delta",
      properties: { sessionID: sid, messageID: "a1", partID, field, delta: text },
    }) as unknown as Event;
  const snaps = (evs: { type: string; data: unknown }[]) =>
    evs
      .filter((e) => e.type === "turn.assistant")
      .map((e) => e.data as { partial?: boolean; content: { type: string; text?: string }[] });

  test("the window is 50ms", () => {
    expect(STREAM_SNAPSHOT_MS).toBe(50);
  });

  test("each delta extends the text part it names", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1100;
    const first = snaps(m.handle(delta("pa", "Hel")));
    t = 1200;
    const second = snaps(m.handle(delta("pa", "lo")));
    expect(first[0]).toMatchObject({ partial: true, content: [{ type: "text", text: "Hel" }] });
    expect(second[0]!.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  test("reasoning deltas extend the thinking block", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pr", sessionID: sid, messageID: "a1", type: "reasoning", text: "" }));
    t = 1100;
    const out = snaps(m.handle(delta("pr", "mull")));
    expect(out[0]!.content).toEqual([{ type: "thinking", text: "mull" }]);
  });

  test("deltas inside the window are kept for the next frame", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1010;
    expect(snaps(m.handle(delta("pa", "a")))).toHaveLength(0);
    t = 1020;
    expect(snaps(m.handle(delta("pa", "b")))).toHaveLength(0);
    t = 1060;
    expect(snaps(m.handle(delta("pa", "c")))[0]!.content).toEqual([{ type: "text", text: "abc" }]);
  });

  test("a delta for a part never seen waits for that part's full update", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    expect(m.handle(delta("ghost", "x"))).toEqual([]);
    t = 1100;
    const out = snaps(m.handle(partUpdated({ id: "ghost", sessionID: sid, messageID: "a1", type: "text", text: "whole" })));
    expect(out[0]!.content).toEqual([{ type: "text", text: "whole" }]);
  });

  test("a delta on another field is ignored", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "kept" }));
    t = 1100;
    expect(m.handle(delta("pa", "x", "metadata"))).toEqual([]);
  });

  test("an import of an open message keeps the text its deltas built", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    m.handle(partUpdated({ id: "pr", sessionID: sid, messageID: "a1", type: "reasoning", text: "" }));
    t = 1100;
    m.handle(delta("pr", "think"));
    m.handle(delta("pa", "Hello "));
    t = 1200;
    const stale = (part: object): Event =>
      ({ ...partUpdated(part), id: `import:p-${(part as { id: string }).id}` }) as Event;
    m.handle(stale({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    m.handle(stale({ id: "pr", sessionID: sid, messageID: "a1", type: "reasoning", text: "th" }));
    t = 1300;
    expect(snaps(m.handle(delta("pa", "world")))[0]!.content).toEqual([
      { type: "text", text: "Hello world" },
      { type: "thinking", text: "think" },
    ]);
  });

  test("an import of a reply that already finished stores its whole text", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1100;
    m.handle(delta("pa", "Hello "));
    const imported = (e: Event) => ({ ...e, id: `import:${e.id}` }) as Event;
    m.handle(imported(partUpdated({
      id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "Hello world", time: { start: 1, end: 2 },
    })));
    const done = snaps(m.handle(imported(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2, completed: 3 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }))));
    expect(done.at(-1)!.partial).toBeUndefined();
    expect(done.at(-1)!.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("the live closing update of a part replaces what the deltas built", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1100;
    m.handle(delta("pa", "draft"));
    t = 1200;
    const out = snaps(m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "final" })));
    expect(out[0]!.content).toEqual([{ type: "text", text: "final" }]);
  });

  test("the finished message carries the text the deltas built", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1100;
    m.handle(delta("pa", "done"));
    const final = m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2, completed: 3 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    const done = snaps(final);
    expect(done).toHaveLength(1);
    expect(done[0]!.partial).toBeUndefined();
    expect(done[0]!.content).toEqual([{ type: "text", text: "done" }]);
  });

  test("a frame held by the window goes out once the window passes", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1010;
    expect(snaps(m.handle(delta("pa", "tail")))).toHaveLength(0);
    expect(m.hasHeldStreams()).toBe(true);
    t = 1020;
    expect(m.flushStreaming()).toEqual([]);
    t = 1060;
    expect(snaps(m.flushStreaming())[0]!.content).toEqual([{ type: "text", text: "tail" }]);
    expect(m.hasHeldStreams()).toBe(false);
  });

  test("nothing is held once the message finishes or the session goes idle", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1010;
    m.handle(delta("pa", "x"));
    expect(m.hasHeldStreams()).toBe(true);
    m.handle({ id: "idle", type: "session.idle", properties: { sessionID: sid } } as unknown as Event);
    expect(m.hasHeldStreams()).toBe(false);
  });

  test("a finished message holds nothing and ignores late deltas", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1010;
    m.handle(delta("pa", "x"));
    expect(m.hasHeldStreams()).toBe(true);
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2, completed: 3 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    expect(m.hasHeldStreams()).toBe(false);
    t = 2000;
    expect(snaps(m.handle(delta("pa", "late")))).toHaveLength(0);
    expect(m.hasHeldStreams()).toBe(false);
    expect(m.flushStreaming()).toEqual([]);
  });

  test("a deleted session holds nothing", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1010;
    m.handle(delta("pa", "x"));
    expect(m.hasHeldStreams()).toBe(true);
    m.handle({
      id: "del",
      type: "session.deleted",
      properties: {
        sessionID: sid,
        info: { id: sid, directory: "/repo", title: "T", time: { created: 1, updated: 2 } },
      },
    } as unknown as Event);
    expect(m.hasHeldStreams()).toBe(false);
    t = 2000;
    expect(m.flushStreaming()).toEqual([]);
  });

  test("the ingestor sends the held frame without waiting for another event", async () => {
    const published: { data: unknown }[] = [];
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append: () => {}, publish: (e) => published.push(...e) },
      reply: async () => {},
    });
    ing.handle(sessionCreated());
    ing.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } }));
    ing.handle(partUpdated({ id: "pu", sessionID: sid, messageID: "u1", type: "text", text: "hi" }));
    ing.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2 }, providerID: "p", modelID: "m",
    }));
    ing.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    ing.handle(delta("pa", "last words"));
    await Bun.sleep(STREAM_SNAPSHOT_MS * 3);
    const last = published.at(-1)!.data as { content: unknown };
    expect(last.content).toEqual([{ type: "text", text: "last words" }]);
    ing.stop();
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
      { type: "file_ref", path: "r.png" },
      { type: "file_ref", path: "spec.pdf" },
      { type: "file_ref", path: "image/svg+xml" },
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
    expect(OPENCODE_MAPPER_VERSION).toBe("opencode-7");
  });
});

describe("a task tool names the child session it opened", () => {
  const assistant = () =>
    msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });

  const toolPart = (
    id: string,
    callID: string,
    tool: string,
    state: object,
  ) =>
    partUpdated({
      id, sessionID: sid, messageID: "a1", type: "tool", callID, tool, state,
    });

  test("a child named one update after the call started still lands on it", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(assistant());
    const part = (metadata: object) =>
      toolPart("ptask2", "c-late", "task", {
        status: "running",
        input: { description: "explore the repo" },
        metadata,
        time: { start: 21 },
      });
    // The part runs before the subagent session exists, so this first update
    // has no id in it — which used to be the last chance to read one.
    const started = m.handle(part({ model: { modelID: "m", providerID: "p" } }));
    const first = started.find((e) => e.type === "tool.call")!;
    expect(first.data).not.toHaveProperty("child_session_id");

    const named = m.handle(part({ sessionId: "ses_kid" }));
    const restated = named.find((e) => e.type === "tool.call")!;
    expect(restated.data).toMatchObject({ call_id: "c-late", child_session_id: "opencode:ses_kid" });
    // A restatement the store keeps, and the projector folds into one call.
    expect(restated.id).not.toBe(first.id);

    const again = m.handle(part({ sessionId: "ses_kid" }));
    expect(again.filter((e) => e.type === "tool.call")).toHaveLength(0);
  });

  test("copies sessionId onto the call and the result, and leaves other tools alone", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(assistant());
    const meta = { sessionId: "ses_kid" };
    const running = m.handle(toolPart("ptask", "c-task", "task", {
      status: "running",
      input: { prompt: "go" },
      metadata: meta,
      time: { start: 21 },
    }));
    const completed = m.handle(toolPart("ptask", "c-task", "task", {
      status: "completed",
      input: { prompt: "go" },
      output: "done",
      title: "task",
      metadata: meta,
      time: { start: 21, end: 31 },
    }));
    const call = running.find((e) => e.type === "tool.call")!;
    const result = completed.find((e) => e.type === "tool.result")!;
    expect(call.data).toMatchObject({ child_session_id: "opencode:ses_kid" });
    expect(result.data).toMatchObject({ child_session_id: "opencode:ses_kid" });

    const bashRunning = m.handle(toolPart("pbash", "c-bash", "bash", {
      status: "running",
      input: { command: "ls" },
      metadata: meta,
      time: { start: 21 },
    }));
    const bashDone = m.handle(toolPart("pbash", "c-bash", "bash", {
      status: "completed",
      input: { command: "ls" },
      output: "files",
      title: "ls",
      metadata: meta,
      time: { start: 21, end: 31 },
    }));
    expect(bashRunning.find((e) => e.type === "tool.call")!.data).not.toHaveProperty("child_session_id");
    expect(bashDone.find((e) => e.type === "tool.result")!.data).not.toHaveProperty("child_session_id");
  });
});

describe("importSession revision", () => {
  test("an unchanged session costs only the info fetch; force pays for messages", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    let messageCalls = 0;
    const info = {
      id: "ses_rev",
      sessionID: "ses_rev",
      title: "T",
      directory: dir,
      time: { created: 1, updated: 42 },
    };
    const messages = [
      {
        info: { id: "u1", sessionID: "ses_rev", role: "user", time: { created: 10 } },
        parts: [
          { id: "p1", sessionID: "ses_rev", messageID: "u1", type: "text", text: "hi" },
        ],
      },
    ];
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/session/ses_rev/message")) {
        messageCalls++;
        return Response.json(messages);
      }
      if (url.includes("/session/ses_rev")) return Response.json(info);
      if (url.includes("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(
                enc.encode('data: {"type":"server.connected","properties":{}}\n\n'),
              );
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    try {
      expect(await conn.importSession("ses_rev", dir)).toBe(true);
      expect(messageCalls).toBe(1);
      // Same time.updated -> the transcript fetch is skipped entirely.
      expect(await conn.importSession("ses_rev", dir)).toBe(false);
      expect(messageCalls).toBe(1);
      expect(await conn.importSession("ses_rev", dir, { force: true })).toBe(true);
      expect(messageCalls).toBe(2);
    } finally {
      conn.stop();
      store.close();
    }
  });
});

describe("pickable providers", () => {
  const catalog = [
    { id: "deepseek", source: "api", env: ["DEEPSEEK_API_KEY"] },
    { id: "minimax-cn-coding-plan", source: "api", env: ["MINIMAX_API_KEY"] },
    { id: "minimax-coding-plan", source: "env", env: ["MINIMAX_API_KEY"] },
    { id: "minimax-cn", source: "env", env: ["MINIMAX_API_KEY"] },
    { id: "minimax", source: "env", env: ["MINIMAX_API_KEY"] },
    { id: "opencode-go", source: "api", env: ["OPENCODE_API_KEY"] },
    { id: "opencode", source: "custom", env: ["OPENCODE_API_KEY"] },
    { id: "openai", source: "env", env: ["OPENAI_API_KEY"] },
  ];

  test("a stored key does not make every sibling that names the same env var pickable", () => {
    const ids = pickableProviders(catalog, [
      "deepseek",
      "minimax-cn-coding-plan",
      "minimax-coding-plan",
      "minimax-cn",
      "minimax",
      "opencode-go",
      "opencode",
      "openai",
    ]).map((row) => row.id);
    expect(ids).toEqual(["deepseek", "minimax-cn-coding-plan", "opencode-go", "opencode", "openai"]);
  });

  test("an env var with no stored key is still a credential", () => {
    const ids = pickableProviders(
      [{ id: "groq", source: "env", env: ["GROQ_API_KEY"] }],
      ["groq"],
    ).map((row) => row.id);
    expect(ids).toEqual(["groq"]);
  });
});
