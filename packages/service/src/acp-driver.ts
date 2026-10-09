import { connectAcpAgent, type OnAsk } from "@agent-strata/adapter-acp";
import type { Policy } from "@agent-strata/policy";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import type { BackendDriver, BackendSink } from "./driver";

export async function connectAcpDriver(opts: {
  sink: BackendSink;
  command: string;
  args?: string[];
  cwd?: string;
  agentName: string;
  name?: string;
  policy?: () => Policy | undefined;
  onAsk?: OnAsk;
}): Promise<BackendDriver> {
  const agent = await connectAcpAgent({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    agentName: opts.agentName,
    sink: opts.sink,
    policy: opts.policy,
    onAsk: opts.onAsk,
  });
  const prefix = `acp:${opts.agentName}:`;
  const endpoint = `acp://${[opts.command, ...(opts.args ?? [])].join(" ")}`;
  const status = (casfId: string, state: "busy" | "idle") =>
    opts.sink.append([
      makeEvent({
        session_id: casfId,
        source: { backend: "acp", agent: opts.agentName },
        type: "session.status",
        data: { state },
      } as EventInput),
    ]);
  const unsupported = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not supported over ACP`);
  };
  return {
    id: `${prefix}${endpoint}`,
    backend: "acp",
    baseUrl: endpoint,
    name: opts.name ?? opts.agentName,
    directory: opts.cwd,
    capabilities: { prompt: true, abort: true, models: false, agents: false, import: false, manage: false },
    stop: () => {
      void agent.close();
    },
    async createSession(sess) {
      const casfId = await agent.newSession(sess?.directory ?? opts.cwd ?? process.cwd());
      return { casfId, nativeId: casfId.slice(prefix.length) };
    },
    async prompt(nativeId, text) {
      const casfId = prefix + nativeId;
      if (!agent.recorder.sessionByCasf(casfId)) {
        throw new Error("this ACP session belongs to an earlier run of the agent and cannot be continued");
      }
      status(casfId, "busy");
      // ACP's prompt resolves when the turn ends; the HTTP call must not wait for that
      void agent
        .prompt(casfId, text)
        .catch((e) => console.error(`acp prompt ${casfId} failed: ${e}`))
        .finally(() => status(casfId, "idle"));
    },
    abort: (nativeId) => agent.cancel(prefix + nativeId),
    listModels: async () => [],
    listAgents: async () => [],
    listWorkspaces: async () => (opts.cwd ? [{ directory: opts.cwd }] : []),
    indexSessions: async () => [],
    sync: async () => 0,
    rebuild: unsupported("rebuild"),
    importSession: unsupported("import"),
    rename: unsupported("rename"),
    archive: unsupported("archive"),
    deleteSession: unsupported("delete"),
    nativeId: (casfId) => (casfId.startsWith(prefix) ? casfId.slice(prefix.length) : undefined),
  };
}
