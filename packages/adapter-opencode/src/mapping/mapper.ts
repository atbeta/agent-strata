import type { Event } from "@opencode-ai/sdk/v2";
import type { EventInput } from "@agent-strata/schema";
import { sessionDiagnostic, sourceTime } from "./model";
import { permissionRequest, questionRequest } from "./interactions";
import { TurnsRuntime } from "./turns";
import { reconcileIdleSessions } from "./run";

export class OpencodeMapper extends TurnsRuntime {
  /** frames already applied, by `type:id` — see the dedup in `handle` */
  private seenIds = new Set<string>();

  sessionContext(sessionID: string): { casfId: string; workspace?: string } | undefined {
    return this.sessions.get(sessionID);
  }

  interactionEvent(
    sessionID: string,
    kind: EventInput["type"],
    data: unknown,
    id: string,
  ): EventInput | undefined {
    const s = this.sessions.get(sessionID);
    return s ? this.ev(s, kind, data, id) : undefined;
  }

  /**
   * Reconcile what this generation believes against what the backend says.
   *
   * Everything else here infers `busy` from the event stream, which is right
   * most of the time and has one failure mode: a frame that never arrives
   * leaves the inference wrong forever. The store's projection is durable and
   * this ledger is not, so a restart or a fresh connect can start believing a
   * session is running while the backend finished it long ago — and no future
   * event is guaranteed to mention that session again.
   *
   * Called once when a connection opens. Not polled: the cost is a single
   * request, and a session that drifts while the stream is healthy has an event
   * to say so. This is the correction for the gap between connections, which is
   * exactly where the information was lost.
   *
   * Only `idle` is acted on. A `busy` in this answer is not evidence the run is
   * live — the same rule the stream handler follows — and announcing it would
   * put a running dot on a session whose frames are simply late.
   *
   * `stillRunning` is how the store's projection gets a say. Without it this
   * correction could only see the sessions this generation had watched go busy,
   * and the case it exists for — a run cut off by closing the app — is exactly
   * the one where this generation watched nothing. Measured: a session busy at
   * the end of one generation, idle at the start of the next, stayed busy in
   * the projection forever, because the correction skipped it as unknown.
   */
  reconcileIdle(
    idleSessionIDs: Iterable<string>,
    stillRunning?: (casfId: string) => { running: boolean; seq: number; ts?: string } | undefined,
  ): EventInput[] {
    return reconcileIdleSessions(this.sessions, idleSessionIDs, stillRunning, (s, out) => {
      this.closeOpenMessages(s, out, "reconcile");
    }, (s) => this.retireStreaming(s));
  }

  /**
   * Current OpenCode stages a revert on its own event, not on `session.updated`.
   * The boundary is the same fact either way: this message and everything after
   * it is withdrawn until the reader restores it.
   */
  protected revertBoundary(evt: Event): EventInput[] | undefined {
    const type = evt.type as string;
    const staged = type === "session.next.revert.staged" || type === "session.revert.staged";
    const cleared = type === "session.next.revert.cleared" || type === "session.revert.cleared";
    if (!staged && !cleared) return undefined;
    const props =
      "properties" in evt && evt.properties && typeof evt.properties === "object"
        ? (evt.properties as { sessionID?: unknown; revert?: { messageID?: unknown } })
        : undefined;
    const sessionID = typeof props?.sessionID === "string" ? props.sessionID : undefined;
    if (!sessionID) return [];
    const messageID = typeof props?.revert?.messageID === "string" ? props.revert.messageID : undefined;
    if (staged && !messageID) return [];
    const { s, out } = this.ensureSession(sessionID);
    const meta = this.syncMeta(
      s,
      {
        title: s.title,
        directory: s.workspace,
        time: s.archived ? { archived: s.updated ?? Date.now() } : undefined,
        ...(messageID ? { revert: { messageID } } : {}),
      },
      "updated",
    );
    if (meta) out.push(meta);
    return out;
  }

  /**
   * OpenCode deletes the boundary message and everything after it when the
   * next prompt is accepted, one `message.removed` per message. The id is
   * the user turn or the assistant reply.
   */
  protected messageRemoved(evt: Event): EventInput[] | undefined {
    if ((evt.type as string) !== "message.removed") return undefined;
    const props =
      "properties" in evt && evt.properties && typeof evt.properties === "object"
        ? (evt.properties as { sessionID?: unknown; messageID?: unknown })
        : undefined;
    const sessionID = typeof props?.sessionID === "string" ? props.sessionID : undefined;
    const messageID = typeof props?.messageID === "string" ? props.messageID : undefined;
    if (!sessionID || !messageID) return [];
    const { s, out } = this.ensureSession(sessionID);
    out.push(
      this.ev(
        s,
        "message.removed",
        { message_id: messageID },
        `opencode:${messageID}:message.removed`,
      ),
    );
    return out;
  }

  handle(evt: Event): EventInput[] {
    const out: EventInput[] = [];
    /**
     * One frame, once. The same event travels on the global bus and the
     * project bus and they do not keep step: a re-delivered user
     * `message.updated` landing after the turn's idle re-asserts busy and a
     * finished session reads running forever — exactly what a re-delivered
     * idle did to the session's latch before, and what reconnect replay via
     * Last-Event-ID would do to both. `type:` is in the key because OpenCode
     * reuses an envelope id for its `sync` marker; `import:` frames are
     * exempt because a re-import means the data changed.
     */
    if (evt.id && !evt.id.startsWith("import:")) {
      const key = `${evt.type}:${evt.id}`;
      if (this.seenIds.has(key)) return out;
      this.seenIds.add(key);
      if (this.seenIds.size > 8192) {
        this.seenIds.delete(this.seenIds.keys().next().value!);
      }
    }
    const props = "properties" in evt ? evt.properties : undefined;
    const sessionID =
      props && "sessionID" in props ? (props.sessionID as string) : undefined;

    const boundary = this.revertBoundary(evt);
    if (boundary) return boundary;
    const removed = this.messageRemoved(evt);
    if (removed) return removed;

    switch (evt.type) {
      case "session.created": {
        const p = evt.properties;
        // A message can arrive before session.created. That first event already
        // stored session.started under a stable id, so a second started event
        // cannot replace its workspace. Publish the real directory as an update.
        const already = this.sessions.get(p.sessionID)?.started === true;
        // Seeded before ensureSession so that a session we only knew through a
        // message can already be re-stamped by it; after, the clock this event
        // carries would arrive too late for the check that wants it.
        const known = this.sessions.get(p.sessionID);
        if (known) known.updated = p.info.time?.updated ?? p.info.time?.created ?? known.updated;
        const { s, out: pre } = this.ensureSession(
          p.sessionID,
          p.info.time?.updated ?? p.info.time?.created,
        );
        out.push(...pre);
        s.updated = p.info.time?.updated ?? p.info.time?.created ?? s.updated;
        if (!already) {
          const i = out.findIndex((e) => e.type === "session.started");
          const started = this.ev(
            s,
            "session.started",
            {
              workspace: p.info.directory,
              title: p.info.title,
              parent_session_id: p.info.parentID ? `opencode:${p.info.parentID}` : undefined,
            },
            `opencode:${p.sessionID}:session.started`,
            sourceTime(s.updated),
          );
          if (i >= 0) out[i] = started;
          else out.push(started);
        }
        this.syncCompacting(s, out, p.info);
        const meta = this.syncMeta(s, p.info, already ? "updated" : "created");
        if (meta) out.push(meta);
        return out;
      }
      case "session.updated": {
        const p = evt.properties;
        // The metadata crawl that indexes a session carries its clock, so the
        // started event is written with the session's own time the first time
        // we see it. Without that, the row's newest event would be the
        // moment we read the session, and the session would read as freshly
        // active on every start.
        const { s, out: pre } = this.ensureSession(
          p.sessionID,
          p.info.time?.updated ?? p.info.time?.created,
        );
        out.push(...pre);
        this.syncCompacting(s, out, p.info);
        const meta = this.syncMeta(s, p.info, "updated");
        if (meta) out.push(meta);
        return out;
      }
      case "session.error": {
        if (!sessionID) {
          // Skill and plugin failures carry no session — nothing to hang the
          // diagnostic on. Dropping it silently made a broken skill invisible;
          // the log is where a session-less fault can still be found.
          console.error("opencode session error:", sessionDiagnostic(evt.properties.error));
          return out;
        }
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        this.noteSessionError(s, out, evt.properties.error, `opencode:${sessionID}:error:${evt.id}`);
        return out;
      }
      case "session.deleted": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
        out.push(
          this.ev(
            s,
            "session.deleted",
            {},
            `opencode:${p.sessionID}:session.deleted`,
            sourceTime(p.info?.time?.updated),
          ),
        );
        return out;
      }
      case "message.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        return this.messageUpdated(evt, s, out);
      }
      case "message.part.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        return this.messagePartUpdated(evt, s, out);
      }
      case "message.part.delta": {
        return this.messagePartDelta(evt, out);
      }
      case "session.idle":
      case "session.status": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        return this.statusEvent(evt, s, out);
      }
      case "question.asked": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        this.noteWork(s, out, `q:${p.id}`);
        (s.awaiting ??= new Set()).add(p.id);
        out.push(
          this.ev(
            s,
            "question.asked",
            questionRequest(p),
            `opencode:${p.id}:question.asked`,
          ),
        );
        return out;
      }
      case "question.replied": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        s.awaiting?.delete(p.requestID);
        out.push(
          this.ev(
            s,
            "question.resolved",
            { request_id: p.requestID, decision: "reply", answers: p.answers },
            `opencode:${p.requestID}:question.resolved`,
          ),
        );
        return out;
      }
      case "question.rejected": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        s.awaiting?.delete(p.requestID);
        out.push(
          this.ev(
            s,
            "question.resolved",
            { request_id: p.requestID, decision: "reject" },
            `opencode:${p.requestID}:question.resolved`,
          ),
        );
        return out;
      }
      case "permission.asked": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        this.noteWork(s, out, `perm:${p.id}`);
        (s.awaiting ??= new Set()).add(p.id);
        out.push(
          this.ev(
            s,
            "permission.requested",
            permissionRequest(p),
            `opencode:${p.id}:permission.requested`,
          ),
        );
        return out;
      }
      case "permission.replied": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        s.awaiting?.delete(p.requestID);
        out.push(
          this.ev(
            s,
            "permission.resolved",
            {
              request_id: p.requestID,
              decision: p.reply === "reject" ? "deny" : "allow",
              by: "user",
              scope: p.reply === "always" ? "always" : "once",
            },
            `opencode:${p.requestID}:permission.resolved`,
          ),
        );
        return out;
      }
      case "todo.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const entries = evt.properties.todos
          .filter((t) => ["pending", "in_progress", "completed", "cancelled"].includes(t.status))
          .map((t) => ({
            content: t.content,
            status: t.status as "pending" | "in_progress" | "completed" | "cancelled",
          }));
        // The id moves with the list, not with a hash of it — see
        // `planFingerprint`. An unchanged list keeps its id and dedups; a
        // changed one, even back to an earlier shape, gets a fresh id so the
        // store records the return instead of dropping it.
        const fingerprint = JSON.stringify(entries);
        if (s.planFingerprint !== fingerprint) {
          s.planFingerprint = fingerprint;
          s.planSeq = (s.planSeq ?? 0) + 1;
        }
        out.push(
          this.ev(
            s,
            "plan.updated",
            { entries },
            `opencode:${sessionID}:plan:${s.planSeq ?? 0}:${Bun.hash(fingerprint).toString(36)}`,
          ),
        );
        return out;
      }
      default:
        return out;
    }
  }
}
