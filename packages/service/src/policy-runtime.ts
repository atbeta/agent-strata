import { autoAccept, type Policy } from "@agent-strata/policy";

export type SessionPolicyMode = "auto" | "inherit";

export interface PolicyRuntime {
  readonly shared: Policy | undefined;
  setShared(policy: Policy | undefined): void;
  modeOf(sessionId: string): SessionPolicyMode;
  setMode(sessionId: string, mode: SessionPolicyMode): SessionPolicyMode;
  policyForSession(sessionId: string): Policy | undefined;
  policyForConnection(explicit: Policy | undefined): (sessionId: string) => Policy | undefined;
}

export function createPolicyRuntime(
  initial: Policy | undefined,
  parentOf: (sessionId: string) => string | undefined,
): PolicyRuntime {
  let shared = initial;
  const autoSessions = new Set<string>();

  const autoStance = (sessionId: string): boolean => {
    let id: string | undefined = sessionId;
    for (let hops = 0; id && hops < 8; hops++) {
      if (autoSessions.has(id)) return true;
      id = parentOf(id);
    }
    return false;
  };

  const policyForSession = (sessionId: string): Policy | undefined => {
    if (!autoStance(sessionId)) return shared;
    return autoAccept(shared ?? { version: 1, default: "ask", rules: [] });
  };

  return {
    get shared() {
      return shared;
    },
    setShared(policy) {
      shared = policy;
      // A posture other than "ask" already decides, and clearing the document
      // puts every session back on ask. A temporary switch left set would
      // turn itself back on the moment the document returned to ask.
      if (policy === undefined || policy.default !== "ask") autoSessions.clear();
    },
    modeOf(sessionId) {
      return autoSessions.has(sessionId) ? "auto" : "inherit";
    },
    setMode(sessionId, mode) {
      if (mode === "auto") autoSessions.add(sessionId);
      else autoSessions.delete(sessionId);
      return mode;
    },
    policyForSession,
    policyForConnection(explicit) {
      return (sessionId) => {
        if (!explicit) return policyForSession(sessionId);
        return autoStance(sessionId) ? autoAccept(explicit) : explicit;
      };
    },
  };
}
