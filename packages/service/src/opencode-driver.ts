import {
  connectOpencode,
  OPENCODE_MAPPER_VERSION,
  type OnAsk,
  type OnQuestion,
  type Sink,
} from "@agent-strata/adapter-opencode";
import type { Policy } from "@agent-strata/policy";
import type { BackendDriver } from "./driver";
import { opencodeExtension } from "./opencode-extension";
import { toOpencodeParts, type OpencodeFilePart } from "./opencode-parts";

const PREFIX = "opencode:";

export async function connectOpencodeDriver(opts: {
  sink: Sink;
  baseUrl: string;
  name?: string;
  directory?: string;
  username?: string;
  password?: string;
  policy?: Policy | (() => Policy | undefined);
  connectTimeoutMs?: number;
  onAsk?: OnAsk;
  onQuestion?: OnQuestion;
  onSettled?: (requestId: string, decision: "allow" | "deny") => void;
}): Promise<BackendDriver> {
  let syncing: Promise<number> | undefined;
  const conn = await connectOpencode({
    baseUrl: opts.baseUrl,
    directory: opts.directory,
    username: opts.username,
    password: opts.password,
    sink: opts.sink,
    policy: opts.policy,
    connectTimeoutMs: opts.connectTimeoutMs,
    onAsk: opts.onAsk,
    onQuestion: opts.onQuestion,
    onSettled: opts.onSettled,
  });
  const id = `${PREFIX}${opts.baseUrl}`;
  return {
    id,
    backend: "opencode",
    agent: "opencode",
    baseUrl: opts.baseUrl,
    name: opts.name,
    directory: opts.directory,
    mapperVersion: OPENCODE_MAPPER_VERSION,
    capabilities: {
      prompt: true,
      abort: true,
      models: true,
      agents: true,
      import: true,
      manage: true,
      commands: true,
      attachments: true,
      revert: true,
      fork: true,
      summarize: true,
    },
    extension: opencodeExtension({
      baseUrl: opts.baseUrl,
      directory: opts.directory,
      username: opts.username,
      password: opts.password,
    }),
    stop: () => conn.stop(),
    async createSession(sess) {
      const created = await conn.createSession(sess);
      return { casfId: `${PREFIX}${created.id}`, nativeId: created.id };
    },
    prompt: (nativeId, parts, promptOpts) =>
      conn.prompt(nativeId, toOpencodeParts(parts, promptOpts?.directory ?? opts.directory), promptOpts),
    command: (nativeId, name, args, c) =>
      conn.command(nativeId, {
        command: name,
        arguments: args,
        agent: c?.agent,
        model: c?.model,
        variant: c?.variant,
        directory: c?.directory ?? opts.directory,
        parts: c?.parts
          ? toOpencodeParts(c.parts, c.directory ?? opts.directory).filter(
              (p): p is OpencodeFilePart => p.type === "file",
            )
          : undefined,
      }),
    abort: (nativeId, directory) => conn.abort(nativeId, directory),
    mcpConnect: (name, directory) => conn.mcpConnect(name, directory),
    mcpDisconnect: (name, directory) => conn.mcpDisconnect(name, directory),
    mcpAdd: (name, config, directory) => conn.mcpAdd(name, config, directory),
    mcpAuthStart: (name, directory, signal) => conn.mcpAuthStart(name, directory, signal),
    mcpAuthFinish: (name, code, directory, signal) => conn.mcpAuthFinish(name, code, directory, signal),
    revert: (nativeId, messageId, directory) => conn.revert(nativeId, messageId, directory),
    unrevert: (nativeId, directory) => conn.unrevert(nativeId, directory),
    async fork(nativeId, messageId, directory) {
      const created = await conn.fork(nativeId, messageId, directory);
      return { casfId: `${PREFIX}${created.id}`, nativeId: created.id };
    },
    summarize: (nativeId, directory, model) => conn.summarize(nativeId, directory, model),
    listModels: () => conn.listModels(),
    listAgents: () => conn.listAgents(),
    listWorkspaces: () => conn.listWorkspaces(),
    rename: (nativeId, title, directory) => conn.updateSession(nativeId, { title }, directory),
    archive: (nativeId, directory) => conn.updateSession(nativeId, { archived: true }, directory),
    deleteSession: (nativeId, directory) => conn.deleteSession(nativeId, directory),
    async indexSessions() {
      const ids = await conn.indexSessions();
      return ids.map((native) => `${PREFIX}${native}`);
    },
    sync: (guard) => {
      if (syncing) return syncing;
      syncing = conn.refreshSessions(guard).finally(() => {
        syncing = undefined;
      });
      return syncing;
    },
    rebuild: (nativeId, directory) => conn.rebuildSession(nativeId, directory),
    async importSession(nativeId, directory) {
      await conn.importSession(nativeId, directory);
    },
    nativeId(casfId) {
      return casfId.startsWith(PREFIX) ? casfId.slice(PREFIX.length) : undefined;
    },
  };
}
