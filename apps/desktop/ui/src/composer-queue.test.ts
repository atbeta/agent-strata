import { describe, expect, test } from "bun:test";
import type { Outgoing } from "./composer-input";
import { createSessionQueues, persistSessionQueues, restoreColdDraft, restoreSessionDraft } from "./composer-queue";
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
    })).toBe("typed\nheld for B");
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

    expect(restore()).toBe("typed\nwaiting");
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
});
