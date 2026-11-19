import { describe, expect, test } from "bun:test";
import { filterScheduleCandidates } from "./schedule-candidates";

const candidates = [
  { session_id: "opencode:one", title: "发布流水线" },
  { session_id: "opencode:two", title: "Daily Standup" },
  { session_id: "acp:three" },
];

describe("schedule session search", () => {
  test("matches both titles and ids without changing the source order", () => {
    expect(filterScheduleCandidates(candidates, "发布").map((c) => c.session_id)).toEqual([
      "opencode:one",
    ]);
    expect(filterScheduleCandidates(candidates, "ACP:THREE").map((c) => c.session_id)).toEqual([
      "acp:three",
    ]);
    expect(filterScheduleCandidates(candidates, "standup").map((c) => c.session_id)).toEqual([
      "opencode:two",
    ]);
  });

  test("an empty query keeps every candidate and an unknown one returns none", () => {
    expect(filterScheduleCandidates(candidates, "  ")).toEqual(candidates);
    expect(filterScheduleCandidates(candidates, "missing")).toEqual([]);
  });
});
