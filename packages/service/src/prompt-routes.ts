import { PermissionResponse, QuestionResponse } from "@agent-strata/api";
import type { BackendDriver } from "./driver";

type PromptDriver = Pick<BackendDriver, "replyPermission" | "replyQuestion" | "rejectQuestion">;

export interface PendingAsk {
  request_id: string;
  session_id: string;
  tool: string;
  input: Record<string, unknown>;
  asked_at: string;
  call_id?: string;
  submitting?: boolean;
  resolve: (ans: { decision: "allow" | "deny"; scope?: "once" | "always"; external?: boolean }) => void;
}

export interface PendingQuestion {
  request_id: string;
  session_id: string;
  questions: {
    question: string;
    header: string;
    options: { label: string; description: string }[];
    multiple?: boolean;
    custom?: boolean;
  }[];
  asked_at: string;
  submitting?: boolean;
  resolve: (ans: { decision: "reply" | "reject"; answers?: string[][]; external?: boolean }) => void;
}

export function promptRoute(
  req: Request,
  path: string,
  ctx: {
    pendingAsks: Map<string, PendingAsk>;
    pendingQuestions: Map<string, PendingQuestion>;
    driverFor(sessionId: string): PromptDriver | undefined;
    directoryOf(sessionId: string): string | undefined;
    rememberAsk(requestId: string, decision: "allow" | "deny"): void;
    resolvePermissionLocally(
      sessionId: string,
      requestId: string,
      decision: "allow" | "deny",
      scope?: "once" | "always",
    ): void;
    sessionIdOfPendingQuestion(requestId: string): string | undefined;
    replyQuestion(
      sessionId: string,
      requestId: string,
      decision: "reply" | "reject",
      answers?: string[][],
    ): Promise<void>;
    resolveQuestionLocally(
      sessionId: string,
      requestId: string,
      decision: "reply" | "reject",
      answers?: string[][],
    ): void;
  },
): Promise<Response> | Response | undefined {
  if (path === "/permissions" && req.method === "GET") {
    return Response.json({
      pending: [...ctx.pendingAsks.values()].map(({ resolve: _r, submitting: _s, ...p }) => p),
    });
  }

  const permMatch = path.match(/^\/permissions\/([^/]+)\/respond$/);
  if (permMatch && req.method === "POST") {
    return (async () => {
      const ask = ctx.pendingAsks.get(decodeURIComponent(permMatch[1]!));
      if (!ask) return Response.json({ error: "no pending ask" }, { status: 404 });
      const parsed = PermissionResponse.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: "invalid permission response" }, { status: 400 });
      if (ask.submitting) return Response.json({ error: "permission response is already being submitted" }, { status: 409 });
      const { decision, scope } = parsed.data;
      const conn = ctx.driverFor(ask.session_id);
      if (conn?.replyPermission) {
        ask.submitting = true;
        try {
          const reply = decision === "deny" ? "reject" : scope === "always" ? "always" : "once";
          await conn.replyPermission(ask.request_id, reply, ctx.directoryOf(ask.session_id));
          ctx.resolvePermissionLocally(ask.session_id, ask.request_id, decision, scope);
          return Response.json({ ok: true });
        } catch (err) {
          ask.submitting = false;
          return Response.json({ error: String(err) }, { status: 502 });
        }
      }
      ctx.pendingAsks.delete(ask.request_id);
      ctx.rememberAsk(ask.request_id, decision);
      ask.resolve({ decision, scope });
      return Response.json({ ok: true });
    })();
  }

  if (path === "/questions" && req.method === "GET") {
    return undefined;
  }

  const questionMatch = path.match(/^\/questions\/([^/]+)\/respond$/);
  if (!questionMatch || req.method !== "POST") return undefined;
  return (async () => {
    const requestId = decodeURIComponent(questionMatch[1]!);
    const q = ctx.pendingQuestions.get(requestId);
    const parsed = QuestionResponse.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid question response" }, { status: 400 });
    const { decision, answers } = parsed.data;
    if (q) {
      if (q.submitting) return Response.json({ error: "question response is already being submitted" }, { status: 409 });
      const conn = ctx.driverFor(q.session_id);
      const reply = decision === "reject" ? conn?.rejectQuestion : conn?.replyQuestion;
      if (!conn || !reply) return Response.json({ error: "backend cannot answer this question" }, { status: 503 });
      q.submitting = true;
      try {
        if (decision === "reject") await conn.rejectQuestion!(requestId, ctx.directoryOf(q.session_id));
        else await conn.replyQuestion!(requestId, answers ?? [], ctx.directoryOf(q.session_id));
        ctx.resolveQuestionLocally(q.session_id, requestId, decision, answers);
        return Response.json({ ok: true });
      } catch (err) {
        q.submitting = false;
        return Response.json({ error: String(err) }, { status: 502 });
      }
    }
    const sessionId = ctx.sessionIdOfPendingQuestion(requestId);
    if (!sessionId) return Response.json({ error: "no pending question" }, { status: 404 });
    try {
      await ctx.replyQuestion(sessionId, requestId, decision, answers);
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 502 });
    }
    ctx.resolveQuestionLocally(sessionId, requestId, decision, answers);
    return Response.json({ ok: true });
  })();
}
