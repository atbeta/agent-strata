import { describe, expect, test } from "bun:test";
import {
  OpencodeMapper,
  createIngestor,
  STREAM_SNAPSHOT_MS,
} from "../src/index";
import type { Event } from "@opencode-ai/sdk/v2";
import { sid, sessionCreated, msgUpdated, partUpdated } from "./helpers";

describe("OpencodeMapper", () => {
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

  test("an idle message cannot stream into the next run, but its durable final still lands", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "old" }));
    m.handle(partUpdated({ id: "pr", sessionID: sid, messageID: "a1", type: "reasoning", text: "think" }));
    m.handle({ id: "idle-old", type: "session.idle", properties: { sessionID: sid } } as unknown as Event);

    const busy = m.handle(msgUpdated({ id: "u2", sessionID: sid, role: "user", time: { created: 4 } }));
    expect(busy.find((e) => e.type === "session.status")?.data).toEqual({ state: "busy" });

    t = 2000;
    const late = [
      m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "old again" })),
      m.handle(partUpdated({ id: "pr", sessionID: sid, messageID: "a1", type: "reasoning", text: "think again" })),
      m.handle(delta("pa", " late")),
    ].flat();
    expect(snaps(late)).toEqual([]);
    expect(m.hasHeldStreams()).toBe(false);

    const final = m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2, completed: 5 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    const done = snaps(final);
    expect(done).toHaveLength(1);
    expect(done[0]!.partial).toBeUndefined();
    expect(done[0]!.content).toEqual([{ type: "text", text: "old" }, { type: "thinking", text: "think" }]);
  });

  test("a text part that arrives after idle still fills the durable final", () => {
    // Idle and the first content part race. Retiring the message used to drop
    // the part, and the completion — built from the parts held here — stored
    // an empty reply.
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle({ id: "idle-late", type: "session.idle", properties: { sessionID: sid } } as unknown as Event);
    t = 1100;
    const late = m.handle(partUpdated({
      id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "the",
    }));
    expect(snaps(late).some((s) => s.partial)).toBe(false);
    t = 1200;
    m.handle(partUpdated({
      id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "the whole answer",
    }));
    const final = m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2, completed: 5 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 1, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    const done = snaps(final);
    expect(done.at(-1)?.partial).toBeUndefined();
    expect(done.at(-1)?.content).toEqual([{ type: "text", text: "the whole answer" }]);
    expect(m.flushStreaming()).toEqual([]);
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

});
