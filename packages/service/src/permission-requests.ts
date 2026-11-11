import { makeEvent, type EventInput } from "@agent-strata/schema";
import type { Store } from "@agent-strata/store";
import type { SessionView } from "@agent-strata/projector";
import type { BackendDriver } from "./driver";

export interface PendingAsk {
  request_id: string;
  session_id: string;
  tool: string;
  input: Record<string, unknown>;
  asked_at: string;
  call_id?: string;
  submitting?: boolean;
  local?: boolean;
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

type PromptDriver = Pick<BackendDriver, "replyPermission" | "replyQuestion" | "rejectQuestion">;
export type AnswerResult = { ok: true } | { ok: false; status: number; error: string };

export class PermissionRequests {
  readonly pendingAsks = new Map<string, PendingAsk>();
  readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly settledAsks = new Map<string, "allow" | "deny">();
  private readonly timeoutMs: number;

  constructor(
    private readonly deps: {
      store: Store;
      sessionView(sessionId: string): SessionView;
      driverFor(sessionId: string): PromptDriver | undefined;
      directoryOf(sessionId: string): string | undefined;
      timeoutMs?: number;
    },
  ) {
    this.timeoutMs = deps.timeoutMs ?? 5 * 60_000;
  }

  readonly onAsk = (
    req: Extract<EventInput, { type: "permission.requested" }>,
    local = false,
  ): Promise<{ decision: "allow" | "deny"; scope?: "once" | "always"; external?: boolean }> => {
    this.deps.store.append([req]);
    const data = req.data;
    const known = this.settledAsks.get(data.request_id);
    if (known || this.pendingAsks.has(data.request_id)) {
      return Promise.resolve({ decision: known ?? "allow", external: true as const });
    }
    return new Promise((resolve) =>
      this.pendingAsks.set(data.request_id, {
        request_id: data.request_id,
        session_id: req.session_id,
        tool: data.tool,
        input: data.input,
        call_id: data.call_id,
        asked_at: req.ts,
        local,
        resolve,
      }),
    );
  };

  readonly onQuestion = (
    req: Extract<EventInput, { type: "question.asked" }>,
  ): Promise<{ decision: "reply" | "reject"; answers?: string[][]; external?: boolean }> => {
    this.deps.store.append([req]);
    const data = req.data;
    return new Promise((resolve) =>
      this.pendingQuestions.set(data.request_id, {
        request_id: data.request_id,
        session_id: req.session_id,
        questions: data.questions,
        asked_at: req.ts,
        resolve,
      }),
    );
  };

  readonly settleAsk = (requestId: string, decision: "allow" | "deny"): void => {
    this.rememberAsk(requestId, decision);
    const ask = this.pendingAsks.get(requestId);
    if (!ask) return;
    this.pendingAsks.delete(requestId);
    ask.resolve({ decision, external: true });
  };

  readonly settleQuestion = (requestId: string): void => {
    const question = this.pendingQuestions.get(requestId);
    if (!question) return;
    this.pendingQuestions.delete(requestId);
    question.resolve({ decision: "reply", external: true });
  };

  pendingQuestionList(limit: number): unknown[] {
    const ids = this.deps.store.listSessions({ limit }).map((summary) => summary.session_id);
    return ids.flatMap((sessionId) =>
      this.deps.sessionView(sessionId).pending_questions.map((question) => ({
        ...question,
        session_id: sessionId,
      })),
    );
  }

  hasPending(sessionId: string): boolean {
    return (
      [...this.pendingAsks.values()].some((ask) => ask.session_id === sessionId) ||
      [...this.pendingQuestions.values()].some((question) => question.session_id === sessionId)
    );
  }

  async askPermission(
    sessionId: string,
    tool: string,
    input: Record<string, unknown>,
  ): Promise<"allow" | "deny"> {
    const requestId = `desktop:${tool}:${crypto.randomUUID()}`;
    const req = makeEvent({
      session_id: sessionId,
      source: { backend: "desktop" },
      type: "permission.requested",
      data: { request_id: requestId, tool, input },
    }) as Extract<EventInput, { type: "permission.requested" }>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
    });
    const answer = await Promise.race([this.onAsk(req, true), timed]);
    if (timer) clearTimeout(timer);
    if (answer === "timeout") {
      this.pendingAsks.delete(requestId);
      this.appendPermissionResolved(sessionId, requestId, "deny", "auto", "timeout");
      return "deny";
    }
    this.appendPermissionResolved(sessionId, requestId, answer.decision, "user");
    return answer.decision;
  }

  async answerPermission(
    requestId: string,
    decision: "allow" | "deny",
    scope?: "once" | "always",
  ): Promise<AnswerResult> {
    const ask = this.pendingAsks.get(requestId);
    if (!ask) return { ok: false, status: 404, error: "no pending ask" };
    if (ask.submitting) {
      return { ok: false, status: 409, error: "permission response is already being submitted" };
    }
    const conn = this.deps.driverFor(ask.session_id);
    if (conn?.replyPermission && !ask.local) {
      ask.submitting = true;
      try {
        const reply = decision === "deny" ? "reject" : scope === "always" ? "always" : "once";
        await conn.replyPermission(ask.request_id, reply, this.deps.directoryOf(ask.session_id));
        this.resolvePermissionLocally(ask.session_id, ask.request_id, decision, scope);
        return { ok: true };
      } catch (error) {
        ask.submitting = false;
        return { ok: false, status: 502, error: String(error) };
      }
    }
    this.pendingAsks.delete(ask.request_id);
    this.rememberAsk(ask.request_id, decision);
    ask.resolve({ decision, scope });
    return { ok: true };
  }

  async answerQuestion(
    requestId: string,
    decision: "reply" | "reject",
    answers?: string[][],
  ): Promise<AnswerResult> {
    const question = this.pendingQuestions.get(requestId);
    if (question) {
      if (question.submitting) {
        return { ok: false, status: 409, error: "question response is already being submitted" };
      }
      const conn = this.deps.driverFor(question.session_id);
      const reply = decision === "reject" ? conn?.rejectQuestion : conn?.replyQuestion;
      if (!conn || !reply) {
        return { ok: false, status: 503, error: "backend cannot answer this question" };
      }
      question.submitting = true;
      try {
        if (decision === "reject") {
          await conn.rejectQuestion!(requestId, this.deps.directoryOf(question.session_id));
        } else {
          await conn.replyQuestion!(requestId, answers ?? [], this.deps.directoryOf(question.session_id));
        }
        this.resolveQuestionLocally(question.session_id, requestId, decision, answers);
        return { ok: true };
      } catch (error) {
        question.submitting = false;
        return { ok: false, status: 502, error: String(error) };
      }
    }
    const sessionId = this.sessionIdOfPendingQuestion(requestId);
    if (!sessionId) return { ok: false, status: 404, error: "no pending question" };
    try {
      await this.replyQuestion(sessionId, requestId, decision, answers);
    } catch (error) {
      return { ok: false, status: 502, error: String(error) };
    }
    this.resolveQuestionLocally(sessionId, requestId, decision, answers);
    return { ok: true };
  }

  private rememberAsk(requestId: string, decision: "allow" | "deny"): void {
    this.settledAsks.set(requestId, decision);
    if (this.settledAsks.size <= 1000) return;
    let extra = this.settledAsks.size - 800;
    for (const key of this.settledAsks.keys()) {
      this.settledAsks.delete(key);
      if (--extra <= 0) break;
    }
  }

  private appendPermissionResolved(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    by: "auto" | "user",
    reason?: "timeout",
  ): void {
    this.deps.store.append([
      makeEvent({
        id: `desktop:${requestId}:permission.resolved`,
        session_id: sessionId,
        source: { backend: "desktop" },
        type: "permission.resolved",
        data: { request_id: requestId, decision, by, reason },
      }) as EventInput,
    ]);
  }

  private resolvePermissionLocally(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    scope?: "once" | "always",
  ): void {
    this.deps.store.append([
      makeEvent({
        id: `opencode:${requestId}:permission.resolved`,
        session_id: sessionId,
        source: { backend: "desktop" },
        type: "permission.resolved",
        data: { request_id: requestId, decision, by: "user", scope: scope ?? "once" },
      }) as EventInput,
    ]);
    this.settleAsk(requestId, decision);
  }

  private sessionIdOfPendingQuestion(requestId: string): string | undefined {
    for (const summary of this.deps.store.listSessions()) {
      const view = this.deps.sessionView(summary.session_id);
      if (view.pending_questions.some((question) => question.request_id === requestId)) {
        return summary.session_id;
      }
    }
    return undefined;
  }

  private async replyQuestion(
    sessionId: string,
    requestId: string,
    decision: "reply" | "reject",
    answers?: string[][],
  ): Promise<void> {
    const conn = this.deps.driverFor(sessionId);
    if (!conn) return;
    const directory = this.deps.directoryOf(sessionId);
    if (decision === "reject") await conn.rejectQuestion?.(requestId, directory);
    else await conn.replyQuestion?.(requestId, answers ?? [], directory);
  }

  private resolveQuestionLocally(
    sessionId: string,
    requestId: string,
    decision: "reply" | "reject",
    answers?: string[][],
  ): void {
    this.deps.store.append([
      makeEvent({
        id: `opencode:${requestId}:question.resolved`,
        session_id: sessionId,
        source: { backend: "desktop" },
        type: "question.resolved",
        data: { request_id: requestId, decision, answers },
      }) as EventInput,
    ]);
    this.settleQuestion(requestId);
  }
}
