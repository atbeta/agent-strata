import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createSessionStop, STOP_TIMEOUT_MS } from "./session-stop";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  let sessionId = "a";
  let error = "";
  let queuePaused = false;
  let refreshes = 0;
  let beforeRequests = 0;
  const requests: { sessionId: string; pending: ReturnType<typeof deferred<void>> }[] = [];
  const timers: {
    callback: () => void;
    ms: number;
    cancelled: boolean;
    handle: ReturnType<typeof setTimeout>;
  }[] = [];
  let controller!: ReturnType<typeof createSessionStop>;
  const dispose = createRoot((own) => {
    controller = createSessionStop({
      sessionId: () => sessionId,
      generating: () => true,
      request: (id) => {
        const pending = deferred<void>();
        requests.push({ sessionId: id, pending });
        return pending.promise;
      },
      refresh: () => {
        refreshes++;
      },
      beforeRequest: () => {
        beforeRequests++;
      },
      setQueuePaused: (paused) => {
        queuePaused = paused;
      },
      setError: (message) => {
        error = message;
      },
      unconfirmedError: () => "unconfirmed",
      requestError: (err) => `request: ${err instanceof Error ? err.message : "unknown"}`,
      schedule: (callback, ms) => {
        const timer = { callback, ms, cancelled: false } as (typeof timers)[number];
        timer.handle = timer as unknown as ReturnType<typeof setTimeout>;
        timers.push(timer);
        return timer.handle;
      },
      cancel: (handle) => {
        const timer = timers.find((row) => row.handle === handle);
        if (timer) timer.cancelled = true;
      },
    });
    return own;
  });

  return {
    controller,
    requests,
    timers,
    get error() {
      return error;
    },
    get queuePaused() {
      return queuePaused;
    },
    get refreshes() {
      return refreshes;
    },
    get beforeRequests() {
      return beforeRequests;
    },
    switchSession(id: string) {
      sessionId = id;
      controller.reset();
    },
    fireTimeout(index: number) {
      timers[index]!.callback();
    },
    dispose,
  };
}

const flush = () => Bun.sleep(0);

describe("session stop attempts", () => {
  test("a stop that has not confirmed within the watchdog can be tried again", async () => {
    const h = setup();
    const first = h.controller.stop();
    expect(h.requests.map((row) => row.sessionId)).toEqual(["a"]);
    expect(h.controller.stopping()).toBe(true);
    expect(h.queuePaused).toBe(true);
    expect(h.beforeRequests).toBe(1);
    expect(h.timers[0]?.ms).toBe(STOP_TIMEOUT_MS);

    h.fireTimeout(0);
    expect(h.controller.stopping()).toBe(false);
    expect(h.controller.stopped()).toBe(false);
    expect(h.queuePaused).toBe(false);
    expect(h.error).toBe("unconfirmed");

    const second = h.controller.stop();
    expect(h.requests.map((row) => row.sessionId)).toEqual(["a", "a"]);
    expect(h.controller.stopping()).toBe(true);
    expect(h.queuePaused).toBe(true);
    expect(h.error).toBe("");

    h.requests[1]!.pending.resolve();
    await second;
    await flush();
    expect(h.controller.stopping()).toBe(false);
    expect(h.controller.stopped()).toBe(true);
    h.requests[0]!.pending.resolve();
    await first;
    h.dispose();
  });

  test("a late success cannot confirm the second attempt or change its queue pause", async () => {
    const h = setup();
    const first = h.controller.stop();
    h.fireTimeout(0);
    const second = h.controller.stop();

    h.requests[0]!.pending.resolve();
    await first;
    await flush();
    expect(h.controller.stopping()).toBe(true);
    expect(h.controller.stopped()).toBe(false);
    expect(h.queuePaused).toBe(true);
    expect(h.error).toBe("");
    expect(h.refreshes).toBe(0);

    h.requests[1]!.pending.reject(new Error("second failed"));
    await second;
    expect(h.controller.stopping()).toBe(false);
    expect(h.controller.stopped()).toBe(false);
    expect(h.queuePaused).toBe(false);
    expect(h.error).toBe("request: second failed");
    h.dispose();
  });

  test("a late failure cannot replace the second attempt's result", async () => {
    const h = setup();
    const first = h.controller.stop();
    h.fireTimeout(0);
    const second = h.controller.stop();

    h.requests[0]!.pending.reject(new Error("first failed"));
    await first;
    expect(h.controller.stopping()).toBe(true);
    expect(h.error).toBe("");
    expect(h.queuePaused).toBe(true);

    h.requests[1]!.pending.resolve();
    await second;
    await flush();
    expect(h.controller.stopping()).toBe(false);
    expect(h.controller.stopped()).toBe(true);
    expect(h.queuePaused).toBe(true);
    expect(h.error).toBe("");
    expect(h.refreshes).toBe(1);
    h.dispose();
  });

  for (const outcome of ["success", "failure"] as const) {
    test(`a late ${outcome} cannot overwrite a new session`, async () => {
      const h = setup();
      const first = h.controller.stop();
      h.switchSession("b");
      expect(h.controller.stopping()).toBe(false);
      expect(h.queuePaused).toBe(false);

      const second = h.controller.stop();
      if (outcome === "success") h.requests[0]!.pending.resolve();
      else h.requests[0]!.pending.reject(new Error("old session failed"));
      await first;
      await flush();

      expect(h.requests.map((row) => row.sessionId)).toEqual(["a", "b"]);
      expect(h.controller.stopping()).toBe(true);
      expect(h.controller.stopped()).toBe(false);
      expect(h.queuePaused).toBe(true);
      expect(h.error).toBe("");
      expect(h.refreshes).toBe(0);

      h.requests[1]!.pending.resolve();
      await second;
      await flush();
      expect(h.controller.stopped()).toBe(true);
      expect(h.error).toBe("");
      h.dispose();
    });
  }

  test("a refused request has the same retry cleanup as a timeout", async () => {
    const h = setup();
    const first = h.controller.stop();
    h.requests[0]!.pending.reject(new Error("offline"));
    await first;
    expect(h.controller.stopping()).toBe(false);
    expect(h.queuePaused).toBe(false);
    expect(h.error).toBe("request: offline");
    expect(h.timers[0]?.cancelled).toBe(true);

    const second = h.controller.stop();
    expect(h.requests.length).toBe(2);
    expect(h.controller.stopping()).toBe(true);
    expect(h.queuePaused).toBe(true);
    expect(h.error).toBe("");
    h.requests[1]!.pending.resolve();
    await second;
    await flush();
    h.dispose();
  });
});
