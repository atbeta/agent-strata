import { describe, expect, test } from "bun:test";
import { forkBefore, forkTitle } from "../src/fork";

const turn = (turn_id: string, msgs: string[], reverted?: boolean) => ({
  turn_id,
  assistant: msgs.map((msg_id) => ({ msg_id })),
  ...(reverted ? { reverted } : {}),
});
const view = {
  turns: [turn("u1", ["a1", "a2"]), turn("u2", ["a3"])],
} as unknown as Parameters<typeof forkBefore>[0];

describe("where a fork cuts", () => {
  test("keeping a reply names the message after it", () => {
    expect(forkBefore(view, "a1", true)).toEqual({ before: "a2" });
    expect(forkBefore(view, "a2", true)).toEqual({ before: "u2" });
  });

  test("keeping the last reply copies the whole session", () => {
    expect(forkBefore(view, "a3", true)).toEqual({ before: undefined });
    expect(forkBefore(view, undefined, false)).toEqual({ before: undefined });
  });

  test("forking at a user message leaves that message out", () => {
    expect(forkBefore(view, "u2", false)).toEqual({ before: "u2" });
  });

  test("turns a revert undid stay behind", () => {
    const undone = { turns: [...view.turns, turn("u3", ["a4"], true)] } as typeof view;
    expect(forkBefore(undone, undefined, false)).toEqual({ before: "u3" });
    expect(forkBefore(undone, "a3", true)).toEqual({ before: "u3" });
    expect(forkBefore(undone, "a4", true)).toBeNull();
  });

  test("an unknown message is refused", () => {
    expect(forkBefore(view, "nope", true)).toBeNull();
  });
});

describe("naming a fork", () => {
  test("numbers past the forks already taken", () => {
    expect(forkTitle("Plan", [])).toBe("Plan (fork #1)");
    expect(forkTitle("Plan", ["Plan (fork #1)", "Plan (fork #3)", "Other (fork #9)", null])).toBe("Plan (fork #4)");
  });

  test("a fork of a fork counts with its siblings", () => {
    expect(forkTitle("Plan (fork #2)", ["Plan", "Plan (fork #1)", "Plan (fork #2)"])).toBe("Plan (fork #3)");
  });

  test("a longer title that only starts the same is not a sibling", () => {
    expect(forkTitle("Plan", ["Plan B (fork #5)"])).toBe("Plan (fork #1)");
  });
});
