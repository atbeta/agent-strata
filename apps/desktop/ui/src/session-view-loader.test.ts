import { describe, expect, test } from "bun:test";
import type { SessionView, ViewTail } from "./api";
import { createSessionViewLoader } from "./session-view-loader";
import { filesKeyOf } from "./view-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const view = (sessionId: string, turn = "u1"): SessionView => ({
  session_id: sessionId,
  backend: "opencode",
  status: "active",
  busy: false,
  orphans: [],
  pending_questions: [],
  turns: [{ turn_id: turn, user: [], assistant: [], tool_calls: [] }],
  pending_permissions: [],
  files_changed: [],
  totals: {
    input: 0,
    output: 0,
    cost_usd: 0,
    tool_calls: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    tool_errors: 0,
    permissions_denied: 0,
  },
});

const tailOf = (value: SessionView): ViewTail => {
  const { files_changed, ...rest } = value;
  return {
    ...rest,
    turn_offset: 0,
    prev_turn_id: null,
    files_key: filesKeyOf(value),
    files_changed,
  };
};

describe("owned session view loads", () => {
  test("a cold A tail/full pair cannot paint or warm the cache after switching to B", async () => {
    const aTail = deferred<ViewTail>();
    const aFull = deferred<SessionView>();
    const loader = createSessionViewLoader({
      readTail: (id) => id === "a" ? aTail.promise : Promise.resolve(tailOf(view(id))),
      readFull: (id) => id === "a" ? aFull.promise : Promise.resolve(view(id)),
    });
    const commits: string[] = [];
    const loading = loader.loadCold(
      "a",
      (v) => commits.push(`preview:${v.session_id}`),
      (v) => commits.push(`full:${v.session_id}`),
    );

    const b = await loader.loadFull("b", null, (v) => commits.push(`full:${v.session_id}`));
    expect(b?.session_id).toBe("b");
    aTail.resolve(tailOf(view("a")));
    await Promise.resolve();
    aFull.resolve(view("a"));

    expect(await loading).toBeUndefined();
    expect(commits).toEqual(["full:b"]);
  });

  test("a tail preview may paint, but its late full response is still rejected", async () => {
    const full = deferred<SessionView>();
    const loader = createSessionViewLoader({
      readTail: (id) => Promise.resolve(tailOf(view(id))),
      readFull: () => full.promise,
    });
    const commits: string[] = [];
    const previewed = deferred<void>();
    const loading = loader.loadCold(
      "a",
      (v) => {
        commits.push(`preview:${v.session_id}`);
        previewed.resolve();
      },
      (v) => commits.push(`full:${v.session_id}`),
    );
    await previewed.promise;
    loader.invalidate();
    full.resolve(view("a"));

    expect(await loading).toBeUndefined();
    expect(commits).toEqual(["preview:a"]);
  });

  test("a tail refresh does not invalidate an in-flight cold full load", async () => {
    const full = deferred<SessionView>();
    const loader = createSessionViewLoader({
      readTail: (id) => Promise.resolve(tailOf(view(id))),
      readFull: () => full.promise,
    });
    const commits: string[] = [];
    const previewed = deferred<void>();
    const loading = loader.loadCold(
      "a",
      (v) => {
        commits.push(`preview:${v.session_id}`);
        previewed.resolve();
      },
      (v) => commits.push(`full:${v.session_id}`),
    );
    await previewed.promise;

    expect(await loader.refreshTail("a", undefined, () => view("a"), (v) => {
      commits.push(`tail:${v.session_id}`);
    })).toBe("applied");
    full.resolve(view("a"));

    expect((await loading)?.session_id).toBe("a");
    expect(commits).toEqual(["preview:a", "tail:a", "full:a"]);
  });

  test("a deferred warm tail cannot write a new session's signal or cache", async () => {
    const pending = deferred<ViewTail>();
    let currentSessionId = "a";
    const loader = createSessionViewLoader({
      readTail: () => pending.promise,
      readFull: (id) => Promise.resolve(view(id)),
      currentSessionId: () => currentSessionId,
    });
    const commits: string[] = [];
    const refreshing = loader.refreshTail(
      "a",
      undefined,
      () => view("a"),
      (v) => commits.push(v.session_id),
    );
    currentSessionId = "b";
    pending.resolve(tailOf(view("a")));

    expect(await refreshing).toBe("stale");
    expect(commits).toEqual([]);
  });
});
