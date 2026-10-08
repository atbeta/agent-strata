import { createOpencodeClient, type Event, type OpencodeClient, type Part } from "@opencode-ai/sdk/v2";
import { makeEvent, type ContentBlock, type EventInput } from "@agent-core/schema";
import { evaluate, type Policy } from "@agent-core/policy";

export interface Sink {
  append(events: EventInput[]): unknown;
}

export type OnAsk = (
  req: Extract<EventInput, { type: "permission.requested" }>,
) => Promise<{ decision: "allow" | "deny"; scope?: "once" | "always" }>;

const SHELL_PERMS = new Set(["bash", "pwsh", "powershell", "cmd"]);

interface MsgState {
  role: string;
  parentID?: string;
  userParts: Map<string, ContentBlock>;
  assistantParts: Map<string, ContentBlock>;
  toolParts: Map<string, { emittedCall: boolean; emittedResult: boolean }>;
  emittedAssistant: boolean;
  patchSeen?: Set<string>;
}

interface SessionState {
  sessionID: string;
  casfId: string;
  started: boolean;
  messages: Map<string, MsgState>;
  pendingUserMsgs: Set<string>;
}

export class OpencodeMapper {
  sessions = new Map<string, SessionState>();

  constructor(private opts: { directory?: string } = {}) {}

  ev(s: SessionState, kind: EventInput["type"], data: unknown, id?: string): EventInput {
    const base = makeEvent({
      session_id: s.casfId,
      source: { backend: "opencode", native_id: s.sessionID },
      type: kind,
      data,
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
      out.push(
        this.ev(
          s,
          "session.started",
          { workspace: this.opts.directory ?? "unknown" },
          `opencode:${sessionID}:session.started`,
        ),
      );
    }
    return { s, out };
  }

  private ensureMsg(s: SessionState, messageID: string): MsgState {
    let m = s.messages.get(messageID);
    if (!m) {
      m = {
        role: "assistant",
        userParts: new Map(),
        assistantParts: new Map(),
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
    const content = [...m.userParts.values()];
    if (!content.length) return;
    out.push(
      this.ev(
        s,
        "turn.user",
        { turn_id: msgID, content },
        `opencode:${msgID}:turn.user`,
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
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        // replace lazy started data with real info
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
        );
        if (i >= 0) out[i] = started;
        else out.push(started);
        return out;
      }
      case "message.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const info = evt.properties.info;
        const m = this.ensureMsg(s, info.id);
        m.role = info.role;
        if (info.role === "user") {
          s.pendingUserMsgs.add(info.id);
          return out;
        }
        if (info.role === "assistant") {
          m.parentID = info.parentID;
          this.flushUser(s, out, info.parentID);
          if (info.time.completed !== undefined && !m.emittedAssistant) {
            m.emittedAssistant = true;
            const content = [...m.assistantParts.values()];
            const u = info.tokens;
            out.push(
              this.ev(
                s,
                "turn.assistant",
                {
                  turn_id: info.parentID,
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
        const role = m.role;
        if (part.type === "text") {
          const block: ContentBlock = { type: "text", text: part.text };
          if (role === "user") m.userParts.set(part.id, block);
          else m.assistantParts.set(part.id, block);
          return out;
        }
        if (part.type === "reasoning") {
          m.assistantParts.set(part.id, { type: "thinking", text: part.text });
          return out;
        }
        if (part.type === "file") {
          if (role === "user") {
            const path = part.source && "path" in part.source ? part.source.path : (part.filename ?? part.url);
            m.userParts.set(part.id, { type: "file_ref", path });
          }
          return out;
        }
        if (part.type === "tool") {
          const t =
            m.toolParts.get(part.id) ?? { emittedCall: false, emittedResult: false };
          m.toolParts.set(part.id, t);
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
                },
                `opencode:${part.id}:tool.call`,
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
              ),
            );
          }
          return out;
        }
        if (part.type === "patch") {
          const seen = (m.patchSeen ??= new Set());
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
              ),
            );
          }
          return out;
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
        out.push(this.ev(s, "plan.updated", { entries }));
        return out;
      }
      default:
        return out;
    }
  }
}

export async function connectOpencode(opts: {
  baseUrl: string;
  directory?: string;
  sink: Sink;
  policy?: Policy;
  onAsk?: OnAsk;
  fetch?: typeof fetch;
}): Promise<{ stop: () => void; importSession: (sessionID: string) => Promise<void> }> {
  const client: OpencodeClient = createOpencodeClient({
    baseUrl: opts.baseUrl,
    directory: opts.directory,
    fetch: opts.fetch,
  });
  const mapper = new OpencodeMapper({ directory: opts.directory });
  const { sink } = opts;

  const emit = (evts: EventInput[]) => {
    if (evts.length) sink.append(evts);
  };

  const reply = async (requestID: string, r: "once" | "reject", message?: string) => {
    await client.permission.reply({ requestID, reply: r, message });
  };

  const handlePermission = async (evt: Event) => {
    if (evt.type !== "permission.asked") return;
    const p = evt.properties;
    const shell = SHELL_PERMS.has(p.permission);
    const input: Record<string, unknown> = { ...p.metadata, patterns: p.patterns };
    if (shell) input.command = p.patterns.join("\n");
    const tool = shell ? "bash" : p.permission;
    const d = opts.policy
      ? evaluate(opts.policy, { tool, input })
      : { decision: "ask" as const };
    const s = mapper.sessions.get(p.sessionID);
    if (d.decision === "allow") {
      await reply(p.id, "once");
      emit([
        mapper.ev(s!, "permission.resolved", {
          request_id: p.id,
          decision: "allow",
          by: "policy",
          scope: "once",
          rule_id: d.rule_id,
          reason: d.reason,
        }, `opencode:${p.id}:permission.resolved`),
      ]);
      return;
    }
    if (d.decision === "deny") {
      await reply(p.id, "reject", d.reason);
      emit([
        mapper.ev(s!, "permission.resolved", {
          request_id: p.id,
          decision: "deny",
          by: "policy",
          scope: "once",
          rule_id: d.rule_id,
          reason: d.reason,
        }, `opencode:${p.id}:permission.resolved`),
      ]);
      return;
    }
    if (opts.onAsk) {
      const req = mapper.ev(
        s!,
        "permission.requested",
        { request_id: p.id, call_id: p.tool?.callID, tool: p.permission, input },
        `opencode:${p.id}:permission.requested`,
      ) as Extract<EventInput, { type: "permission.requested" }>;
      const ans = await opts.onAsk(req);
      if (ans.decision === "allow") {
        await reply(p.id, "once");
        emit([
          mapper.ev(s!, "permission.resolved", {
            request_id: p.id,
            decision: "allow",
            by: "user",
            scope: ans.scope ?? "once",
          }, `opencode:${p.id}:permission.resolved`),
        ]);
      } else {
        await reply(p.id, "reject");
        emit([
          mapper.ev(s!, "permission.resolved", {
            request_id: p.id,
            decision: "deny",
            by: "user",
            scope: "once",
          }, `opencode:${p.id}:permission.resolved`),
        ]);
      }
    }
  };

  const { stream } = await client.event.subscribe();
  const abort = new AbortController();
  const loop = (async () => {
    try {
      for await (const evt of stream) {
        if (abort.signal.aborted) break;
        const e = evt as Event;
        emit(mapper.handle(e));
        if (e.type === "permission.asked") await handlePermission(e);
      }
    } catch (err) {
      if (!abort.signal.aborted) console.error("opencode event stream error:", err);
    }
  })();

  return {
    stop() {
      abort.abort();
      void loop;
    },
    async importSession(sessionID: string) {
      const sess = await client.session.get({ sessionID });
      emit(
        mapper.handle({
          id: `import:${sessionID}`,
          type: "session.created",
          properties: { sessionID, info: sess.data! },
        } as Event),
      );
      const msgs = await client.session.messages({ sessionID });
      for (const m of msgs.data ?? []) {
        emit(
          mapper.handle({
            id: `import:${m.info.id}`,
            type: "message.updated",
            properties: { sessionID, info: m.info },
          } as Event),
        );
        for (const part of m.parts) {
          emit(
            mapper.handle({
              id: `import:${part.id}`,
              type: "message.part.updated",
              properties: { sessionID, part, time: Date.now() },
            } as Event),
          );
        }
      }
    },
  };
}
