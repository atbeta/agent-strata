import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ContentBlock as AcpContentBlock,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type ToolCallUpdate,
  type Usage,
} from "@agentclientprotocol/sdk";
import { createPatch } from "diff";
import { monotonicFactory } from "ulid";
import { makeEvent, type ContentBlock, type EventInput } from "@agent-strata/schema";
import { evaluate, type Policy } from "@agent-strata/policy";

const ulid = monotonicFactory();

export interface Sink {
  append(events: EventInput[]): unknown;
}

export type OnAsk = (
  req: Extract<EventInput, { type: "permission.requested" }>,
) => Promise<{ decision: "allow" | "deny"; scope?: "once" | "always" }>;

interface TrackedCall {
  tool: string;
  input: Record<string, unknown>;
  emittedCall: boolean;
  emittedResult: boolean;
  emittedFiles: Set<string>;
}

interface SessionState {
  acpSessionId: string;
  casfSessionId: string;
  turnId: string | undefined;
  buffer: ContentBlock[];
  lastCostUsd: number | undefined;
  calls: Map<string, TrackedCall>;
  open: boolean;
}

function toBlock(b: AcpContentBlock): ContentBlock | undefined {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image":
      return { type: "image", mime: b.mimeType, data: b.data };
    case "resource_link":
      return { type: "file_ref", path: b.uri };
    default:
      return undefined;
  }
}

export class AcpRecorder implements Client {
  sessions = new Map<string, SessionState>();

  constructor(
    private opts: {
      agentName: string;
      sink: Sink;
      policy?: Policy | (() => Policy | undefined);
      onAsk?: OnAsk;
    },
  ) {}

  startSession(acpSessionId: string, casfSessionId: string): SessionState {
    const s: SessionState = {
      acpSessionId,
      casfSessionId,
      turnId: undefined,
      buffer: [],
      lastCostUsd: undefined,
      calls: new Map(),
      open: true,
    };
    this.sessions.set(acpSessionId, s);
    return s;
  }

  sessionByCasf(casfSessionId: string): SessionState | undefined {
    return [...this.sessions.values()].find((s) => s.casfSessionId === casfSessionId);
  }

  ev(s: SessionState, kind: EventInput["type"], data: unknown, key?: string): EventInput {
    const src = { backend: "acp", agent: this.opts.agentName, native_id: s.acpSessionId };
    const base = {
      session_id: s.casfSessionId,
      ts: new Date().toISOString(),
      source: src,
      type: kind,
      data,
    } as EventInput;
    if (key) base.id = `acp:${this.opts.agentName}:${s.acpSessionId}:${key}`;
    return base;
  }

  private flush(s: SessionState, final?: { stop_reason?: string; usage?: Usage; cost_usd?: number }) {
    const usage = final?.usage
      ? {
          input: final.usage.inputTokens,
          output: final.usage.outputTokens,
          reasoning: final.usage.thoughtTokens ?? undefined,
          cache_read: final.usage.cachedReadTokens ?? undefined,
          cache_write: final.usage.cachedWriteTokens ?? undefined,
        }
      : undefined;
    if (s.buffer.length === 0 && !final) return;
    if (
      s.buffer.length === 0 &&
      !usage &&
      final?.cost_usd === undefined &&
      !final?.stop_reason
    )
      return;
    const content = s.buffer;
    s.buffer = [];
    this.opts.sink.append([
      this.ev(s, "turn.assistant", {
        turn_id: s.turnId ?? "",
        content,
        usage,
        cost_usd: final?.cost_usd,
        stop_reason: final?.stop_reason,
      }),
    ]);
  }

  endTurn(acpSessionId: string, stopReason?: string, usage?: Usage) {
    const s = this.sessions.get(acpSessionId);
    if (!s) return;
    this.flush(s, { stop_reason: stopReason, usage, cost_usd: s.lastCostUsd });
    s.turnId = undefined;
  }

  endSession(acpSessionId: string, reason: "completed" | "cancelled" | "error", error?: string) {
    const s = this.sessions.get(acpSessionId);
    if (!s || !s.open) return;
    s.open = false;
    this.flush(s);
    this.opts.sink.append([this.ev(s, "session.ended", { reason, error })]);
  }

  private callInput(u: ToolCallUpdate): Record<string, unknown> {
    if (u.rawInput !== null && typeof u.rawInput === "object" && !Array.isArray(u.rawInput)) {
      const input = { ...(u.rawInput as Record<string, unknown>) };
      if (input.title === undefined && u.title) input.title = u.title;
      return input;
    }
    return u.title ? { title: u.title } : {};
  }

  private ensureCall(s: SessionState, u: ToolCallUpdate): TrackedCall {
    let call = s.calls.get(u.toolCallId);
    if (!call) {
      call = {
        tool: "other",
        input: {},
        emittedCall: false,
        emittedResult: false,
        emittedFiles: new Set(),
      };
      s.calls.set(u.toolCallId, call);
    }
    if (u.kind) call.tool = u.kind;
    const input = this.callInput(u);
    if (Object.keys(input).length) call.input = input;
    if (!call.emittedCall) {
      call.emittedCall = true;
      this.opts.sink.append([
        this.ev(
          s,
          "tool.call",
          { turn_id: s.turnId ?? "", call_id: u.toolCallId, tool: call.tool, input: call.input },
          `${u.toolCallId}:tool.call`,
        ),
      ]);
    }
    return call;
  }

  private emitResult(s: SessionState, call: TrackedCall, u: ToolCallUpdate) {
    if (call.emittedResult) return;
    if (u.status !== "completed" && u.status !== "failed") return;
    call.emittedResult = true;
    const texts = (u.content ?? [])
      .filter((c) => c.type === "content")
      .map((c) => (c.type === "content" && c.content.type === "text" ? c.content.text : ""))
      .filter((t) => t.length > 0);
    const output =
      texts.length > 0
        ? texts.join("\n")
        : u.rawOutput !== undefined && u.rawOutput !== null
          ? JSON.stringify(u.rawOutput)
          : undefined;
    this.opts.sink.append([
      this.ev(
        s,
        "tool.result",
        {
          call_id: u.toolCallId,
          status: u.status === "completed" ? "ok" : "error",
          output,
        },
        `${u.toolCallId}:tool.result`,
      ),
    ]);
  }

  private emitDiffs(s: SessionState, call: TrackedCall, u: ToolCallUpdate) {
    for (const c of u.content ?? []) {
      if (c.type !== "diff") continue;
      if (call.emittedFiles.has(c.path)) continue;
      call.emittedFiles.add(c.path);
      this.opts.sink.append([
        this.ev(
          s,
          "file.changed",
          {
            path: c.path,
            change: c.oldText == null ? "add" : "modify",
            diff: createPatch(c.path, c.oldText ?? "", c.newText),
            call_id: u.toolCallId,
            ...(c.oldText == null ? { whole_file: true } : {}),
          },
          `${u.toolCallId}:file:${c.path}`,
        ),
      ]);
    }
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return;
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const raw = toBlock(u.content);
        if (!raw) return;
        const block: ContentBlock =
          u.sessionUpdate === "agent_thought_chunk" && raw.type === "text"
            ? { type: "thinking", text: raw.text }
            : raw;
        const last = s.buffer[s.buffer.length - 1];
        if (
          last &&
          last.type === block.type &&
          (last.type === "text" || last.type === "thinking") &&
          (block.type === "text" || block.type === "thinking")
        ) {
          last.text += block.text;
        } else {
          s.buffer.push(block);
        }
        return;
      }
      case "tool_call": {
        this.flush(s);
        const call = this.ensureCall(s, u);
        this.emitResult(s, call, u);
        this.emitDiffs(s, call, u);
        return;
      }
      case "tool_call_update": {
        const call = this.ensureCall(s, u);
        this.emitResult(s, call, u);
        this.emitDiffs(s, call, u);
        return;
      }
      case "plan":
        this.opts.sink.append([
          this.ev(s, "plan.updated", {
            entries: u.entries.map((e) => ({ content: e.content, status: e.status })),
          }),
        ]);
        return;
      case "usage_update":
        if (u.cost?.currency === "USD") s.lastCostUsd = u.cost.amount;
        return;
      default:
        return;
    }
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return { outcome: { outcome: "cancelled" } };
    this.flush(s);
    const call = this.ensureCall(s, params.toolCall);

    const request_id = ulid();
    const options = params.options.map((o) => o.kind);
    const req = this.ev(s, "permission.requested", {
      request_id,
      call_id: params.toolCall.toolCallId,
      tool: call.tool,
      input: call.input,
      options,
    });
    this.opts.sink.append([req]);

    const resolved = (decision: "allow" | "deny", by: "policy" | "user" | "auto", extra: { rule_id?: string; reason?: string; scope?: "once" | "session" | "always" }) =>
      this.opts.sink.append([
        this.ev(s, "permission.resolved", {
          request_id,
          decision,
          by,
          scope: extra.scope ?? "once",
          rule_id: extra.rule_id,
          reason: extra.reason,
        }),
      ]);

    const pick = (kinds: PermissionOption["kind"][]): PermissionOption | undefined =>
      params.options.find((o) => kinds.includes(o.kind));
    const selected = (o: PermissionOption): RequestPermissionResponse => ({
      outcome: { outcome: "selected", optionId: o.optionId },
    });
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

    const policy = typeof this.opts.policy === "function" ? this.opts.policy() : this.opts.policy;
    const d = policy
      ? evaluate(policy, { tool: call.tool, input: call.input })
      : { decision: "ask" as const };

    if (d.decision === "allow") {
      const opt = pick(["allow_once"]);
      if (!opt) return this.askUser(s, params, req as Extract<EventInput, { type: "permission.requested" }>, resolved, selected, cancelled);
      resolved("allow", "policy", { rule_id: d.rule_id, reason: d.reason });
      return selected(opt);
    }
    if (d.decision === "deny") {
      resolved("deny", "policy", { rule_id: d.rule_id, reason: d.reason });
      const opt = pick(["reject_once"]) ?? pick(["reject_always"]);
      if (opt) return selected(opt);
      return cancelled;
    }
    return this.askUser(s, params, req as Extract<EventInput, { type: "permission.requested" }>, resolved, selected, cancelled);
  }

  private async askUser(
    s: SessionState,
    params: RequestPermissionRequest,
    req: Extract<EventInput, { type: "permission.requested" }>,
    resolved: (decision: "allow" | "deny", by: "policy" | "user" | "auto", extra: { rule_id?: string; reason?: string; scope?: "once" | "session" | "always" }) => unknown,
    selected: (o: PermissionOption) => RequestPermissionResponse,
    cancelled: RequestPermissionResponse,
  ): Promise<RequestPermissionResponse> {
    const request_id = req.data.request_id;
    if (!this.opts.onAsk) {
      resolved("deny", "auto", { reason: "no handler" });
      const opt =
        params.options.find((o) => o.kind === "reject_once") ??
        params.options.find((o) => o.kind === "reject_always");
      return opt ? selected(opt) : cancelled;
    }
    const answer = await this.opts.onAsk(req);
    if (answer.decision === "allow") {
      const scope = answer.scope === "always" ? "always" : "once";
      resolved("allow", "user", { scope });
      const opt =
        scope === "always"
          ? (params.options.find((o) => o.kind === "allow_always") ??
            params.options.find((o) => o.kind === "allow_once"))
          : params.options.find((o) => o.kind === "allow_once");
      return opt ? selected(opt) : cancelled;
    }
    resolved("deny", "user", { scope: answer.scope ?? "once" });
    const opt =
      params.options.find((o) => o.kind === "reject_once") ??
      params.options.find((o) => o.kind === "reject_always");
    return opt ? selected(opt) : cancelled;
  }
}

export async function connectAcpAgent(opts: {
  command: string;
  args?: string[];
  cwd?: string;
  agentName: string;
  sink: Sink;
  policy?: Policy | (() => Policy | undefined);
  onAsk?: OnAsk;
  env?: Record<string, string | undefined>;
}): Promise<{
  newSession: (cwd: string) => Promise<string>;
  prompt: (sessionId: string, text: string) => Promise<PromptResponse>;
  cancel: (sessionId: string) => Promise<void>;
  close: () => Promise<void>;
  recorder: AcpRecorder;
}> {
  const proc = Bun.spawn([opts.command, ...(opts.args ?? [])], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const stdin = proc.stdin;
  const input = new WritableStream<Uint8Array>({
    write: (chunk) => {
      stdin.write(chunk);
      stdin.flush();
    },
    close: () => {
      stdin.end();
    },
  });
  const output = new Response(proc.stdout).body!;

  const recorder = new AcpRecorder({
    agentName: opts.agentName,
    sink: opts.sink,
    policy: opts.policy,
    onAsk: opts.onAsk,
  });
  const conn = new ClientSideConnection(
    () => recorder,
    ndJsonStream(input, output),
  );
  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });

  proc.exited.then((code) => {
    for (const s of recorder.sessions.values()) {
      if (s.open) recorder.endSession(s.acpSessionId, "error", `agent exited (code ${code})`);
    }
  });

  return {
    async newSession(cwd) {
      const res = await conn.newSession({ cwd, mcpServers: [] });
      const acpSessionId = res.sessionId;
      const casfSessionId = `acp:${opts.agentName}:${acpSessionId}`;
      const s = recorder.startSession(acpSessionId, casfSessionId);
      opts.sink.append([
        recorder.ev(s, "session.started", { workspace: cwd }),
      ]);
      return casfSessionId;
    },
    async prompt(sessionId, text) {
      const s = recorder.sessionByCasf(sessionId);
      if (!s) throw new Error(`unknown session ${sessionId}`);
      const turnId = ulid();
      s.turnId = turnId;
      opts.sink.append([
        recorder.ev(s, "turn.user", {
          turn_id: turnId,
          content: [{ type: "text", text }],
        }),
      ]);
      const resp = await conn.prompt({
        sessionId: s.acpSessionId,
        prompt: [{ type: "text", text }],
      });
      recorder.endTurn(s.acpSessionId, resp.stopReason, resp.usage ?? undefined);
      return resp;
    },
    async cancel(sessionId) {
      const s = recorder.sessionByCasf(sessionId);
      if (!s) return;
      await conn.cancel({ sessionId: s.acpSessionId });
    },
    async close() {
      for (const s of recorder.sessions.values()) {
        if (s.open) recorder.endSession(s.acpSessionId, "completed");
      }
      proc.kill();
      await proc.exited;
    },
    recorder,
  };
}
