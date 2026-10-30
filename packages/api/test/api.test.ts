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

  test("dev stop responses use the service's stopped field", () => {
    expect(DevStopResult.parse({ stopped: true, clean: true, residual: [] })).toEqual({
      stopped: true,
      clean: true,
      residual: [],
    });
    expect(DevStopResult.safeParse({ ok: true, clean: true, residual: [] }).success).toBe(false);
  });
});
