import { describe, expect, test } from "bun:test";
import type { Policy } from "@agent-strata/policy";
import { createPolicyRuntime } from "../src/policy-runtime";

const policy = (defaultDecision: Policy["default"], rules: Policy["rules"] = []): Policy => ({
  version: 1,
  default: defaultDecision,
  rules,
});

describe("session policy runtime", () => {
  test("auto follows live edits and only the selected session", () => {
    const runtime = createPolicyRuntime(policy("ask"), () => undefined);
    runtime.setMode("opencode:auto", "auto");

    expect(runtime.policyForSession("opencode:auto")?.default).toBe("allow");
    expect(runtime.policyForSession("opencode:other")?.default).toBe("ask");

    runtime.setShared(policy("deny"));
    expect(runtime.policyForSession("opencode:auto")?.default).toBe("deny");
    expect(runtime.setMode("opencode:auto", "inherit")).toBe("inherit");
    expect(runtime.policyForSession("opencode:auto")?.default).toBe("deny");
  });

  test("a child inherits auto within the existing ancestry bound", () => {
    const parents = new Map<string, string>();
    for (let i = 1; i <= 8; i++) parents.set(`s${i - 1}`, `s${i}`);
    const runtime = createPolicyRuntime(policy("ask"), (id) => parents.get(id));
    runtime.setMode("s8", "auto");

    expect(runtime.policyForSession("s7")?.default).toBe("allow");
    expect(runtime.policyForSession("s8")?.default).toBe("allow");
    expect(runtime.policyForSession("s0")?.default).toBe("ask");
  });

  test("explicit deny and ask rules survive auto", () => {
    const runtime = createPolicyRuntime(
      policy("ask", [
        { id: "deny-rm", effect: "deny", tool: "bash", when: { command: { matches: "^rm" } } },
        { id: "ask-publish", effect: "ask", tool: "bash", when: { command: { matches: "publish" } } },
      ]),
      () => undefined,
    );
    runtime.setMode("s1", "auto");
    const effective = runtime.policyForSession("s1")!;

    expect(effective.default).toBe("allow");
    expect(effective.rules.map((rule) => rule.effect)).toEqual(["deny", "ask"]);
  });

  test("a connection policy wins and auto applies to it too", () => {
    const runtime = createPolicyRuntime(policy("deny"), () => undefined);
    const explicit = policy("ask");
    const connection = runtime.policyForConnection(explicit);

    expect(connection("s1")?.default).toBe("ask");
    runtime.setMode("s1", "auto");
    expect(connection("s1")?.default).toBe("allow");
    expect(runtime.policyForConnection(undefined)("s1")?.default).toBe("deny");
  });
});
