import type { Event, Part } from "@opencode-ai/sdk/v2";
import type { EventInput, SessionRetry } from "@agent-strata/schema";
import {
  assistantFailure,
  contentTimes,
  type MapperOptions,
  type MsgState,
  pathKey,
  recoveryAction,
  sessionDiagnostic,
  sourceTime,
  STREAM_SNAPSHOT_MS,
  type ToolPart,
  type ToolTrack,
} from "./model";
import {
  adoptSession,
  ensureSessionState,
  makeSessionEvent,
  type SessionState,
  syncSessionMeta,
  type SessionInfo,
} from "./session";
import { fileBlock, fileChangeOf, toolEvents as mapToolEvents } from "./tools";
import {
  markWork as runMarkWork,
  noteRetry as runNoteRetry,
  noteSessionError as runNoteSessionError,
  noteWork as runNoteWork,
  syncCompacting as runSyncCompacting,
} from "./run";

export class TurnsRuntime {
  sessions = new Map<string, SessionState>();
  /** assistant messages with text no snapshot has carried yet, by message id */
  protected held = new Map<string, { s: SessionState; m: MsgState }>();
  constructor(protected opts: MapperOptions = {}) {}

  protected now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A snapshot of a held message, unless the last one went out inside the window. */
  protected streamSnapshot(messageID: string): EventInput | undefined {
    const held = this.held.get(messageID);
    if (!held) return undefined;
    const { s, m } = held;
    if (m.emittedAssistant || !m.parentID) {
      this.held.delete(messageID);
      return undefined;
    }
    const now = this.now();
    if (now - (m.lastStreamAt ?? 0) < STREAM_SNAPSHOT_MS) return undefined;
    this.held.delete(messageID);
    const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
    if (!content.length) return undefined;
    m.lastStreamAt = now;
    return this.ev(
      s,
      "turn.assistant",
      {
        turn_id: m.parentID,
        msg_id: messageID,
        partial: true,
        content,
        ...(m.summary ? { summary: true } : {}),
        ...(m.steps?.size ? { steps: [...m.steps.values()] } : {}),
      },
      `opencode:${messageID}:assistant.partial:${Bun.hash(JSON.stringify(content)).toString(36)}`,
      // A snapshot has no clock of its own; the ingest clock would make it the
      // newest thing in a replayed session and reorder the session list. It is
      // published rather than stored, so it needs a clock to be a well-formed
      // event either way — and here the moment it was taken is the truth.
      sourceTime(m.created ?? s.updated) ?? new Date(this.now()).toISOString(),
    );
  }

  hasHeldStreams(): boolean {
    return this.held.size > 0;
  }

  /** Frames the window held back, for the ones whose window has passed. */
  flushStreaming(): EventInput[] {
    const out: EventInput[] = [];
    for (const messageID of [...this.held.keys()]) {
      const snap = this.streamSnapshot(messageID);
      if (snap) out.push(snap);
    }
    return out;
  }

  protected retireStreaming(s: SessionState): void {
    for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
    for (const m of s.messages.values()) if (m.role === "assistant") m.streamRetired = true;
  }

  /**
   * A message still open when the run is declared over was cut off mid-write:
   * it never produced `time.completed`, so no durable final ever carried it,
   * and the streamed partial — which is published, not stored — vanishes on
   * the next fetch. Closing it here keeps the words it managed and marks the
   * cut (`stop_reason: "interrupted"`) instead of letting the turn end on a
   * reply that is not there.
   *
   * The flag stays soft: a completion that arrives anyway still emits its own
   * final, which replaces this one by msg_id.
   *
   * `reason` is normally "interrupted" — the run's close cut the write off.
   * A close the reader asked for reads as "stopped" instead, so the notice
   * names their action rather than sounding like an accident.
   */
  protected closeOpenMessages(
    s: SessionState,
    out: EventInput[],
    tag: string,
    reason: "interrupted" | "stopped" = "interrupted",
  ): void {
    if (!s.liveMsgs?.size) return;
    for (const [msgID, turnID] of s.liveMsgs) {
      const m = s.messages.get(msgID);
      if (!m || m.emittedAssistant || turnID === undefined) continue;
      m.emittedAssistant = true;
      m.interrupted = true;
      (s.resolvedUsers ??= new Set()).add(turnID);
      out.push(
        this.ev(
          s,
          "turn.assistant",
          {
            turn_id: turnID,
            msg_id: msgID,
            content: [...m.parts.values()].filter((b) => b.type !== "file_ref"),
            stop_reason: reason,
            ...(m.summary ? { summary: true } : {}),
            ...(m.steps?.size ? { steps: [...m.steps.values()] } : {}),
          },
          `opencode:${msgID}:turn.assistant:${tag}`,
        ),
      );
    }
  }

  ev(
    s: SessionState,
    kind: EventInput["type"],
    data: unknown,
    id?: string,
    ts?: string,
  ): EventInput {
    return makeSessionEvent(s, kind, data, id, ts);
  }

  /**
   * The session, and the `session.started` event that introduces it.
   *
   * `clock` is the session's own last-updated time, when the frame that
   * brought us here carries it. It matters more than it looks: the store
   * takes the newest event clock as the session's last activity, so a
   * `session.started` stamped with the moment we read the session makes the
   * session look like it was just used — and a re-index on every start would
   * keep it looking that way, forever, whatever the session's real history
   * says.
   *
   * So the started event carries the session's clock whenever the frame
   * already knows it. When the frame does not — a session met through one of
   * its messages — the event goes out without a clock and is re-stamped when
   * one arrives.
   */
  protected ensureSession(sessionID: string, clock?: number): { s: SessionState; out: EventInput[] } {
    return ensureSessionState(this.sessions, sessionID, this.opts.directory, clock);
  }

  protected adopt(sessionID: string): SessionState {
    return adoptSession(this.sessions, sessionID);
  }

  protected syncMeta(s: SessionState, info: SessionInfo, source: "created" | "updated"): EventInput | undefined {
    return syncSessionMeta(s, info, source);
  }

  protected ensureMsg(s: SessionState, messageID: string): MsgState {
    let m = s.messages.get(messageID);
    if (!m) {
      m = {
        parts: new Map(),
        toolParts: new Map(),
        emittedAssistant: false,
      };
      s.messages.set(messageID, m);
    }
    return m;
  }

  protected flushUser(s: SessionState, out: EventInput[], msgID: string) {
    if (!s.pendingUserMsgs.delete(msgID)) return;
    const m = s.messages.get(msgID);
    if (!m) return;
    const content = [...m.parts.values()].filter((b) => b.type !== "thinking");
    if (!content.length) return;
    out.push(
      this.ev(
        s,
        "turn.user",
        { turn_id: msgID, content },
        // Same id shape as the streaming path, and for the same reason: a
        // fuller snapshot has to be a new event for the store to take it (it
        // never overwrites a row it already holds), and the projector resolves
        // the versions by `turn_id`.
        //
        // The two paths used to differ, and which one spoke depended on arrival
        // order: a part that lands before its message finds `role` unset, so
        // the streaming path stays quiet and this one emits at idle; a part
        // that lands after it lets the streaming path emit instead. One
        // sentence therefore had two possible event ids, and a re-import — a
        // changed revision, a mapper bump — could add the other spelling beside
        // it, because the store dedupes by id.
        `opencode:${msgID}:turn.user:${Bun.hash(JSON.stringify(content)).toString(36)}`,
        sourceTime(m.created ?? s.updated),
      ),
    );
  }

  protected noteWork(s: SessionState, out: EventInput[], key: string): void {
    runNoteWork(s, out, key, this.ev.bind(this));
  }

  protected markWork(s: SessionState): void {
    runMarkWork(s);
  }

  protected noteRetry(s: SessionState, out: EventInput[], retry: SessionRetry, id: string, ts?: string): void {
    runNoteRetry(s, out, retry, id, this.ev.bind(this), ts);
  }

  protected syncCompacting(
    s: SessionState,
    out: EventInput[],
    info: { time?: { compacting?: number; updated?: number } },
  ): void {
    runSyncCompacting(s, out, info, this.ev.bind(this));
  }

  protected noteSessionError(s: SessionState, out: EventInput[], error: unknown, id: string): void {
    for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
    runNoteSessionError(s, out, error, id, this.ev.bind(this), (reason) => {
      this.closeOpenMessages(s, out, "error", reason);
    });
  }

  protected messageUpdated(evt: Extract<Event, { type: "message.updated" }>, s: SessionState, out: EventInput[]): EventInput[] {
    const info = evt.properties.info;
    const m = this.ensureMsg(s, info.id);
    m.role = info.role;
    if (info.time?.created) m.created = info.time.created;
    // The SDK types a message's clock as a union — only an assistant
    // message carries `completed` — so this reads it off one shape.
    const clock = info.time as { completed?: number } | undefined;
    if (clock?.completed !== undefined) m.completed = clock.completed;
    // A message whose turn already resolved is bookkeeping, not work —
    // OpenCode keeps touching it after the run ends (title, tokens,
    // summaries) and each such frame, carried on the slower bus past the
    // turn's idle, would put a finished session back to running.
    const resolved =
      info.role === "user" ? (s.resolvedUsers?.has(info.id) ?? false) : m.emittedAssistant;
    if (info.role === "user") {
      if (!resolved) s.pendingUserMsgs.add(info.id);
      // Queued or running, this message is a turn in flight — and the
      // status frame that would say so may never come, so say it here.
      if (!resolved && !evt.id.startsWith("import:")) this.noteWork(s, out, `msg:${info.id}`);
      return out;
    }
    if (info.role === "assistant") {
      // A summary:true assistant message IS the compaction running — the
      // one live signal post-rewrite servers still send, since nothing
      // writes session.time.compacting anymore.
      if (info.summary === true && !evt.id.startsWith("import:")) {
        if (info.time.completed === undefined && !info.error) {
          if (s.summaryMsg !== info.id) {
            s.summaryMsg = info.id;
            this.markWork(s);
            if (s.compacting === undefined) {
              out.push(
                this.ev(
                  s,
                  "session.status",
                  { state: "compacting" },
                  `opencode:${info.id}:compacting`,
                  sourceTime(info.time.created ?? s.updated),
                ),
              );
            }
          }
        } else if (s.summaryMsg === info.id) {
          s.summaryMsg = undefined;
          // Finished, not failed: the turn resumes, so the state falls back
          // to busy — idle belongs to the usual idle path.
          if (info.time.completed !== undefined && !info.error && s.compacting === undefined) {
            out.push(
              this.ev(
                s,
                "session.status",
                { state: "busy" },
                `opencode:${info.id}:compacted`,
                sourceTime(info.time.completed),
              ),
            );
          }
        }
      }
      if (info.summary === true) m.summary = true;
      if (!resolved && info.time.completed === undefined && !evt.id.startsWith("import:")) {
        this.noteWork(s, out, `msg:${info.id}`);
      }
      m.parentID = info.parentID;
      (s.liveMsgs ??= new Map()).set(info.id, info.parentID);
      this.flushUser(s, out, info.parentID);
      for (const t of m.toolParts.values()) {
        const part = t.deferred;
        if (!part) continue;
        t.deferred = undefined;
        out.push(...this.toolEvents(s, m, part, t));
      }
      if (info.time.completed !== undefined) m.streamRetired = true;
      if (info.time.completed !== undefined && (!m.emittedAssistant || m.interrupted)) {
        m.emittedAssistant = true;
        m.interrupted = undefined;
        if (info.parentID) (s.resolvedUsers ??= new Set()).add(info.parentID);
        this.held.delete(info.id);
        const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
        const failure = assistantFailure(info.error);
        const u = info.tokens;
        // Providers occasionally report a negative count (usually output);
        // CASF keeps usage non-negative, and clamping here beats dropping
        // the whole turn on a schema rejection.
        const count = (n: number | undefined) =>
          n === undefined ? undefined : Math.max(0, Math.round(n));
        out.push(
          this.ev(
            s,
            "turn.assistant",
            {
              turn_id: info.parentID,
              msg_id: info.id,
              content,
              model: `${info.providerID}/${info.modelID}`,
              agent: info.agent,
              variant: info.variant,
              usage: {
                input: count(u.input) ?? 0,
                output: count(u.output) ?? 0,
                reasoning: count(u.reasoning),
                cache_read: count(u.cache.read),
                cache_write: count(u.cache.write),
              },
              cost_usd: info.cost,
              latency_ms: Math.max(0, Math.round(info.time.completed - info.time.created)),
              stop_reason: info.finish ?? (failure ? "error" : undefined),
              ...(failure ? { error: failure } : {}),
              ...(info.summary === true ? { summary: true } : {}),
              ...(m.steps?.size ? { steps: [...m.steps.values()] } : {}),
              // The answer in the caller's schema, when the format asked
              // for a json_schema reply. `null` is a valid answer too.
              ...(info.structured !== undefined ? { structured: info.structured } : {}),
            },
            `opencode:${info.id}:turn.assistant`,
            sourceTime(info.time.completed ?? info.time.created ?? s.updated),
          ),
        );
      }
      if (info.time.completed !== undefined) {
        s.liveMsgs?.delete(info.id);
      }
    }
    return out;
  }

  protected messagePartUpdated(evt: Extract<Event, { type: "message.part.updated" }>, s: SessionState, out: EventInput[]): EventInput[] {
    const part: Part = evt.properties.part;
    const m = this.ensureMsg(s, part.messageID);
    const streamContent = part.type === "text" || part.type === "reasoning" || part.type === "file" || part.type === "subtask";
    // Idle stops publishing partials. A part already on the message stays
    // as it was. A part that has not arrived yet is the reply itself:
    // dropping it leaves the durable final — built from these parts —
    // empty when idle wins the race against the first content.
    const retiredContent = m.role === "assistant" && m.streamRetired === true && streamContent;
    if (retiredContent && m.parts.has(part.id) && !m.lateParts?.has(part.id)) return out;
    if (retiredContent) (m.lateParts ??= new Set()).add(part.id);
    // An import read mid-reply carries an open part as OpenCode last stored
    // it, which can be older than the deltas already applied; and deltas
    // still in flight would land on top of anything newer. A closed part
    // carries its final text.
    const stale =
      evt.id.startsWith("import:") &&
      !m.emittedAssistant &&
      !!m.streamed?.has(part.id) &&
      (part.type === "text" || part.type === "reasoning") &&
      part.time?.end === undefined;
    if (stale) {
      // keep the delta-built text
    } else if (part.type === "text") {
      // Text OpenCode writes itself (a read file's contents, "continue"
      // nudges). An import replays parts before their message, so the role
      // is unknown here and the rule applies to every message.
      if (part.synthetic || part.ignored) m.parts.delete(part.id);
      else m.parts.set(part.id, { type: "text", text: part.text, ...contentTimes(part.time) });
    } else if (part.type === "reasoning") {
      m.parts.set(part.id, { type: "thinking", text: part.text, ...contentTimes(part.time) });
    } else if (part.type === "file") {
      m.parts.set(part.id, fileBlock(part));
    } else if (part.type === "subtask") {
      // A subagent session's opening message is nothing else: the prompt
      // the task was given. Without the block the turn echoes empty.
      m.parts.set(part.id, {
        type: "subtask",
        prompt: part.prompt,
        description: part.description,
        agent: part.agent,
      });
    } else if (part.type === "step-finish") {
      // Detail for the trace, not content — the message's own usage and
      // cost already carry the sum.
      const t = part.tokens;
      const clamp = (n: number | undefined) =>
        n === undefined ? undefined : Math.max(0, Math.round(n));
      (m.steps ??= new Map()).set(part.id, {
        reason: part.reason,
        usage: {
          input: clamp(t.input) ?? 0,
          output: clamp(t.output) ?? 0,
          reasoning: clamp(t.reasoning),
          cache_read: clamp(t.cache.read),
          cache_write: clamp(t.cache.write),
        },
        cost_usd: Math.max(0, part.cost),
      });
      return out;
    } else if (part.type === "step-start" || part.type === "snapshot" || part.type === "agent") {
      // step-start and snapshot mark bookkeeping the transcript never
      // shows; an agent part restates the "@name" the message's text
      // already carries.
      return out;
    } else if (part.type === "tool") {
      // Parts are created in the order the model declared them, so first
      // sight is the declaration order. tool.call is not emitted until the
      // part leaves `pending`, which for parallel calls is the order they
      // actually started — record the ordinal so readers can restore the
      // order the model wrote.
      let t = m.toolParts.get(part.id);
      if (!t) {
        t = { emittedCall: false, emittedResult: false, order: m.toolParts.size };
        m.toolParts.set(part.id, t);
      }
      if (part.state.status === "completed") {
        const change = fileChangeOf(part.tool, part.state.input, part.state.metadata);
        if (change) (m.editedPaths ??= new Set()).add(pathKey(change.path));
      }
      // A call belongs to the user turn its message answers, and only
      // message.updated names that turn. A stored session replays parts
      // before their message, so the call waits for it.
      if (m.parentID === undefined) {
        t.deferred = part;
        return out;
      }
      out.push(...this.toolEvents(s, m, part, t));
      return out;
    }
    if (part.type === "retry") {
      // A stored retry is history, not proof the session is still waiting.
      if (evt.id.startsWith("import:") || s.retryAttempt === part.attempt) return out;
      const error = sessionDiagnostic(part.error);
      this.noteRetry(
        s,
        out,
        { attempt: part.attempt, message: error.message, error },
        `opencode:${part.id}:retry`,
        sourceTime(part.time.created),
      );
      return out;
    }
    if (part.type === "compaction") {
      const seen = (m.compactionSeen ??= new Set());
      if (seen.has(part.id)) return out;
      seen.add(part.id);
      // Same hole as the patch part below: a compaction carries no clock,
      // so emitting without one stamped it with ingest time — sessions that
      // only re-connected looked freshly active in the list.
      out.push(
        this.ev(
          s,
          "session.compacted",
          {
            message_id: part.messageID,
            auto: part.auto,
            // `overflow` says the trigger was a context-overflow error
            // rather than the size threshold.
            ...(part.overflow === true ? { overflow: true } : {}),
          },
          `opencode:${part.id}:compaction`,
          sourceTime(m.created ?? m.completed ?? s.updated),
        ),
      );
      return out;
    }
    if (part.type === "patch") {
      const seen = (m.patchSeen ??= new Set());
      // A patch part carries no clock of its own, and emitting without one
      // hands the store the ingest clock — so replaying a session on every
      // connect stamped all of its history with the moment we connected,
      // and the session list sorted by that instead of by when the agent
      // last worked. The message this part belongs to does carry one, and
      // the edits land as it finishes.
      const at = sourceTime(m.completed ?? m.created ?? s.updated);
      for (const f of part.files) {
        const key = `${part.id}:${f}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (m.editedPaths?.has(pathKey(f))) continue;
        out.push(
          this.ev(
            s,
            "file.changed",
            { path: f, change: "modify" },
            `opencode:${part.id}:file:${f}`,
            at,
          ),
        );
      }
      return out;
    }
    // shared tail for content parts (text/reasoning/file):
    // — user messages emit turn.user as soon as text lands so the prompt
    //   echoes instantly (id is a content hash: a later, fuller part
    //   snapshot re-emits and the projector overwrites it). The store
    //   keeps every version, so content with images waits for flushUser
    //   and goes out once, whole, under the message's stable id.
    // — assistant messages emit throttled partial turn.assistant
    //   snapshots so the UI streams during generation
    if (m.role === "user") {
      const content = [...m.parts.values()].filter((b) => b.type !== "thinking");
      if (content.some((b) => b.type === "image")) {
        s.pendingUserMsgs.add(part.messageID);
      } else if (content.length) {
        s.pendingUserMsgs.delete(part.messageID);
        out.push(
          this.ev(
            s,
            "turn.user",
            { turn_id: part.messageID, content },
            `opencode:${part.messageID}:turn.user:${Bun.hash(JSON.stringify(content)).toString(36)}`,
            sourceTime(m.created ?? s.updated),
          ),
        );
      }
    } else if (m.role === "assistant" && m.parentID && !m.emittedAssistant && !m.streamRetired) {
      this.held.set(part.messageID, { s, m });
      const snap = this.streamSnapshot(part.messageID);
      if (snap) out.push(snap);
    }
    return out;
  }

  protected messagePartDelta(evt: Extract<Event, { type: "message.part.delta" }>, out: EventInput[]): EventInput[] {
    const p = evt.properties;
    if (p.field !== "text") return out;
    const s = this.sessions.get(p.sessionID);
    const m = s?.messages.get(p.messageID);
    const block = m?.parts.get(p.partID);
    // A delta extends a part already held. One for a part never seen (the
    // stream joined mid-message) waits for that part's next full update.
    if (!s || !m || !block || (block.type !== "text" && block.type !== "thinking")) return out;
    // A delta after retirement only extends a part that itself arrived
    // late. One that was already stored is the reply we kept; extending
    // it would rewrite that reply without a partial to show for it.
    const extendRetired = m.role === "assistant" && m.streamRetired === true;
    if (extendRetired && !m.lateParts?.has(p.partID)) return out;
    m.parts.set(p.partID, { ...block, text: block.text + p.delta });
    (m.streamed ??= new Set()).add(p.partID);
    if (extendRetired) return out;
    if (m.role === "assistant" && m.parentID && !m.emittedAssistant) {
      this.held.set(p.messageID, { s, m });
      const snap = this.streamSnapshot(p.messageID);
      if (snap) out.push(snap);
    }
    return out;
  }

  protected statusEvent(evt: Extract<Event, { type: "session.idle" | "session.status" }>, s: SessionState, out: EventInput[]): EventInput[] {
    const status = evt.type === "session.status" ? evt.properties.status : undefined;
    if (status?.type === "retry") {
      if (!Number.isInteger(status.attempt) || status.attempt < 0) return out;
      const action = recoveryAction(status.action);
      this.noteRetry(
        s,
        out,
        {
          attempt: status.attempt,
          message: status.message,
          ...(Number.isFinite(status.next) ? { next: status.next } : {}),
          ...(action ? { action } : {}),
        },
        `opencode:${s.sessionID}:status:${evt.id}`,
      );
      return out;
    }
    // A busy frame retires a pending retry — work resumed. It says nothing
    // about compaction, though: the summarising call runs inside the same
    // busy span, so mid-compaction busy frames are noise, not an end.
    if (status?.type === "busy" && s.retryKey !== undefined) {
      s.retryKey = undefined;
      s.retryAttempt = undefined;
      s.retryError = undefined;
      out.push(
        this.ev(s, "session.status", { state: "busy" }, `opencode:${s.sessionID}:status:${evt.id}`),
      );
      return out;
    }
    const idle = evt.type === "session.idle" || status?.type === "idle";
    /**
     * The two directions of a status frame are not worth the same. A busy
     * claim is never evidence: measured on a live server, the slower bus
     * keeps carrying `busy` about a run that already ended, and a queued
     * turn announces itself soon enough through its own messages. The
     * ledger — a user message in flight, an assistant message still open,
     * a tool still running — is what says a session is working.
     *
     * Idle is different: a run the backend says is over is over, even
     * while the ledger still holds a message it never finished. It is the
     * authoritative close for the abort and error paths that complete
     * nothing.
     */
    if (!idle) return out;
    const sawBusyHere = s.sawBusy;
    // Idle closes every open turn. A user message whose turn resolved —
    // or never produced one — keeps getting bookkeeping frames after
    // (title, tokens, summaries), and each would read as a new run.
    // Text parts take a message off pending the moment they land, so
    // resolved has to come from the message ledger, not the queue.
    for (const [msgID, m2] of s.messages) {
      if (m2.role === "user") (s.resolvedUsers ??= new Set()).add(msgID);
    }
    for (const msgID of [...s.pendingUserMsgs]) this.flushUser(s, out, msgID);
    // Stop publishing partials. Parts that have not arrived yet are still
    // stored, so the completion that follows can carry them.
    this.retireStreaming(s);
    s.sawBusy = false;
    s.retryKey = undefined;
    s.retryAttempt = undefined;
    s.retryError = undefined;
    s.compacting = undefined;
    s.summaryMsg = undefined;
    s.awaiting = undefined;
    this.closeOpenMessages(s, out, "idle");
    s.liveMsgs?.clear();
    // The backend re-issues idle under fresh ids — a status-idle and a
    // session.idle for one transition, again on reconnect. Only the
    // busy→idle edge is a state worth announcing.
    //
    // Except once per generation. `sawBusy` is memory, and the store's
    // `busy` is not: a restart or a fresh connect starts with an empty
    // ledger while the projection still says running from a generation
    // that is gone. Refusing the backend's idle because *this* generation
    // never saw the busy left that stale flag with nothing able to clear
    // it — the session read as running forever, and a stop went through
    // the same guard and changed nothing.
    //
    // So the first idle a generation hears is always announced; after
    // that the busy→idle edge alone decides, and the duplicate frames a
    // reconnect re-delivers stay quiet.
    if (!sawBusyHere && s.emittedIdle) return out;
    s.emittedIdle = true;
    out.push(
      this.ev(
        s,
        "session.status",
        { state: "idle" },
        `opencode:${s.sessionID}:status:${evt.id}`,
      ),
    );
    return out;
  }

  protected toolEvents(s: SessionState, m: MsgState, part: ToolPart, t: ToolTrack): EventInput[] {
    return mapToolEvents(s, m, part, t, this.ev.bind(this), this.opts.spill);
  }

}
