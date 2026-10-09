import { createOpencodeClient, type Event, type OpencodeClient, type Part } from "@opencode-ai/sdk/v2";
import { makeEvent, type ContentBlock, type EventInput } from "@agent-strata/schema";
import { evaluate, type Policy } from "@agent-strata/policy";

export interface Sink {
  append(events: EventInput[]): unknown;
}

export type OnAsk = (
  req: Extract<EventInput, { type: "permission.requested" }>,
) => Promise<{ decision: "allow" | "deny"; scope?: "once" | "always" }>;

export type OnQuestion = (
  req: Extract<EventInput, { type: "question.asked" }>,
) => Promise<{ decision: "reply" | "reject"; answers?: string[][] }>;

const SHELL_PERMS = new Set(["bash", "pwsh", "powershell", "cmd"]);

/** OpenCode's global bus wraps the event, and newer servers put the body in `data`. */
export function normalizeOpencodeEvent(raw: unknown): Event | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  let evt = raw as Record<string, unknown>;
  if (evt.payload && typeof evt.payload === "object") evt = evt.payload as Record<string, unknown>;
  if (evt.data && typeof evt.data === "object" && !evt.properties) {
    evt = { ...evt, properties: evt.data };
  }
  if (typeof evt.type !== "string") return undefined;
  return evt as unknown as Event;
}

function eventSessionID(evt: Event): string | undefined {
  if (!("properties" in evt) || !evt.properties || typeof evt.properties !== "object") return undefined;
  const id = (evt.properties as { sessionID?: unknown }).sessionID;
  return typeof id === "string" ? id : undefined;
}

/** `/global/event` wraps the payload and names the project directory beside it. */
function eventDirectory(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const dir = (raw as { directory?: unknown }).directory;
  return typeof dir === "string" && dir.length > 0 ? dir : undefined;
}

// OpenCode clocks are unix milliseconds. Fixture and synthetic values below
// this are not real instants, so those events keep the ingest clock.
function sourceTime(ms?: number): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms < 1_000_000_000_000) return undefined;
  return new Date(ms).toISOString();
}

// how often a mid-generation assistant snapshot is emitted (part updates can
// fire per-token; the store and SSE fan-out only need periodic snapshots)
const STREAM_SNAPSHOT_MS = 150;

interface MsgState {
  role?: string;
  parentID?: string;
  created?: number;
  completed?: number;
  parts: Map<string, ContentBlock>;
  toolParts: Map<string, { emittedCall: boolean; emittedResult: boolean; order: number }>;
  emittedAssistant: boolean;
  lastStreamAt?: number;
  patchSeen?: Set<string>;
}

interface SessionState {
  sessionID: string;
  casfId: string;
  started: boolean;
  /**
   * We met this session through one of its messages rather than through a
   * session.created, so the started event went out with no clock to put on it.
   * The next session event carries the real one and re-stamps it.
   */
  startedBlind?: boolean;
  updated?: number;
  messages: Map<string, MsgState>;
  pendingUserMsgs: Set<string>;
  /** last title / directory / archive we emitted, so cost-only session.updated stays quiet */
  metaSeen?: boolean;
  title?: string;
  workspace?: string;
  archived?: boolean;
  parent?: string;
}

export class OpencodeMapper {
  sessions = new Map<string, SessionState>();

  constructor(private opts: { directory?: string } = {}) {}

  ev(
    s: SessionState,
    kind: EventInput["type"],
    data: unknown,
    id?: string,
    ts?: string,
  ): EventInput {
    const base = makeEvent({
      session_id: s.casfId,
      source: { backend: "opencode", native_id: s.sessionID },
      type: kind,
      data,
      ...(ts ? { ts } : {}),
    } as EventInput);
    if (id) base.id = id;
    return base;
  }

  private ensureSession(sessionID: string): { s: SessionState; out: EventInput[] } {
    const out: EventInput[] = [];
    let s = this.sessions.get(sessionID);
    if (!s) {
      s = {
        sessionID,
        casfId: `opencode:${sessionID}`,
        started: false,
        messages: new Map(),
        pendingUserMsgs: new Set(),
      };
      this.sessions.set(sessionID, s);
    }
    if (!s.started) {
      s.started = true;
      s.startedBlind = true;
      out.push(
        this.ev(
          s,
          "session.started",
          { workspace: this.opts.directory ?? "unknown" },
          `opencode:${sessionID}:session.started`,
        ),
      );
    } else if (s.startedBlind && s.updated != null) {
      // The store rewrites a stored event's clock when it is handed a source
      // one, so re-sending the same event id with the real time corrects the
      // timestamp connect already wrote, instead of adding a second row. It
      // waits for a real clock rather than taking a second wrong one.
      const at = sourceTime(s.updated);
      if (at) {
        s.startedBlind = false;
        out.push(
          this.ev(
            s,
            "session.started",
            { workspace: this.opts.directory ?? "unknown" },
            `opencode:${sessionID}:session.started`,
            at,
          ),
        );
      }
    }
    return { s, out };
  }

  // session.created records the baseline (and emits only when already archived).
  // session.updated emits when title, directory, or archive actually changes.
  private syncMeta(
    s: SessionState,
    info: {
      title?: string;
      directory?: string;
      parentID?: string;
      time?: { updated?: number; created?: number; archived?: number };
    },
    source: "created" | "updated",
  ): EventInput | undefined {
    const title = info.title;
    const workspace = info.directory;
    const archived = (info.time?.archived ?? 0) > 0;
    const parent = info.parentID ? `opencode:${info.parentID}` : s.parent;
    if (info.time?.updated || info.time?.created) {
      s.updated = info.time.updated ?? info.time.created ?? s.updated;
    }
    const changed =
      !s.metaSeen ||
      s.title !== title ||
      s.workspace !== workspace ||
      s.archived !== archived ||
      (info.parentID !== undefined && s.parent !== parent);
    s.metaSeen = true;
    s.title = title;
    s.workspace = workspace;
    s.archived = archived;
    if (info.parentID) s.parent = parent;
    if (!changed) return;
    if (source === "created" && !archived) return;
    const stamp = info.time?.updated ?? info.time?.archived ?? 0;
    const hash = Bun.hash(
      `${title ?? ""}\0${workspace ?? ""}\0${archived ? 1 : 0}${info.parentID ? `\0${info.parentID}` : ""}`,
    ).toString(36);
    return this.ev(
      s,
      "session.updated",
      {
        title,
        workspace,
        archived,
        ...(parent ? { parent_session_id: parent } : {}),
      },
      `opencode:${s.sessionID}:session.updated:${stamp}:${hash}`,
      sourceTime(info.time?.updated ?? info.time?.archived),
    );
  }

  private ensureMsg(s: SessionState, messageID: string): MsgState {
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

  private flushUser(s: SessionState, out: EventInput[], msgID: string) {
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
        `opencode:${msgID}:turn.user`,
        sourceTime(m.created ?? s.updated),
      ),
    );
  }

  handle(evt: Event): EventInput[] {
    const out: EventInput[] = [];
    const props = "properties" in evt ? evt.properties : undefined;
    const sessionID =
      props && "sessionID" in props ? (props.sessionID as string) : undefined;

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
        const { s, out: pre } = this.ensureSession(p.sessionID);
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
        const meta = this.syncMeta(s, p.info, already ? "updated" : "created");
        if (meta) out.push(meta);
        return out;
      }
      case "session.updated": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        const meta = this.syncMeta(s, p.info, "updated");
        if (meta) out.push(meta);
        return out;
      }
      case "session.deleted": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
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
        const info = evt.properties.info;
        const m = this.ensureMsg(s, info.id);
        m.role = info.role;
        if (info.time?.created) m.created = info.time.created;
        // The SDK types a message's clock as a union — only an assistant
        // message carries `completed` — so this reads it off one shape.
        const clock = info.time as { completed?: number } | undefined;
        if (clock?.completed !== undefined) m.completed = clock.completed;
        if (info.role === "user") {
          s.pendingUserMsgs.add(info.id);
          return out;
        }
        if (info.role === "assistant") {
          m.parentID = info.parentID;
          this.flushUser(s, out, info.parentID);
          if (info.time.completed !== undefined && !m.emittedAssistant) {
            m.emittedAssistant = true;
            const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
            const u = info.tokens;
            out.push(
              this.ev(
                s,
                "turn.assistant",
                {
                  turn_id: info.parentID,
                  msg_id: info.id,
                  content,
                  model: `${info.providerID}/${info.modelID}`,
                  usage: {
                    input: u.input,
                    output: u.output,
                    reasoning: u.reasoning,
                    cache_read: u.cache.read,
                    cache_write: u.cache.write,
                  },
                  cost_usd: info.cost,
                  latency_ms: Math.max(0, Math.round(info.time.completed - info.time.created)),
                  stop_reason: info.finish ?? (info.error ? "error" : undefined),
                },
                `opencode:${info.id}:turn.assistant`,
                sourceTime(info.time.completed ?? info.time.created ?? s.updated),
              ),
            );
          }
        }
        return out;
      }
      case "message.part.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const part: Part = evt.properties.part;
        const m = this.ensureMsg(s, part.messageID);
        if (part.type === "text") {
          m.parts.set(part.id, { type: "text", text: part.text });
        } else if (part.type === "reasoning") {
          m.parts.set(part.id, { type: "thinking", text: part.text });
        } else if (part.type === "file") {
          const path =
            part.source && "path" in part.source ? part.source.path : (part.filename ?? part.url);
          m.parts.set(part.id, { type: "file_ref", path });
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
          const st = part.state;
          if (!t.emittedCall && st.status !== "pending") {
            t.emittedCall = true;
            out.push(
              this.ev(
                s,
                "tool.call",
                {
                  turn_id: m.parentID ?? part.messageID,
                  call_id: part.callID,
                  tool: part.tool,
                  input: st.input,
                  order: t.order,
                },
                `opencode:${part.id}:tool.call`,
                sourceTime(st.time.start || s.updated),
              ),
            );
          }
          if (!t.emittedResult && (st.status === "completed" || st.status === "error")) {
            t.emittedResult = true;
            out.push(
              this.ev(
                s,
                "tool.result",
                {
                  call_id: part.callID,
                  status: st.status === "completed" ? "ok" : "error",
                  output: st.status === "completed" ? st.output : st.error,
                  latency_ms: Math.max(0, Math.round(st.time.end - st.time.start)),
                },
                `opencode:${part.id}:tool.result`,
                sourceTime(st.time.end || s.updated),
              ),
            );
          }
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
        //   snapshot re-emits and the projector overwrites it)
        // — assistant messages emit throttled partial turn.assistant
        //   snapshots so the UI streams during generation
        if (m.role === "user") {
          const content = [...m.parts.values()].filter((b) => b.type !== "thinking");
          if (content.length) {
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
        } else if (m.role === "assistant" && m.parentID && !m.emittedAssistant) {
          const now = Date.now();
          if (now - (m.lastStreamAt ?? 0) >= STREAM_SNAPSHOT_MS) {
            const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
            if (content.length) {
              m.lastStreamAt = now;
              out.push(
                this.ev(
                  s,
                  "turn.assistant",
                  {
                    turn_id: m.parentID,
                    msg_id: part.messageID,
                    partial: true,
                    content,
                  },
                  `opencode:${part.messageID}:assistant.partial:${Bun.hash(JSON.stringify(content)).toString(36)}`,
                  // A streaming snapshot has no clock of its own either. Leaving
                  // it to the ingest clock meant a session replayed on connect
                  // kept one event stamped with the moment we connected, which
                  // was then the newest thing in the session and decided where
                  // the session list put it.
                  sourceTime(m.created ?? s.updated),
                ),
              );
            }
          }
        }
        return out;
      }
      case "session.idle":
      case "session.status": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const idle =
          evt.type === "session.idle" || evt.properties.status.type === "idle";
        if (idle) for (const msgID of [...s.pendingUserMsgs]) this.flushUser(s, out, msgID);
        out.push(
          this.ev(
            s,
            "session.status",
            { state: idle ? "idle" : "busy" },
            `opencode:${sessionID}:status:${evt.id}`,
          ),
        );
        return out;
      }
      case "question.asked": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        out.push(
          this.ev(
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
          ),
        );
        return out;
      }
      case "question.replied": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
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
        const shell = SHELL_PERMS.has(p.permission);
        const input: Record<string, unknown> = { ...p.metadata, patterns: p.patterns };
        if (shell) input.command = p.patterns.join("\n");
        out.push(
          this.ev(
            s,
            "permission.requested",
            {
              request_id: p.id,
              call_id: p.tool?.callID,
              tool: p.permission,
              input,
            },
            `opencode:${p.id}:permission.requested`,
          ),
        );
        return out;
      }
      case "permission.replied": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
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
          .filter((t) => ["pending", "in_progress", "completed"].includes(t.status))
          .map((t) => ({
            content: t.content,
            status: t.status as "pending" | "in_progress" | "completed",
          }));
        out.push(
          this.ev(
            s,
            "plan.updated",
            { entries },
            `opencode:${sessionID}:plan:${Bun.hash(JSON.stringify(entries)).toString(36)}`,
          ),
        );
        return out;
      }
      default:
        return out;
    }
  }
}

export function createIngestor(opts: {
  mapper: OpencodeMapper;
  sink: Sink;
  policy?: Policy | (() => Policy | undefined);
  onAsk?: OnAsk;
  onQuestion?: OnQuestion;
  reply: (requestID: string, reply: "once" | "reject", message?: string) => Promise<unknown>;
  replyQuestion?: (requestID: string, answers: string[][]) => Promise<unknown>;
  rejectQuestion?: (requestID: string) => Promise<unknown>;
}): { handle: (evt: Event) => void } {
  const { mapper, sink } = opts;

  const emit = (evts: EventInput[]) => {
    if (evts.length) sink.append(evts);
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
    const policy =
      typeof opts.policy === "function" ? opts.policy() : opts.policy;
    const d = policy
      ? evaluate(policy, { tool, input })
      : { decision: "ask" as const };
    if (d.decision === "allow") {
      await opts.reply(p.id, "once");
      emitResolved(p.sessionID, {
        request_id: p.id, decision: "allow", by: "policy",
        scope: "once", rule_id: d.rule_id, reason: d.reason,
      });
      return;
    }
    if (d.decision === "deny") {
      await opts.reply(p.id, "reject", d.reason);
      emitResolved(p.sessionID, {
        request_id: p.id, decision: "deny", by: "policy",
        scope: "once", rule_id: d.rule_id, reason: d.reason,
      });
      return;
    }
    if (!opts.onAsk) return;
    const s = mapper.sessions.get(p.sessionID);
    if (!s) return;
    const req = mapper.ev(
      s,
      "permission.requested",
      { request_id: p.id, call_id: p.tool?.callID, tool: p.permission, input },
      `opencode:${p.id}:permission.requested`,
    ) as Extract<EventInput, { type: "permission.requested" }>;
    const ans = await opts.onAsk(req);
    if (ans.decision === "allow") {
      await opts.reply(p.id, "once");
      emitResolved(p.sessionID, {
        request_id: p.id, decision: "allow", by: "user", scope: ans.scope ?? "once",
      });
      return;
    }
    await opts.reply(p.id, "reject");
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
    if (ans.decision === "reply") {
      await opts.replyQuestion(p.id, ans.answers ?? []);
      emitQuestionResolved(p.sessionID, p.id, "reply", ans.answers);
      return;
    }
    await opts.rejectQuestion(p.id);
    emitQuestionResolved(p.sessionID, p.id, "reject");
  };

  return {
    handle(evt: Event) {
      emit(mapper.handle(evt));
      if (evt.type === "permission.asked") {
        void handlePermission(evt).catch((err) =>
          console.error("opencode permission handling error:", err),
        );
      }
      if (evt.type === "question.asked") {
        void handleQuestion(evt).catch((err) =>
          console.error("opencode question handling error:", err),
        );
      }
    },
  };
}

export async function connectOpencode(opts: {
  baseUrl: string;
  directory?: string;
  // HTTP basic auth for `opencode serve --username/--password`
  username?: string;
  password?: string;
  sink: Sink;
  policy?: Policy | (() => Policy | undefined);
  onAsk?: OnAsk;
  onQuestion?: OnQuestion;
  onEvent?: (evt: Event) => void;
  connectTimeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<{
  stop: () => void;
  importSession: (sessionID: string, directory?: string) => Promise<void>;
  createSession: (opts?: { title?: string; directory?: string }) => Promise<{ id: string }>;
  prompt: (
    sessionID: string,
    text: string,
    opts?: {
      model?: { providerID: string; modelID: string };
      agent?: string;
      variant?: string;
      directory?: string;
    },
  ) => Promise<void>;
  listModels: () => Promise<
    { providerID: string; modelID: string; name: string; variants: string[]; context?: number }[]
  >;
  listAgents: () => Promise<{ name: string; mode?: string }[]>;
  listSessions: () => Promise<{ id: string; title: string; directory: string }[]>;
  listWorkspaces: () => Promise<{ id: string; name?: string; directory: string }[]>;
  abort: (sessionID: string, directory?: string) => Promise<void>;
  indexSessions: () => Promise<string[]>;
  refreshSessions: () => Promise<number>;
  updateSession: (
    sessionID: string,
    patch: { title?: string; archived?: boolean },
    directory?: string,
  ) => Promise<void>;
  deleteSession: (sessionID: string, directory?: string) => Promise<void>;
}> {
  const abort = new AbortController();
  // The SDK builds the SSE request with its own internal signal and ignores a
  // caller-provided one. Wrap fetch so stop() truly ends the stream: an
  // in-flight request is aborted via our signal, an already-open response body
  // has its reader cancelled, and any later retried fetch hangs so the
  // abandoned generator goes inert instead of reconnecting forever.
  const rawFetch = opts.fetch ?? globalThis.fetch;
  let openReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortingFetch = async (request: Request): Promise<Response> => {
    if (abort.signal.aborted) return new Promise<Response>(() => {});
    const res = await rawFetch(new Request(request, { signal: abort.signal }));
    if (!res.body) return res;
    const real = res.body.getReader();
    openReader = real;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { done, value } = await real.read();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      },
      cancel() {
        void real.cancel();
      },
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  abort.signal.addEventListener("abort", () => {
    try {
      void openReader?.cancel().catch(() => {});
    } catch {
      // reader may already be released
    }
  });
  const client: OpencodeClient = createOpencodeClient({
    baseUrl: opts.baseUrl,
    directory: opts.directory,
    headers:
      opts.username !== undefined || opts.password !== undefined
        ? {
            Authorization: `Basic ${btoa(`${opts.username ?? ""}:${opts.password ?? ""}`)}`,
          }
        : undefined,
    fetch: abortingFetch as typeof fetch,
  });
  const mapper = new OpencodeMapper({ directory: opts.directory });
  const ingestor = createIngestor({
    mapper,
    sink: opts.sink,
    policy: opts.policy,
    onAsk: opts.onAsk,
    onQuestion: opts.onQuestion,
    reply: async (requestID, r, message) => {
      await client.permission.reply({ requestID, reply: r, message });
    },
    replyQuestion: async (requestID, answers) => {
      await client.question.reply({ requestID, answers, directory: opts.directory });
    },
    rejectQuestion: async (requestID) => {
      await client.question.reject({ requestID, directory: opts.directory });
    },
  });

  const connectTimeout = opts.connectTimeoutMs ?? 10_000;
  // `/event` is one project directory. `/global/event` carries every project,
  // which is what a desktop session list has to follow. A 404 only rejects
  // once the body is read, so probe the global bus and fall back to `/event`.
  let preferGlobal = true;
  const openStream = async () => {
    if (preferGlobal) {
      try {
        return await client.global.event();
      } catch {
        preferGlobal = false;
      }
    }
    return client.event.subscribe();
  };
  const firstEvent = async (
    open: () => Promise<{ stream: AsyncGenerator<unknown> }>,
    timeoutMs: number,
  ) => {
    let opened: { stream: AsyncGenerator<unknown> };
    try {
      opened = await open();
    } catch {
      return undefined;
    }
    const stream = opened.stream;
    const iter = stream[Symbol.asyncIterator]();
    const pending = iter.next();
    pending.catch(() => {});
    const first = await Promise.race([
      pending.then(
        (value) => value,
        () => "error" as const,
      ),
      Bun.sleep(timeoutMs).then(() => "timeout" as const),
    ]);
    if (first === "timeout" || first === "error" || first.done) {
      // return() waits on the in-flight read, which is the thing that timed
      // out, so it must not be awaited. stop()/abort cancels the body.
      void stream.return(undefined).catch(() => {});
      return undefined;
    }
    return { iter, value: first.value };
  };
  let got = await firstEvent(
    () => client.global.event() as Promise<{ stream: AsyncGenerator<unknown> }>,
    Math.min(connectTimeout, 3_000),
  );
  if (!got) {
    preferGlobal = false;
    got = await firstEvent(
      () => client.event.subscribe() as Promise<{ stream: AsyncGenerator<unknown> }>,
      connectTimeout,
    );
  }
  if (!got) {
    abort.abort();
    throw new Error(`opencode event stream produced no events within ${connectTimeout}ms`);
  }
  const importedRevision = new Map<string, number>();
  const importTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const handlePart = (sessionID: string, part: Part) => {
    ingestor.handle({
      id: `import:${part.id}`,
      type: "message.part.updated",
      properties: { sessionID, part, time: Date.now() },
    } as Event);
  };
  const importSession = async (sessionID: string, directory?: string) => {
    const dir = directory ?? opts.directory;
    const sess = await client.session.get({ sessionID, directory: dir });
    if (!sess.data) throw new Error(`session ${sessionID} not found`);
    ingestor.handle({
      id: `import:${sessionID}`,
      type: "session.created",
      properties: { sessionID, info: sess.data },
    } as Event);
    const msgs = await client.session.messages({ sessionID, directory: dir });
    for (const m of msgs.data ?? []) {
      const openAssistant =
        m.info.role === "assistant" && m.info.time?.completed === undefined;
      // parts first: a completed assistant message emits turn.assistant on message.updated
      for (const part of m.parts) handlePart(sessionID, part);
      ingestor.handle({
        id: `import:${m.info.id}`,
        type: "message.updated",
        properties: { sessionID, info: m.info },
      } as Event);
      // role and parent land on message.updated, so an in-progress assistant
      // only streams once the parts are applied a second time
      if (openAssistant) for (const part of m.parts) handlePart(sessionID, part);
    }
  };
  const dispatch = (raw: unknown) => {
    const evt = normalizeOpencodeEvent(raw);
    if (!evt) return;
    ingestor.handle(evt);
    const type = evt.type;
    const sessionID = eventSessionID(evt);
    const directory = eventDirectory(raw);
    if (
      sessionID &&
      (type.startsWith("session.next.") || type === "session.idle" || type === "session.status")
    ) {
      const prev = importTimers.get(sessionID);
      if (prev) clearTimeout(prev);
      importTimers.set(
        sessionID,
        setTimeout(() => {
          importTimers.delete(sessionID);
          importedRevision.delete(sessionID);
          void importSession(sessionID, directory).catch((err) =>
            console.error("import session failed:", err),
          );
        }, 400),
      );
    }
    if (!opts.onEvent) return;
    try {
      opts.onEvent(evt);
    } catch (err) {
      console.error("opencode onEvent error:", err);
    }
  };
  dispatch(got.value);

  const pump = async (iter: AsyncIterator<unknown>) => {
    for (;;) {
      const r = await iter.next();
      if (r.done || abort.signal.aborted) return;
      dispatch(r.value);
    }
  };
  const loop = (async () => {
    let current: AsyncIterator<unknown> = got.iter;
    while (!abort.signal.aborted) {
      try {
        await pump(current);
      } catch (err) {
        if (!abort.signal.aborted) console.error("opencode event stream error:", err);
      }
      if (abort.signal.aborted) return;
      await Bun.sleep(1000);
      if (abort.signal.aborted) return;
      try {
        const again = await openStream();
        current = again.stream[Symbol.asyncIterator]();
      } catch (err) {
        if (!abort.signal.aborted) console.error("opencode event stream reconnect failed:", err);
      }
    }
  })();

  return {
    stop() {
      abort.abort();
      for (const timer of importTimers.values()) clearTimeout(timer);
      importTimers.clear();
      void loop;
    },
    async createSession(sessOpts?: { title?: string; directory?: string }) {
      const r = await client.session.create({
        title: sessOpts?.title,
        directory: sessOpts?.directory ?? opts.directory,
      });
      if (!r.data) throw new Error("session.create returned no data");
      return { id: r.data.id };
    },
    async prompt(sessionID: string, text: string, promptOpts?) {
      await client.session.promptAsync({
        sessionID,
        directory: promptOpts?.directory ?? opts.directory,
        model: promptOpts?.model,
        agent: promptOpts?.agent,
        // server schema accepts `variant` (reasoning effort); SDK types lag
        ...(promptOpts?.variant ? ({ variant: promptOpts.variant } as object) : {}),
        parts: [{ type: "text", text }],
      });
    },
    async listModels() {
      const r = await client.provider.list();
      // `all` is the full provider catalog; `connected` is what actually has
      // credentials — only those are pickable. Each provider's default model
      // sorts first.
      const connected = r.data?.connected;
      const out: { providerID: string; modelID: string; name: string; variants: string[]; context?: number }[] =
        [];
      for (const p of r.data?.all ?? []) {
        if (connected && !connected.includes(p.id)) continue;
        const def = r.data?.default?.[p.id];
        const models = Object.entries(p.models ?? {});
        models.sort(([a], [b]) => (a === def ? -1 : b === def ? 1 : 0));
        for (const [modelID, m] of models) {
          const raw = m as { name?: string; variants?: object; limit?: { context?: number } };
          const context = raw.limit?.context;
          out.push({
            providerID: p.id,
            modelID,
            name: raw.name ?? modelID,
            variants: Object.keys(raw.variants ?? {}),
            ...(typeof context === "number" && context > 0 ? { context } : {}),
          });
        }
      }
      return out;
    },
    async listAgents() {
      const r = await client.app.agents();
      // same cut as the official desktop picker: subagents and hidden builtins stay out
      return (r.data ?? [])
        .filter((a) => a.mode !== "subagent" && a.hidden !== true)
        .map((a) => ({ name: a.name, mode: a.mode }));
    },
    async listSessions() {
      const r = await client.session.list({ directory: opts.directory, roots: true, limit: 80 });
      return (r.data ?? [])
        .filter((s) => !s.parentID)
        .map((s) => ({ id: s.id, title: s.title, directory: s.directory }));
    },
    async listWorkspaces() {
      const r = await client.project.list();
      const out: { id: string; name?: string; directory: string }[] = [];
      for (const project of r.data ?? []) {
        out.push({ id: project.id, name: project.name, directory: project.worktree });
        for (const sandbox of project.sandboxes ?? []) {
          out.push({ id: project.id, name: project.name, directory: sandbox });
        }
      }
      return out;
    },
    async abort(sessionID: string, directory?: string) {
      await client.session.abort({ sessionID, directory: directory ?? opts.directory });
    },
    async updateSession(sessionID: string, patch: { title?: string; archived?: boolean }, directory?: string) {
      const r = await client.session.update({
        sessionID,
        directory: directory ?? opts.directory,
        title: patch.title,
        time: patch.archived ? { archived: Date.now() } : undefined,
      });
      if (r.data) {
        ingestor.handle({
          id: `write:${sessionID}:updated`,
          type: "session.updated",
          properties: { sessionID, info: r.data },
        } as Event);
      }
    },
    async deleteSession(sessionID: string, directory?: string) {
      await client.session.delete({ sessionID, directory: directory ?? opts.directory });
      ingestor.handle({
        id: `write:${sessionID}:deleted`,
        type: "session.deleted",
        properties: {
          sessionID,
          info: {
            id: sessionID,
            directory: directory ?? opts.directory ?? "",
            title: "",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      } as Event);
    },
    async indexSessions() {
      const sessions = await client.session.list({ directory: opts.directory, roots: true, limit: 80 });
      const ids: string[] = [];
      for (const info of sessions.data ?? []) {
        if (info.parentID) continue;
        ingestor.handle({
          id: `index:${info.id}`,
          type: "session.updated",
          properties: { sessionID: info.id, info },
        } as Event);
        ids.push(info.id);
      }
      return ids;
    },
    /**
     * Re-read every project the server knows and pull transcripts that moved
     * since the last sync. Safe to call repeatedly: an unchanged session is
     * not imported again.
     */
    async refreshSessions() {
      const directories = new Set<string | undefined>([opts.directory]);
      try {
        const projects = await client.project.list();
        for (const project of projects.data ?? []) {
          if (project.worktree) directories.add(project.worktree);
          for (const sandbox of project.sandboxes ?? []) directories.add(sandbox);
        }
      } catch (err) {
        console.error("opencode project list failed:", err);
      }
      const seen = new Set<string>();
      let imported = 0;
      for (const directory of directories) {
        let sessions;
        try {
          sessions = await client.session.list({ directory, roots: true, limit: 80 });
        } catch (err) {
          console.error(`opencode session list failed for ${directory ?? "(default)"}:`, err);
          continue;
        }
        for (const info of sessions.data ?? []) {
          if (!info?.id || info.parentID || seen.has(info.id)) continue;
          seen.add(info.id);
          try {
            ingestor.handle({
              id: `sync:${info.id}:${info.time?.updated ?? 0}`,
              type: "session.updated",
              properties: { sessionID: info.id, info },
            } as Event);
            const updated = info.time?.updated ?? info.time?.created ?? 0;
            if (importedRevision.get(info.id) === updated) continue;
            await importSession(info.id, info.directory || directory);
            importedRevision.set(info.id, updated);
            imported += 1;
          } catch (err) {
            console.error(`sync session ${info.id} failed:`, err);
          }
        }
      }
      return imported;
    },
    importSession,
  };
}
