// Mock ACP agent: scripted by the first word of the prompt text.
// Runs as a subprocess over stdio ndjson. Logs go to stderr only.
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type PromptResponse,
} from "@agentclientprotocol/sdk";

const input = new WritableStream<Uint8Array>({
  write: (chunk) => {
    process.stdout.write(chunk);
  },
});
const output = new ReadableStream<Uint8Array>({
  start: (ctrl) => {
    process.stdin.on("data", (c: Buffer) => ctrl.enqueue(new Uint8Array(c)));
    process.stdin.on("end", () => ctrl.close());
  },
});

let lastOutcome = "none";
let counter = 0;
const sid = () => `sess-${++counter}`;

async function runTurn(
  conn: AgentSideConnection,
  sessionId: string,
  scenario: string,
): Promise<PromptResponse> {
  const upd = (update: object) =>
    conn.sessionUpdate({ sessionId, update: update as never });
  const text = (t: string) => ({ type: "text", text: t });

  if (scenario === "crash") {
    await upd({ sessionUpdate: "agent_message_chunk", content: text("dying") });
    process.exit(42);
  }

  if (scenario === "basic") {
    await upd({ sessionUpdate: "agent_thought_chunk", content: text("thinking...") });
    await upd({ sessionUpdate: "agent_message_chunk", content: text("part one. ") });
    await upd({ sessionUpdate: "agent_message_chunk", content: text("part two.") });
    const res = await conn.requestPermission({
      sessionId,
      options: [
        { optionId: "a1", name: "Allow once", kind: "allow_once" },
        { optionId: "a2", name: "Allow always", kind: "allow_always" },
        { optionId: "r1", name: "Reject once", kind: "reject_once" },
      ],
      toolCall: {
        toolCallId: "call-1",
        title: "git status",
        kind: "execute",
        rawInput: { command: "git status" },
        status: "pending",
      },
    });
    lastOutcome = res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled";
    await upd({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "git status",
      kind: "execute",
      rawInput: { command: "git status" },
      status: "completed",
      content: [{ type: "content", content: text(`outcome:${lastOutcome}`) }],
    });
    await upd({
      sessionUpdate: "usage_update",
      used: 100,
      size: 1000,
      cost: { amount: 0.0123, currency: "USD" },
    });
    await upd({ sessionUpdate: "agent_message_chunk", content: text("done.") });
    return {
      stopReason: "end_turn",
      usage: { inputTokens: 11, outputTokens: 7, thoughtTokens: 3, cachedReadTokens: 2, cachedWriteTokens: 1, totalTokens: 21 },
    };
  }

  const cmds: Record<string, string> = { deny: "rm -rf /", ask: "npm install" };
  if (scenario === "deny" || scenario === "ask") {
    const command = cmds[scenario];
    const res = await conn.requestPermission({
      sessionId,
      options: [
        { optionId: "a1", name: "Allow once", kind: "allow_once" },
        { optionId: "a2", name: "Allow always", kind: "allow_always" },
        { optionId: "r1", name: "Reject once", kind: "reject_once" },
        { optionId: "r2", name: "Reject always", kind: "reject_always" },
      ],
      toolCall: {
        toolCallId: "call-1",
        title: command!,
        kind: "execute",
        rawInput: { command },
        status: "pending",
      },
    });
    lastOutcome = res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled";
    await upd({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: lastOutcome.startsWith("allow") ? "completed" : "failed",
      content: [{ type: "content", content: text(`outcome:${lastOutcome}`) }],
    });
    return { stopReason: "end_turn" };
  }

  if (scenario === "diff") {
    await upd({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "edit files",
      kind: "edit",
      rawInput: { paths: ["new.ts", "old.ts"] },
      status: "in_progress",
    });
    await upd({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      content: [
        { type: "diff", path: "new.ts", oldText: null, newText: "const a = 1;\n" },
        { type: "diff", path: "old.ts", oldText: "const b = 1;\n", newText: "const b = 2;\n" },
      ],
    });
    return { stopReason: "end_turn" };
  }

  return { stopReason: "end_turn" };
}

const agent: (conn: AgentSideConnection) => Agent = (conn) => ({
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
  },
  async newSession() {
    return { sessionId: sid() };
  },
  async authenticate() {
    return {};
  },
  async prompt(params: { sessionId: string; prompt: { type: string; text?: string }[] }) {
    const scenario = params.prompt[0]?.text ?? "basic";
    return runTurn(conn, params.sessionId, scenario);
  },
  async cancel() {},
});

new AgentSideConnection(agent, ndJsonStream(input, output));
