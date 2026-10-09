import {
  connectOpencode,
  type OnAsk,
  type OnQuestion,
  type Sink,
} from "@agent-strata/adapter-opencode";
import type { Policy } from "@agent-strata/policy";
import type { BackendDriver } from "./driver";

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
}): Promise<BackendDriver> {
  const imported = new Set<string>();
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
  });
  const id = `${PREFIX}${opts.baseUrl}`;
  return {
    id,
    backend: "opencode",
    baseUrl: opts.baseUrl,
    name: opts.name,
    directory: opts.directory,
    capabilities: {
      prompt: true,
      abort: true,
      models: true,
      agents: true,
      import: true,
      manage: true,
    },
    stop: () => conn.stop(),
    async createSession(sess) {
      const created = await conn.createSession(sess);
      return { casfId: `${PREFIX}${created.id}`, nativeId: created.id };
    },
    prompt: (nativeId, text, promptOpts) => conn.prompt(nativeId, text, promptOpts),
    abort: (nativeId, directory) => conn.abort(nativeId, directory),
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
    async importSession(nativeId, directory) {
      if (imported.has(nativeId)) return;
      imported.add(nativeId);
      try {
        await conn.importSession(nativeId, directory);
      } catch (err) {
        imported.delete(nativeId);
        throw err;
      }
    },
    nativeId(casfId) {
      return casfId.startsWith(PREFIX) ? casfId.slice(PREFIX.length) : undefined;
    },
  };
}
