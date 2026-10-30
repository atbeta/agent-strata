import { describe, expect, test } from "bun:test";
import { DevStopResult, PermissionResponse, QuestionResponse } from "../src/index";

describe("HTTP prompt contracts", () => {
  test("permission responses require a known decision and scope", () => {
    expect(PermissionResponse.safeParse({ decision: "allow", scope: "always" }).success).toBe(true);
    expect(PermissionResponse.safeParse({}).success).toBe(false);
    expect(PermissionResponse.safeParse({ decision: "yes" }).success).toBe(false);
    expect(PermissionResponse.safeParse({ decision: "allow", scope: "forever" }).success).toBe(false);
    expect(PermissionResponse.safeParse({ decision: "deny", extra: true }).success).toBe(false);
  });

  test("question responses require a known decision and string matrix answers", () => {
    expect(QuestionResponse.safeParse({ decision: "reply", answers: [["A"]] }).success).toBe(true);
    expect(QuestionResponse.safeParse({ decision: "reject" }).success).toBe(true);
    expect(QuestionResponse.safeParse({ decision: "allow" }).success).toBe(false);
    expect(QuestionResponse.safeParse({ decision: "reply", answers: [[1]] }).success).toBe(false);
  });

  test("dev stop responses match the service body, including ok", () => {
    // The route returns the process answer plus ok. A schema that rejects ok
    // parses in tests that mock the answer without it, and throws in the UI
    // after a stop that actually worked.
    expect(DevStopResult.parse({ stopped: true, clean: true, residual: [], ok: true })).toEqual({
      stopped: true,
      clean: true,
      residual: [],
      ok: true,
    });
    expect(DevStopResult.safeParse({ ok: true, clean: true, residual: [] }).success).toBe(false);
    expect(DevStopResult.safeParse({ stopped: true, clean: true, residual: [], extra: true }).success).toBe(false);
  });
});
