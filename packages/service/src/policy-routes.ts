import { evaluate, loadPolicy } from "@agent-strata/policy";
import type { Store } from "@agent-strata/store";
import type { PolicyRuntime } from "./policy-runtime";

export function policyRoute(
  req: Request,
  path: string,
  deps: {
    runtime: PolicyRuntime;
    store: Store;
    policyFile?: string;
    persist(): void;
    broadcast(payload: unknown): void;
  },
): Promise<Response> | Response | undefined {
  if (path === "/policy" && req.method === "GET") {
    return Response.json({ policy: deps.runtime.shared ?? null, file: deps.policyFile ?? null });
  }

  if (path === "/policy" && req.method === "PUT") {
    return (async () => {
      const body = (await req.json().catch(() => null)) as unknown;
      try {
        deps.runtime.setShared(loadPolicy(body));
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
      deps.persist();
      return Response.json({ ok: true, policy: deps.runtime.shared });
    })();
  }

  if (path === "/policy" && req.method === "DELETE") {
    deps.runtime.setShared(undefined);
    deps.persist();
    return Response.json({ ok: true });
  }

  const sessionPolicyMatch = path.match(/^\/sessions\/([^/]+)\/policy$/);
  if (sessionPolicyMatch) {
    const sessionId = decodeURIComponent(sessionPolicyMatch[1]!);
    const known = deps.store.lastSeq(sessionId) > 0;
    if (req.method === "GET") {
      return Response.json({ mode: deps.runtime.modeOf(sessionId), session_id: sessionId, known });
    }
    if (req.method === "PUT") {
      return (async () => {
        const body = (await req.json().catch(() => null)) as { mode?: string } | null;
        if (body?.mode === "auto") deps.runtime.setMode(sessionId, "auto");
        else if (body?.mode === "inherit" || body?.mode === undefined) {
          deps.runtime.setMode(sessionId, "inherit");
        } else {
          return Response.json({ error: "mode must be auto or inherit" }, { status: 400 });
        }
        deps.broadcast({ type: "session.policy", session_id: sessionId, mode: deps.runtime.modeOf(sessionId) });
        return Response.json({ ok: true, mode: deps.runtime.modeOf(sessionId), session_id: sessionId });
      })();
    }
    if (req.method === "DELETE") {
      deps.runtime.setMode(sessionId, "inherit");
      deps.broadcast({ type: "session.policy", session_id: sessionId, mode: "inherit" });
      return Response.json({ ok: true, mode: "inherit", session_id: sessionId });
    }
  }

  if (path === "/policy/test" && req.method === "POST") {
    return (async () => {
      const body = (await req.json().catch(() => null)) as {
        tool?: string;
        input?: Record<string, unknown>;
        policy?: unknown;
      } | null;
      if (!body?.tool) return Response.json({ error: "tool required" }, { status: 400 });
      let policy = deps.runtime.shared;
      if (body.policy !== undefined) {
        try {
          policy = loadPolicy(body.policy);
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 400 });
        }
      }
      if (!policy) return Response.json({ decision: "ask", reason: "no policy" });
      return Response.json(evaluate(policy, { tool: body.tool, input: body.input ?? {} }));
    })();
  }

  return undefined;
}
