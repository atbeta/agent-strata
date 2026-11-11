import { evaluate, floorDecision, type Decision, type Policy } from "@agent-strata/policy";
import type { ToolEntry } from "@agent-strata/plugin-sdk";

export type AuthorizationResult = { allow: true } | { allow: false; status: number; error: string };

export function judgeToolCall(
  policy: Policy | undefined,
  tool: ToolEntry,
  input: Record<string, unknown>,
): Decision {
  const base: Decision = policy
    ? evaluate(policy, { tool: tool.name, input, plugin_id: tool.plugin_id })
    : { decision: "ask", reason: "no policy" };
  return floorDecision(base, tool.policy?.default);
}

export function createAuthorizer(deps: {
  policyFor(sessionId: string): Policy | undefined;
  askPermission(
    sessionId: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<"allow" | "deny">;
  audit?(sessionId: string, tool: ToolEntry, verdict: Decision): void;
}) {
  return async (
    sessionId: string,
    tool: ToolEntry,
    input: Record<string, unknown>,
  ): Promise<AuthorizationResult> => {
    const verdict = judgeToolCall(deps.policyFor(sessionId), tool, input);
    deps.audit?.(sessionId, tool, verdict);

    if (verdict.decision === "deny") {
      const why = verdict.reason ? `denied: ${verdict.reason}` : "denied by policy";
      return { allow: false, status: 403, error: why };
    }
    if (verdict.decision === "ask") {
      const decision = await deps.askPermission(sessionId, tool.name, input);
      if (decision === "deny") return { allow: false, status: 403, error: "permission denied" };
    }
    return { allow: true };
  };
}
