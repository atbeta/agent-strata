import { describe, expect, test } from "bun:test";
import { finishedSessions } from "./notify";

describe("a session that just finished", () => {
  test("notices a session that was busy and is now idle", () => {
    const prev = new Map([
      ["a", true],
      ["b", false],
    ]);
    expect(
      finishedSessions(prev, [
        { id: "a", title: "one", busy: false },
        { id: "b", title: "two", busy: false },
        { id: "c", title: "three", busy: false },
      ]).map((row) => row.id),
    ).toEqual(["a"]);
  });

  test("stays quiet while a session is still running", () => {
    expect(finishedSessions(new Map([["a", true]]), [{ id: "a", title: "one", busy: true }])).toEqual([]);
  });
});
