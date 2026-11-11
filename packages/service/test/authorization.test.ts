import { describe, expect, test } from "bun:test";
import { autoAccept, type Decision, type Policy } from "@agent-strata/policy";
import type { ToolEntry } from "@agent-strata/plugin-sdk";
import { createAuthorizer, judgeToolCall } from "../src/authorization";

const policy = (defaultDecision: Policy["default"] = "ask", rules: Policy["rules"] = []): Policy => ({
  version: 1,
  default: defaultDecision,
  rules,
});

const tool = (overrides: Partial<ToolEntry> = {}): ToolEntry => ({
  plugin_id: "echo",
  tool: "say",
  name: "echo_say",
  description: "say something",
  input: { type: "object" },
  ...overrides,
});

describe("tool authorization", () => {
  test("asks without a policy and applies the manifest floor", () => {
    expect(judgeToolCall(undefined, tool(), {})).toEqual({ decision: "ask", reason: "no policy" });
    expect(judgeToolCall(policy("allow"), tool({ policy: { default: "ask" } }), {})).toMatchObject({
      decision: "ask",
      reason: 'plugin requires at least "ask"',
    });
  });

  test("auto does not lift a manifest floor, but an explicit allow does", () => {
    const risky = tool({ policy: { default: "ask" } });
    expect(judgeToolCall(autoAccept(policy()), risky, {}).decision).toBe("ask");
    const allowed = policy("ask", [{ id: "allow-echo", effect: "allow", tool: "echo_say" }]);
    expect(judgeToolCall(autoAccept(allowed), risky, {})).toMatchObject({
      decision: "allow",
      rule_id: "allow-echo",
    });
  });

  test("denies without asking and audits the verdict", async () => {
    const audits: Decision[] = [];
    let asks = 0;
    const authorize = createAuthorizer({
      policyFor: () => policy("deny"),
      askPermission: async () => {
        asks++;
        return "allow";
      },
      audit: (_session, _tool, verdict) => audits.push(verdict),
    });

    expect(await authorize("opencode:s1", tool(), {})).toEqual({
      allow: false,
      status: 403,
      error: "denied: default",
    });
    expect(asks).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.decision).toBe("deny");
  });

  test("an ask resolves to the reader's decision", async () => {
    for (const [answer, allowed] of [["allow", true], ["deny", false]] as const) {
      const authorize = createAuthorizer({
        policyFor: () => undefined,
        askPermission: async () => answer,
      });
      const result = await authorize("opencode:s1", tool(), {});
      expect(result.allow).toBe(allowed);
      if (!allowed) expect(result).toEqual({ allow: false, status: 403, error: "permission denied" });
    }
  });
});
