// A plugin that does nothing, on purpose.
//
// It exists to answer one question the acceptance criteria ask: is adding a
// capability still "one package and one line" — or did the platform quietly
// grow a per-capability branch somewhere? Its tools are trivial enough that
// nothing it does can hide a missing piece, and it exercises every surface the
// host offers: a tool with an input, a resource, an event, a private route, a
// hook, and a system prompt.

import type {
  PluginContext,
  PluginManifest,
  ResourceResult,
  StrataPlugin,
  ToolCallRequest,
  ToolCallResult,
} from "@agent-strata/plugin-sdk";

export const manifest: PluginManifest = {
  id: "echo",
  name: "Echo",
  version: "1.0.0",
  description: "A reference plugin: one of each contribution surface, and nothing else.",
  entry: { kind: "builtin" },
  provides: ["tools", "resources", "panel"],
  permissions: {},
  hooks: { beforeTool: ["bash"], systemPrompt: true },
  tools: [
    {
      name: "say",
      description: "Repeat the text back. Used to check that a plugin tool round-trips.",
      input: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      policy: { default: "allow" },
    },
    {
      name: "risky",
      description: "A tool that declares an ask floor, so the floor has something to hold.",
      input: {
        type: "object",
        properties: { why: { type: "string" } },
        required: ["why"],
      },
      policy: { default: "ask", risk: "exec" },
    },
    {
      name: "note",
      description: "Send a progress event and answer, so a reader can see the event arrive.",
      input: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      policy: { default: "allow" },
    },
  ],
  resources: [{ key: "count", mime: "application/json", description: "How many times say ran." }],
  panel: { id: "echo", title: "Echo", kind: "status" },
  ui: { toolRenderers: { say: { kind: "read", icon: "message" } } },
};

export function createEchoPlugin(): StrataPlugin {
  let calls = 0;
  let emit: ((event: { type: string; data?: unknown }) => void) | undefined;

  return {
    async initialize(_ctx: PluginContext) {
      calls = 0;
    },
    onEvent(emitEvent) {
      emit = emitEvent;
    },
    listTools() {
      return manifest.tools.map((t) => ({ name: t.name, description: t.description, input: t.input }));
    },
    async callTool(req: ToolCallRequest): Promise<ToolCallResult> {
      if (req.tool === "say") {
        calls += 1;
        const text = typeof req.input.text === "string" ? req.input.text : "";
        return { output: text };
      }
      if (req.tool === "risky") {
        return { output: "ran", isError: false };
      }
      if (req.tool === "note") {
        const message = typeof req.input.message === "string" ? req.input.message : "";
        emit?.({ type: "note", data: { message, at: Date.now() } });
        return { output: `noted: ${message}` };
      }
      return { output: `echo has no tool "${req.tool}"`, isError: true };
    },
    async readResource(req): Promise<ResourceResult> {
      if (req.key !== "count") throw new Error(`no resource ${req.key}`);
      return { mime: "application/json", body: JSON.stringify({ calls }) };
    },
    async route(req: Request, subpath: string) {
      if (subpath === "/panel/state") {
        return Response.json({ calls, method: req.method });
      }
      return undefined;
    },
    async beforeToolCall(req) {
      // Ordinary calls pass. A shell command literally named "deny" is refused
      // so the hook path has something a test can observe end to end.
      if (req.tool === "bash" && String(req.input.command ?? "").trim() === "deny") {
        return { allow: false, message: "the echo plugin refused this command" };
      }
      return { allow: true };
    },
    async systemPrompt() {
      return "The echo plugin is installed; it has no guidance of its own.";
    },
    async shutdown() {
      calls = 0;
      emit = undefined;
    },
  };
}
