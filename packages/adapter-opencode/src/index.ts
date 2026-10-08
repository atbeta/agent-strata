import { createOpencodeClient, type Event, type OpencodeClient, type Part } from "@opencode-ai/sdk/v2";
import { makeEvent, type ContentBlock, type EventInput } from "@agent-strata/schema";
import { evaluate, type Policy } from "@agent-strata/policy";

export interface Sink {
  append(events: EventInput[]): unknown;
}

export type OnAsk = (
  req: Extract<EventInput, { type: "permission.requested" }>,
) => Promise<{ decision: "allow" | "deny"; scope?: "once" | "always" }>;

const SHELL_PERMS = new Set(["bash", "pwsh", "powershell", "cmd"]);

interface MsgState {
  role?: string;
  parentID?: string;
  parts: Map<string, ContentBlock>;
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
            const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
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
        if (part.type === "text") {
          m.parts.set(part.id, { type: "text", text: part.text });
          return out;
        }
        if (part.type === "reasoning") {
          m.parts.set(part.id, { type: "thinking", text: part.text });
          return out;
        }
        if (part.type === "file") {
          const path =
            part.source && "path" in part.source ? part.source.path : (part.filename ?? part.url);
          m.parts.set(part.id, { type: "file_ref", path });
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
  policy?: Policy;
  onAsk?: OnAsk;
  reply: (requestID: string, reply: "once" | "reject", message?: string) => Promise<unknown>;
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
    const d = opts.policy
      ? evaluate(opts.policy, { tool, input })
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

  return {
    handle(evt: Event) {
      emit(mapper.handle(evt));
      if (evt.type === "permission.asked") {
        void handlePermission(evt).catch((err) =>
          console.error("opencode permission handling error:", err),
        );
      }
    },
  };
}

export async function connectOpencode(opts: {
  baseUrl: string;
  directory?: string;
  sink: Sink;
  policy?: Policy;
  onAsk?: OnAsk;
  onEvent?: (evt: Event) => void;
  connectTimeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<{ stop: () => void; importSession: (sessionID: string) => Promise<void> }> {
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
    fetch: abortingFetch as typeof fetch,
  });
  const mapper = new OpencodeMapper({ directory: opts.directory });
  const ingestor = createIngestor({
    mapper,
    sink: opts.sink,
    policy: opts.policy,
    onAsk: opts.onAsk,
    reply: async (requestID, r, message) => {
      await client.permission.reply({ requestID, reply: r, message });
    },
  });

  const { stream } = await client.event.subscribe();
  // the SDK stream attaches lazily on the first next() pull; pull eagerly and
  // wait for the first event (server.connected) so no later events are missed
  const it = stream[Symbol.asyncIterator]();
  const connectTimeout = opts.connectTimeoutMs ?? 10_000;
  const firstNext = it.next();
  // swallow rejections if the timeout wins the race and the stream then dies
  firstNext.catch(() => {});
  const first = await Promise.race([
    firstNext,
    Bun.sleep(connectTimeout).then(() => "timeout" as const),
  ]);
  if (first === "timeout") {
    abort.abort();
    throw new Error(`opencode event stream produced no events within ${connectTimeout}ms`);
  }
  if (first.done) {
    abort.abort();
    throw new Error("opencode event stream ended before server.connected");
  }
  const dispatch = (evt: Event) => {
    ingestor.handle(evt);
    if (!opts.onEvent) return;
    try {
      opts.onEvent(evt);
    } catch (err) {
      console.error("opencode onEvent error:", err);
    }
  };
  dispatch(first.value as Event);

  const loop = (async () => {
    try {
      for (;;) {
        const r = await it.next();
        if (r.done || abort.signal.aborted) break;
        dispatch(r.value as Event);
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
      ingestor.handle({
        id: `import:${sessionID}`,
        type: "session.created",
        properties: { sessionID, info: sess.data! },
      } as Event);
      const msgs = await client.session.messages({ sessionID });
      for (const m of msgs.data ?? []) {
        // parts first: a completed assistant message emits turn.assistant on message.updated
        for (const part of m.parts) {
          ingestor.handle({
            id: `import:${part.id}`,
            type: "message.part.updated",
            properties: { sessionID, part, time: Date.now() },
          } as Event);
        }
        ingestor.handle({
          id: `import:${m.info.id}`,
          type: "message.updated",
          properties: { sessionID, info: m.info },
        } as Event);
      }
    },
  };
}
