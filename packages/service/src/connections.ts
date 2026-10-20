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
  /**
   * Where this address came from.
   *
   * `embed` means the app started the server itself. Such a server dies with
   * the app, so its address is worth remembering only for the run that owns
   * it — which is what lets the embedded backend hold one slot instead of one
   * entry per launch. `external` means someone else runs it.
   */
  placement?: "embed" | "external";
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

function isLoopback(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * The shape the shell gives the server it starts: loopback, the `opencode`
 * user, and the 43-character URL-safe password of 32 random bytes.
 *
 * An address like that is one of ours even from before the app wrote the
 * marker — which is what lets the embedded slot clean up after the runs that
 * came before it. An address the app has spoken about is never a guess: the
 * marker is the answer.
 */
export function looksEmbedded(body: ConnectBody): boolean {
  if (body.placement) return false;
  if ((body.backend ?? "opencode") !== "opencode") return false;
  if (body.username !== "opencode") return false;
  if (!body.password || !/^[A-Za-z0-9_-]{43}$/.test(body.password)) return false;
  return isLoopback(body.baseUrl);
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
      const rest = saved().filter((c) => endpointOf(c) !== key);
      // The embedded server is ours, and it gets a new address when the app
      // starts again. Its slot holds one address: the new one replaces the
      // old one, rather than the list growing by one on every launch. An
      // address that only looks like ours is left alone — whether it is a
      // server of the user's is settled by whether it answers, not by its
      // shape.
      const others = body.placement === "embed" ? rest.filter((c) => c.placement !== "embed") : rest;
      write([...others, kept]);
    },
    /**
     * Drop the addresses of embedded servers that are no longer ours.
     *
     * The app starts its own server and stops it when it exits, so an address
     * it used before can only be dead — and a dead address that is dialed
     * again is a row nobody can get rid of. `keep` is the address the current
     * run owns; `placement` says whether the app owns a server at all.
     */
    pruneEmbedded(placement: "embed" | "external", keep?: string) {
      const list = saved();
      const rest = list.filter((c) => {
        if (c.placement !== "embed") return true;
        if (placement === "embed" && keep !== undefined && endpointOf(c) === keep) return true;
        return false;
      });
      if (rest.length !== list.length) write(rest);
      return rest;
    },
    forget(endpoint: string) {
      write(saved().filter((c) => endpointOf(c) !== endpoint));
    },
  };
}
