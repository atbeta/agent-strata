import { describe, expect, test } from "bun:test";
import { createRequestOwner } from "./request-owner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("request ownership", () => {
  test("only the newest request for a session may commit", async () => {
    const owner = createRequestOwner();
    const first = deferred<string>();
    const second = deferred<string>();
    const commits: string[] = [];

    const run = (request: Promise<string>) => {
      const token = owner.begin("a");
      return request.then((value) => {
        if (owner.isCurrent(token)) commits.push(value);
      });
    };

    const old = run(first.promise);
    const latest = run(second.promise);
    second.resolve("new");
    await latest;
    first.resolve("old");
    await old;

    expect(commits).toEqual(["new"]);
  });

  test("a request for A stays current when B starts, and closing drops it", async () => {
    const owner = createRequestOwner();
    const pending = deferred<string>();
    const token = owner.begin("a");
    const commits: string[] = [];
    const waiting = pending.promise.then((value) => {
      if (owner.isCurrent(token)) commits.push(value);
    });

    // Leaving A for B is not a cancel. The request was made for A and still
    // belongs to A; only a newer request for A, or closing the composer, drops it.
    owner.begin("b");
    expect(owner.isCurrent(token)).toBe(true);
    const invalidated = owner.begin("a");
    expect(owner.isCurrent(token)).toBe(false);
    owner.invalidate();
    expect(owner.isCurrent(invalidated)).toBe(false);

    pending.resolve("late");
    await waiting;
    expect(commits).toEqual([]);
  });
});
