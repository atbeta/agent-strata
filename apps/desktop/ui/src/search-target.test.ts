import { describe, expect, test } from "bun:test";
import { clearSearchTarget, requestSearchTarget, searchTarget } from "./search-target";

describe("a transcript hit handed to a session", () => {
  test("carries the session and the query, then is consumed once", () => {
    clearSearchTarget();
    expect(searchTarget()).toBeUndefined();
    requestSearchTarget("opencode:a", "scrollTop");
    expect(searchTarget()).toEqual({ sessionId: "opencode:a", query: "scrollTop" });
    clearSearchTarget();
    expect(searchTarget()).toBeUndefined();
  });

  test("a later request replaces the earlier one", () => {
    clearSearchTarget();
    requestSearchTarget("opencode:a", "first");
    requestSearchTarget("opencode:b", "second");
    expect(searchTarget()).toEqual({ sessionId: "opencode:b", query: "second" });
    clearSearchTarget();
  });
});
