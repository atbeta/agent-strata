import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ConnectBody {
  backend?: string;
  /** opencode: the `opencode serve` URL */
  baseUrl?: string;
  /** acp: the agent's executable and arguments, spoken to over stdio */
  command?: string;
  args?: string[];
  cwd?: string;
  agentName?: string;
  name?: string;
  directory?: string;
  username?: string;
  password?: string;
  policy?: unknown;
  connectTimeoutMs?: number;
}

/** What identifies a connection: the server URL, or the command an ACP agent runs as. */
export function endpointOf(body: ConnectBody): string {
  if ((body.backend ?? "opencode") === "acp") {
    return `acp://${[body.command ?? "", ...(body.args ?? [])].join(" ")}`;
  }
  return body.baseUrl ?? "";
}

export function agentNameOf(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).replace(/\.(exe|cmd|bat)$/i, "");
}

/** Connections remembered across restarts, one per endpoint, next to the event store. */
export function connectionMemory(db: string | undefined) {
  const dir = !db || db === ":memory:" ? undefined : dirname(db);
  const file = dir ? join(dir, "connections.json") : undefined;
  const saved = (): ConnectBody[] => {
    if (!dir || !file) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(parsed)) return parsed as ConnectBody[];
    } catch {
      // not written yet
    }
    try {
      const single = JSON.parse(readFileSync(join(dir, "connection.json"), "utf8")) as ConnectBody;
      if (single.baseUrl) return [single];
    } catch {
      // no single connection from before the list either
    }
    return [];
  };
  const write = (list: ConnectBody[]) => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
    } catch (e) {
      console.error(`could not save connections: ${e}`);
    }
  };
  return {
    saved,
    remember(body: ConnectBody) {
      const key = endpointOf(body);
      const { policy: _policy, connectTimeoutMs: _timeout, ...kept } = body;
      write([...saved().filter((c) => endpointOf(c) !== key), kept]);
    },
    forget(endpoint: string) {
      write(saved().filter((c) => endpointOf(c) !== endpoint));
    },
  };
}
