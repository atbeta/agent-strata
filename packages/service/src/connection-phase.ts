/**
 * One answer for "what is the backend connection doing", for every backend.
 *
 * OpenCode embed, OpenCode external and ACP all arrive as the same two facts:
 * a live connection, and an attempt that is still trying or has given up.
 * The launch file only adds what those two cannot know — the shell is still
 * spawning a process, or the binary was not there to spawn. A preference for
 * an external server, or a process that is merely up, is not itself a
 * connection in progress; the attempt list is what says we are still trying.
 */

export type ConnectionPhaseName = "connected" | "attaching" | "failed" | "missing" | "idle";

export type LaunchState =
  | "starting"
  | "running"
  | "missing"
  | "restarting"
  | "stopped"
  | "external"
  | "unmanaged";

export type ConnectionPlacement = "embed" | "external";

const SPAWNING = new Set<LaunchState>(["starting", "restarting"]);

export function connectionPhase(input: {
  connected: boolean;
  attempts: { phase: "retrying" | "failed" }[];
  launchState: LaunchState;
}): ConnectionPhaseName {
  if (input.connected) return "connected";
  if (input.attempts.some((attempt) => attempt.phase === "retrying")) return "attaching";
  if (SPAWNING.has(input.launchState)) return "attaching";
  if (input.attempts.some((attempt) => attempt.phase === "failed")) return "failed";
  if (input.launchState === "missing") return "missing";
  return "idle";
}

/** `http://127.0.0.1:4096/` and `http://127.0.0.1:4096` are the same server. */
export function sameEndpoint(a: string, b: string): boolean {
  return canonicalEndpoint(a) === canonicalEndpoint(b);
}

function canonicalEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return endpoint.replace(/\/+$/, "");
  }
}

/**
 * Whether this OpenCode server is the one the shell spawned.
 *
 * External mode is a choice: every OpenCode address is someone else's process.
 * Embed mode is a fact about one URL, the one written next to `running`.
 * An address we cannot match to that URL is not labeled — guessing "external"
 * for the embedded server before its URL is written would be the wrong word.
 */
export function connectionPlacement(
  backend: string,
  endpoint: string,
  launch: { mode: "embed" | "external"; url?: string },
): ConnectionPlacement | undefined {
  if (backend !== "opencode" || !endpoint || endpoint.startsWith("acp://")) return undefined;
  if (launch.mode === "external") return "external";
  if (!launch.url) return undefined;
  return sameEndpoint(launch.url, endpoint) ? "embed" : "external";
}
