import { describe, expect, test } from "bun:test";
import { createComposerDelivery } from "./composer-delivery";
import type { Outgoing } from "./composer-input";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const out = (text: string, sessionId = "a"): Outgoing => ({
  text,
  picked: ["a.ts"],
  attachments: [{ id: "one", name: "a.png", mime: "image/png", url: "data:image/png;base64,AA==" }],
  sessionId,
});

function memoryQueue() {
  const values = new Map<string, string[]>();
  return {
    readQueued: (id: string) => [...(values.get(id) ?? [])],
    writeQueued: (id: string, texts: readonly string[]) => {
      if (texts.length) values.set(id, [...texts]);
      else values.delete(id);
    },
    values,
  };
}

describe("composer delivery settlement", () => {
  test("a successful A response after switching to B does not write B", async () => {
    const queue = memoryQueue();
    const delivery = createComposerDelivery(queue);
    const pending = deferred<void>();
    let visible = "B draft";
    let requests = 0;

    const sending = delivery.settle({
      sessionId: "a",
      out: out("from A"),
      request: () => {
        requests++;
        return pending.promise;
      },
      onSuccess: () => {
        visible = "A success polluted B";
      },
      onFailure: () => {
        visible = "A failure polluted B";
      },
    });
    delivery.invalidate();
    pending.resolve();

    expect(await sending).toBe("stale-success");
    expect(visible).toBe("B draft");
    expect(queue.values.has("a")).toBe(false);
    expect(requests).toBe(1);
  });

  test("a failed A response is retained for A without touching or resending into B", async () => {
    const queue = memoryQueue();
    const delivery = createComposerDelivery(queue);
    const pending = deferred<void>();
    let visible = "B draft";
    let requests = 0;

    const sending = delivery.settle({
      sessionId: "a",
      out: out("from A"),
      request: () => {
        requests++;
        return pending.promise;
      },
      onSuccess: () => {
        visible = "A success polluted B";
      },
      onFailure: () => {
        visible = "A failure polluted B";
      },
    });
    delivery.invalidate();
    pending.reject(new Error("offline"));

    expect(await sending).toBe("stale-failure");
    expect(visible).toBe("B draft");
    expect(queue.values.get("a")).toEqual(["from A"]);

    const restored = delivery.restore("a", {
      text: "typed on return",
      picked: ["b.ts"],
      attachments: [],
      sessionId: "a",
    });
    expect(restored.draft.text).toBe("from A\ntyped on return");
    expect(restored.draft.picked).toEqual(["a.ts", "b.ts"]);
    expect(restored.draft.attachments.map((a) => a.id)).toEqual(["one"]);
    expect(queue.values.has("a")).toBe(false);
    expect(requests).toBe(1);
  });

  test("a request for A still commits after a request for B has started", async () => {
    const delivery = createComposerDelivery(memoryQueue());
    const pendingA = deferred<void>();
    const pendingB = deferred<void>();
    let committed = "";

    const sendingA = delivery.settle({
      sessionId: "a",
      out: out("from A"),
      request: () => pendingA.promise,
      onSuccess: () => {
        committed = "A";
      },
      onFailure: () => {
        committed = "A failed";
      },
    });
    const sendingB = delivery.settle({
      sessionId: "b",
      out: out("from B", "b"),
      request: () => pendingB.promise,
      onSuccess: () => {},
      onFailure: () => {
        committed = "B failed";
      },
    });
    pendingA.resolve();
    pendingB.resolve();

    expect(await sendingA).toBe("success");
    expect(await sendingB).toBe("success");
    expect(committed).toBe("A");
  });

  test("a failed A response stays A's failure after B has started", async () => {
    const queue = memoryQueue();
    const delivery = createComposerDelivery(queue);
    const pendingA = deferred<void>();
    const pendingB = deferred<void>();
    let failed = "";

    const sendingA = delivery.settle({
      sessionId: "a",
      out: out("from A"),
      request: () => pendingA.promise,
      onSuccess: () => {},
      onFailure: () => {
        failed = "A";
      },
    });
    void delivery.settle({
      sessionId: "b",
      out: out("from B", "b"),
      request: () => pendingB.promise,
      onSuccess: () => {},
      onFailure: () => {
        failed = "B";
      },
    });
    pendingA.reject(new Error("offline"));

    expect(await sendingA).toBe("failure");
    expect(failed).toBe("A");
    expect(queue.values.has("a")).toBe(false);
    pendingB.resolve();
  });

  test("a current failure still reports to the visible session", async () => {
    const delivery = createComposerDelivery();
    let error = "";
    const result = await delivery.settle({
      sessionId: "a",
      out: out("kept"),
      request: () => Promise.reject(new Error("no")),
      onSuccess: () => {},
      onFailure: () => {
        error = "no";
      },
    });
    expect(result).toBe("failure");
    expect(error).toBe("no");
  });

  test("retaining the same message twice keeps one copy", async () => {
    // Every stale settlement retains again. Appending blindly put three copies
    // of one sentence in the queue, and all three came back on the next open.
    const queue = memoryQueue();
    const delivery = createComposerDelivery(queue);

    const staleOnce = async () => {
      const pending = deferred<void>();
      const sending = delivery.settle({
        sessionId: "a",
        out: out("the same sentence"),
        request: () => pending.promise,
        onSuccess: () => {},
        onFailure: () => {},
      });
      delivery.invalidate();
      pending.reject(new Error("gone"));
      await sending;
    };

    await staleOnce();
    await staleOnce();
    await staleOnce();
    expect(queue.values.get("a")).toEqual(["the same sentence"]);
  });

  test("a retained message is reported so it can be shown", async () => {
    // Storage alone is invisible: nothing on screen reads it, so a retained
    // message waited there until the next open and then arrived in bulk.
    const queue = memoryQueue();
    const seen: { sessionId: string; text: string }[] = [];
    const delivery = createComposerDelivery({
      ...queue,
      onRetain: (sessionId, kept) => seen.push({ sessionId, text: kept.text }),
    });

    const pending = deferred<void>();
    const sending = delivery.settle({
      sessionId: "a",
      out: out("never left"),
      request: () => pending.promise,
      onSuccess: () => {},
      onFailure: () => {},
    });
    delivery.invalidate();
    pending.reject(new Error("gone"));
    await sending;

    expect(seen).toEqual([{ sessionId: "a", text: "never left" }]);
  });
});
