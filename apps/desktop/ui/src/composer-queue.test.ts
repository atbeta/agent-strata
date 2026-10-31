import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Outgoing } from "./composer-input";
import {
  createSessionQueues,
  parkSessionQueues,
  persistSessionQueues,
  queueGate,
  restoreColdDraft,
  restoreSessionDraft,
  takeIdleHeads,
} from "./composer-queue";
import { readQueuedText, takeQueuedText, writeQueuedText } from "./prompt-memory";

function store() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

const message = (text: string, sessionId: string): Outgoing => ({
  text,
  picked: [`${sessionId}.ts`],
  attachments: [{ id: `${sessionId}-image`, name: "image.png", mime: "image/png", url: "data:image/png;base64,AA==" }],
  sessionId,
});

describe("session queue lifetime", () => {
  test("A to B to A keeps each queue with its picks and attachments", () => {
    const queues = createSessionQueues<Outgoing>("a");
    const a = message("from A", "a");
    const b = message("from B", "b");
    queues.replace([a]);

    expect(queues.switch("b")).toEqual([]);
    queues.replace([b]);
    expect(queues.switch("a")).toEqual([a]);
    expect(queues.current()[0]?.picked).toEqual(["a.ts"]);
    expect(queues.current()[0]?.attachments.map((item) => item.id)).toEqual(["a-image"]);
    expect(queues.switch("b")).toEqual([b]);
  });

  test("an empty queue is dropped when the session is left", () => {
    const queues = createSessionQueues<Outgoing>("a");
    queues.replace([]);
    queues.switch("b");
    expect([...queues.snapshot().keys()]).toEqual([]);
    queues.replace([message("from B", "b")]);
    queues.replace([]);
    expect([...queues.snapshot().keys()]).toEqual([]);
  });

  test("a session opened after restart gets its queued text back into the draft", () => {
    const storage = store();
    writeQueuedText("b", ["held for B"], storage);
    expect(restoreSessionDraft("b", "typed", {
      take: (id) => takeQueuedText(id, storage as never),
    })).toBe("held for B\ntyped");
    expect(readQueuedText("b", storage)).toEqual([]);
  });

  test("only cold initialization takes persisted text into the draft", () => {
    const storage = store();
    writeQueuedText("a", ["waiting"], storage);
    let takes = 0;
    const restore = () =>
      restoreColdDraft("a", {
        read: () => "typed",
        take: (id) => {
          takes++;
          return takeQueuedText(id, storage as never);
        },
      });

    expect(restore()).toBe("waiting\ntyped");
    expect(restore()).toBe("typed");
    expect(takes).toBe(2);
    expect(readQueuedText("a", storage)).toEqual([]);
  });

  test("a sent or cleared queue cannot come back after a restart", () => {
    const storage = store();
    const write = (id: string, texts: readonly string[]) => writeQueuedText(id, texts, storage);
    const queues = createSessionQueues<Outgoing>("a");
    queues.replace([message("send once", "a")]);
    let persisted = persistSessionQueues(queues.snapshot(), new Set(), write);
    expect(readQueuedText("a", storage)).toEqual(["send once"]);

    queues.replace([]);
    persisted = persistSessionQueues(queues.snapshot(), persisted, write);
    expect(persisted.size).toBe(0);
    expect(readQueuedText("a", storage)).toEqual([]);
    expect(restoreColdDraft("a", { read: () => "", take: (id) => takeQueuedText(id, storage as never) })).toBe("");
  });

  test("clearing B does not clear A's persisted queue", () => {
    const storage = store();
    const write = (id: string, texts: readonly string[]) => writeQueuedText(id, texts, storage);
    const queues = createSessionQueues<Outgoing>("a");
    queues.replace([message("from A", "a")]);
    queues.switch("b");
    queues.replace([message("from B", "b")]);
    let persisted = persistSessionQueues(queues.snapshot(), new Set(), write);

    queues.replace([]);
    persisted = persistSessionQueues(queues.snapshot(), persisted, write);
    expect(readQueuedText("a", storage)).toEqual(["from A"]);
    expect(readQueuedText("b", storage)).toEqual([]);
  });

  test("writing B's queue does not replace A's", () => {
    const queues = createSessionQueues<Outgoing>("a");
    const a = message("from A", "a");
    queues.replace([a]);
    queues.replaceSession("b", [message("from B", "b")]);
    expect(queues.read("a")).toEqual([a]);
    expect(queues.read("b").map((item) => item.text)).toEqual(["from B"]);
    queues.replaceSession("b", []);
    expect(queues.read("a")).toEqual([a]);
    expect(queues.read("b")).toEqual([]);
  });
});

const idle = new Map([["a", { busy: false, held: false }]]);

describe("a queue drains for the session it belongs to", () => {
  test("an idle session sends its head while another session is on screen", () => {
    const queued = new Map([["a", [message("follow up", "a"), message("and then", "a")]]]);
    const taken = takeIdleHeads(queued, idle, { id: "b", replaying: false });
    expect(taken.sending.map((send) => send.item.text)).toEqual(["follow up"]);
    expect(taken.sending[0]?.sessionId).toBe("a");
    expect(taken.queues.get("a")?.map((item) => item.text)).toEqual(["and then"]);
  });

  test("a busy or held session keeps its queue", () => {
    const queued = new Map([["a", [message("follow up", "a")]]]);
    expect(takeIdleHeads(queued, new Map([["a", { busy: true, held: false }]]), { id: "b", replaying: false }).sending).toEqual([]);
    expect(takeIdleHeads(queued, new Map([["a", { busy: false, held: true }]]), { id: "b", replaying: false }).sending).toEqual([]);
    expect(takeIdleHeads(queued, new Map([["a", { busy: true, held: false }]]), { id: "b", replaying: false }).queues.get("a")).toHaveLength(1);
  });

  test("a session with no gate does not send", () => {
    const queued = new Map([["a", [message("follow up", "a")]]]);
    const taken = takeIdleHeads(queued, new Map(), { id: "b", replaying: false });
    expect(taken.sending).toEqual([]);
    expect(taken.queues.get("a")).toHaveLength(1);
  });

  test("replay on the open session does not hold anyone else's queue", () => {
    const queued = new Map([
      ["a", [message("follow up", "a")]],
      ["b", [message("on screen", "b")]],
    ]);
    const gates = new Map([
      ["a", { busy: false, held: false }],
      ["b", { busy: false, held: false }],
    ]);
    const taken = takeIdleHeads(queued, gates, { id: "b", replaying: true });
    expect(taken.sending.map((send) => send.sessionId)).toEqual(["a"]);
    expect(taken.queues.get("b")?.map((item) => item.text)).toEqual(["on screen"]);
  });

  test("a head stamped for another session stays in the queue", () => {
    const queued = new Map([["a", [message("from B", "b")]]]);
    const taken = takeIdleHeads(queued, idle, { id: "a", replaying: false });
    expect(taken.sending).toEqual([]);
    expect(taken.queues.get("a")?.map((item) => item.text)).toEqual(["from B"]);
  });
});

describe("whether a session may send", () => {
  const base = {
    visible: false,
    viewBusy: false,
    listedBusy: false as boolean | undefined,
    inflight: false,
    held: false,
    now: 1_000,
  };

  test("the session on screen follows its own view, not the list", () => {
    expect(queueGate({ ...base, visible: true, viewBusy: false, listedBusy: true })?.busy).toBe(false);
    expect(queueGate({ ...base, visible: true, viewBusy: true, listedBusy: false })?.busy).toBe(true);
    // Until the view or the list shows the run, grace holds the next head here
    // too. Dropping it early is how two follow-ups leave in one turn.
    expect(queueGate({ ...base, visible: true, viewBusy: false, graceUntil: 1_500 })?.busy).toBe(true);
    expect(queueGate({ ...base, visible: true, viewBusy: false, inflight: true })?.busy).toBe(true);
  });

  test("a background session follows the list", () => {
    expect(queueGate({ ...base, listedBusy: false })).toEqual({ busy: false, held: false });
    expect(queueGate({ ...base, listedBusy: true })?.busy).toBe(true);
  });

  test("a background session the list has not mentioned does not send", () => {
    expect(queueGate({ ...base, listedBusy: undefined })).toBeUndefined();
  });

  test("an in-flight send or a grace window holds the next head", () => {
    expect(queueGate({ ...base, inflight: true })?.busy).toBe(true);
    expect(queueGate({ ...base, graceUntil: 1_500 })?.busy).toBe(true);
    expect(queueGate({ ...base, graceUntil: 1_000 })?.busy).toBe(false);
  });

  test("a hold keeps the queue whether or not the run is idle", () => {
    expect(queueGate({ ...base, held: true, listedBusy: false })).toEqual({ busy: true, held: true });
  });
});

describe("closing parks the queue in the draft", () => {
  test("queued words join the draft and nothing is left to send", () => {
    const drafts = new Map<string, string>([["a", "typed"]]);
    const stored = new Map<string, string[]>();
    parkSessionQueues(
      new Map([
        ["a", [message("follow up", "a")]],
        ["b", [message("other", "b")]],
      ]),
      {
        readDraft: (id) => drafts.get(id) ?? "",
        writeDraft: (id, text) => {
          if (text) drafts.set(id, text);
          else drafts.delete(id);
        },
        writeQueued: (id, texts) => {
          if (texts.length) stored.set(id, [...texts]);
          else stored.delete(id);
        },
      },
    );
    expect(drafts.get("a")).toBe("follow up\ntyped");
    expect(drafts.get("b")).toBe("other");
    expect(stored.size).toBe(0);
    expect(takeIdleHeads(new Map(), idle, { id: "b", replaying: false }).sending).toEqual([]);
  });
});

describe("the composer wires the queue to the session that owns it", () => {
  const src = readFileSync(join(import.meta.dir, "session-composer.tsx"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  test("a switch does not cancel the session that was left, and leaving the screen parks the queue", () => {
    const reset = src.slice(src.indexOf("const resetFor"), src.indexOf("const onKeyDown"));
    expect(reset).not.toContain("deliveries.invalidate");
    expect(src).toContain("takeIdleHeads");
    expect(src).toContain("parkSessionQueues");
    expect(src).toContain("queueGate");
  });
});
