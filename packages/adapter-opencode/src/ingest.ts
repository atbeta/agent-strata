import type { Event } from "@opencode-ai/sdk/v2";
import { isStreamingSnapshot, type EventInput } from "@agent-strata/schema";
import { evaluate, policyFor, type PolicySource } from "@agent-strata/policy";
import { OPENCODE_MAPPER_VERSION, OpencodeMapper, SHELL_PERMS, STREAM_SNAPSHOT_MS } from "./map";
import type { OnAsk, OnQuestion, Sink } from "./types";

/**
 * Mapped events become store writes. A live frame appends on its own; a snapshot
 * shares one append, so an import is one transaction.
 */

export function createIngestor(opts: {
  mapper: OpencodeMapper;
  sink: Sink;
  policy?: PolicySource;
  onAsk?: OnAsk;
  onQuestion?: OnQuestion;
  /** OpenCode already answered this ask, so the waiting prompt can leave. */
  onSettled?: (requestId: string, decision: "allow" | "deny") => void;
  /** Same for a question answered on another client. */
  onQuestionSettled?: (requestId: string) => void;
  reply: (requestID: string, reply: "once" | "always" | "reject", message?: string, directory?: string) => Promise<unknown>;
  replyQuestion?: (requestID: string, answers: string[][], directory?: string) => Promise<unknown>;
  rejectQuestion?: (requestID: string, directory?: string) => Promise<unknown>;
}): {
  handle: (evt: Event) => void;
  handleBatch: (events: Event[]) => void;
  /** Events the mapper produced outside a stream frame — a reconcile at connect. */
  append: (events: EventInput[]) => void;
  stop: () => void;
} {
  const { mapper, sink } = opts;

  // Set while a snapshot is mapped, so its durable events share one append.
  // A partial still publishes immediately; it is not part of that write.
  let batch: EventInput[] | null = null;
  const emit = (evts: EventInput[]) => {
    const live = evts.filter(isStreamingSnapshot);
    const durable = live.length ? evts.filter((e) => !isStreamingSnapshot(e)) : evts;
    if (durable.length) {
      if (batch) batch.push(...durable);
      else sink.append(durable);
    }
    if (live.length) sink.publish?.(live);
  };

  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  // Deltas pause between steps and stop at the end of a part; the text that
  // arrived inside the last window would otherwise wait for the next event.
  const scheduleFlush = () => {
    if (flushTimer || !mapper.hasHeldStreams()) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      try {
        emit(mapper.flushStreaming());
      } catch (err) {
        console.error("opencode stream flush error:", err);
      }
      scheduleFlush();
    }, STREAM_SNAPSHOT_MS);
  };

  /**
   * Drives the mapper's idle fallback, on its own timer rather than the stream
   * flush above: a turn that ended produces no held stream, so a flush that
   * waits for one would never fire and the session would stay busy forever —
   * which is the state this exists to end. The delay comes from the mapper, so
   * a stalled open message waits out its quiet window instead of the beat.
   */
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let settleArmedAt = 0;
  let settleArmedDelay = 0;
  const scheduleSettle = () => {
    const delay = mapper.settleTimerMs();
    if (delay === undefined) {
      clearTimeout(settleTimer);
      settleTimer = undefined;
      return;
    }
    // A delay that shrank (the open message just completed) must not wait out
    // the long one an earlier state armed; a delay that grew can keep waiting.
    if (settleTimer) {
      const remaining = settleArmedDelay - (Date.now() - settleArmedAt);
      if (delay >= remaining) return;
      clearTimeout(settleTimer);
    }
    settleArmedAt = Date.now();
    settleArmedDelay = delay;
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      try {
        emit(mapper.flushSettles());
      } catch (err) {
        console.error("opencode settle flush error:", err);
      }
      scheduleSettle();
    }, delay);
  };

  const emitResolved = (sessionID: string, data: Record<string, unknown>) => {
    const s = mapper.sessions.get(sessionID);
    if (!s) return;
    emit([
      mapper.ev(s, "permission.resolved", data, `opencode:${data.request_id}:permission.resolved`),
    ]);
  };

  const handlePermission = async (evt: Extract<Event, { type: "permission.asked" }>) => {
    const p = evt.properties;
    const shell = SHELL_PERMS.has(p.permission);
    const input: Record<string, unknown> = { ...p.metadata, patterns: p.patterns };
    if (shell) input.command = p.patterns.join("\n");
    const tool = shell ? "bash" : p.permission;
    const s = mapper.sessions.get(p.sessionID);
    // Asked with the session, not the connection: a reader can leave one
    // session on "stop asking" while the rest of the fleet still asks. Keyed
    // off the mapper's own state so an ask for a session we have not seen still
    // resolves — against the shared policy rather than by asking.
    const policy = policyFor(opts.policy, s?.casfId ?? `opencode:${p.sessionID}`);
    const d = policy
      ? evaluate(policy, { tool, input })
      : { decision: "ask" as const };
    if (d.decision === "allow") {
      await opts.reply(p.id, "once", undefined, s?.workspace);
      emitResolved(p.sessionID, {
        request_id: p.id, decision: "allow", by: "policy",
        scope: "once", rule_id: d.rule_id, reason: d.reason,
      });
      return;
    }
    if (d.decision === "deny") {
      await opts.reply(p.id, "reject", d.reason, s?.workspace);
      emitResolved(p.sessionID, {
        request_id: p.id, decision: "deny", by: "policy",
        scope: "once", rule_id: d.rule_id, reason: d.reason,
      });
      return;
    }
    if (!opts.onAsk) return;
    if (!s) return;
    const req = mapper.ev(
      s,
      "permission.requested",
      { request_id: p.id, call_id: p.tool?.callID, tool: p.permission, input },
      `opencode:${p.id}:permission.requested`,
    ) as Extract<EventInput, { type: "permission.requested" }>;
    const ans = await opts.onAsk(req);
    if (ans.external) return;
    if (ans.decision === "allow") {
      const scope = ans.scope === "always" ? "always" : "once";
      await opts.reply(p.id, scope, undefined, s.workspace);
      emitResolved(p.sessionID, {
        request_id: p.id, decision: "allow", by: "user", scope,
      });
      return;
    }
    await opts.reply(p.id, "reject", undefined, s.workspace);
    emitResolved(p.sessionID, {
      request_id: p.id, decision: "deny", by: "user", scope: "once",
    });
  };

  const emitQuestionResolved = (
    sessionID: string,
    requestID: string,
    decision: "reply" | "reject",
    answers?: string[][],
  ) => {
    const s = mapper.sessions.get(sessionID);
    if (!s) return;
    emit([
      mapper.ev(
        s,
        "question.resolved",
        { request_id: requestID, decision, answers },
        `opencode:${requestID}:question.resolved`,
      ),
    ]);
  };

  const handleQuestion = async (evt: Extract<Event, { type: "question.asked" }>) => {
    if (!opts.onQuestion || !opts.replyQuestion || !opts.rejectQuestion) return;
    const p = evt.properties;
    const s = mapper.sessions.get(p.sessionID);
    if (!s) return;
    const req = mapper.ev(
      s,
      "question.asked",
      {
        request_id: p.id,
        questions: p.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
          multiple: q.multiple,
          custom: q.custom,
        })),
      },
      `opencode:${p.id}:question.asked`,
    ) as Extract<EventInput, { type: "question.asked" }>;
    const ans = await opts.onQuestion(req);
    if (ans.external) return;
    if (ans.decision === "reply") {
      await opts.replyQuestion(p.id, ans.answers ?? [], s.workspace);
      emitQuestionResolved(p.sessionID, p.id, "reply", ans.answers);
      return;
    }
    await opts.rejectQuestion(p.id, s.workspace);
    emitQuestionResolved(p.sessionID, p.id, "reject");
  };

  /**
   * Requests waiting on a user answer, keyed by kind+id. The pending lists
   * are re-polled on every sync, so the same ask would otherwise spawn a
   * fresh handler — and for questions a fresh waiting promise — each round.
   */
  const inflightPrompts = new Set<string>();

  const handle = (evt: Event) => {
    emit(mapper.handle(evt));
    // Unmarked, a session watched from its creation reads as stale to every
    // later sync, which then rebuilds it in the middle of a reply.
    if (evt.type === "session.created" && !evt.id.startsWith("import:")) {
      sink.markMapped?.(`opencode:${evt.properties.sessionID}`, OPENCODE_MAPPER_VERSION);
    }
    scheduleFlush();
    scheduleSettle();
    if (evt.type === "permission.asked") {
      const key = `perm:${evt.properties.id}`;
      if (!inflightPrompts.has(key)) {
        inflightPrompts.add(key);
        void handlePermission(evt).catch((err) =>
          console.error("opencode permission handling error:", err),
        );
      }
    }
    if (evt.type === "permission.replied") {
      inflightPrompts.delete(`perm:${evt.properties.requestID}`);
      const reply = evt.properties.reply;
      opts.onSettled?.(evt.properties.requestID, reply === "reject" ? "deny" : "allow");
    }
    if (evt.type === "question.asked") {
      const key = `q:${evt.properties.id}`;
      if (!inflightPrompts.has(key)) {
        inflightPrompts.add(key);
        void handleQuestion(evt).catch((err) =>
          console.error("opencode question handling error:", err),
        );
      }
    }
    if (evt.type === "question.replied" || evt.type === "question.rejected") {
      inflightPrompts.delete(`q:${evt.properties.requestID}`);
      opts.onQuestionSettled?.(evt.properties.requestID);
    }
  };

  return {
    handle,
    /**
     * Map a whole snapshot, then store its durable events in one append.
     * The mapper still runs in order. A throw keeps whatever was mapped so
     * far: the mapper has already remembered it, and a retry must not drop
     * the rows that match that memory.
     */
    handleBatch(events: Event[]) {
      const buf: EventInput[] = [];
      batch = buf;
      try {
        for (const evt of events) handle(evt);
      } finally {
        batch = null;
        if (buf.length) sink.append(buf);
      }
    },
    // Events the mapper produced outside a stream frame — a reconcile at
    // connect time. Same sink, same batching rules; there is simply no frame
    // to carry them.
    append(events: EventInput[]) {
      emit(events);
    },
    stop() {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      // The settle timer holds a reference to the emitter and to the mapper's
      // pending queue, so leaving it armed keeps a stopped connection's work
      // alive until it fires on its own.
      clearTimeout(settleTimer);
      settleTimer = undefined;
    },
  };
}
