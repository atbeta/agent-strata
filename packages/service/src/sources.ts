import { isEmbeddedOrigin } from "./connections";

/** How many colours the UI has for servers; past that they repeat. */
export const SOURCE_COLORS = 5;

/**
 * Which server a stored session came from, as a reader tells servers apart.
 *
 * Read from the session's recorded origin, not from whichever connection owns
 * it now: a server that is disconnected still produced its sessions, and that
 * is when the reader most needs to see which ones they are. The local engine
 * carries no colour — it is the default, and every other server is told apart
 * from it.
 */
export interface SessionSource {
  local?: true;
  /** index into the UI's palette, absent for the local engine */
  color?: number;
  name: string;
  connected: boolean;
}

const OPENCODE = "opencode:";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

/**
 * `recorded` lists origins in the order the store first held a session from
 * each; `live` the origins of the connections up now, in connection order.
 *
 * A server's colour is its place in that order, so it is settled when its
 * first session lands and a newcomer takes the next one rather than moving
 * anyone else's. A server connected without a session yet is placed after
 * every recorded one, which is the place its first session will give it.
 */
export function sourceTable(opts: {
  recorded: readonly string[];
  live: readonly string[];
  names?: ReadonlyMap<string, string>;
}): (origin: string | null | undefined) => SessionSource | undefined {
  const liveSet = new Set(opts.live);
  const localUp = opts.live.some((origin) => isEmbeddedOrigin(origin));
  const servers: string[] = [];
  for (const origin of [...opts.recorded, ...opts.live]) {
    if (!origin.startsWith(OPENCODE) || isEmbeddedOrigin(origin) || servers.includes(origin)) continue;
    servers.push(origin);
  }
  const color = new Map(servers.map((origin, index) => [origin, index % SOURCE_COLORS]));
  return (origin) => {
    if (!origin) return undefined;
    if (isEmbeddedOrigin(origin)) return { local: true, name: "", connected: localUp };
    const index = color.get(origin);
    if (index === undefined) return undefined;
    const baseUrl = origin.slice(OPENCODE.length);
    return {
      color: index,
      name: opts.names?.get(origin) || hostOf(baseUrl),
      connected: liveSet.has(origin),
    };
  };
}
