/**
 * A dev server still sitting in a session's shell.
 *
 * A pending shell is not enough. `git status` and `bun test` are pending for
 * the whole time they run, and naming them would mark an ordinary turn as a
 * server that never exits. The command has to be one that stays up, the call
 * has to still be pending, and the session has to still be active — a finished
 * session has already turned its open calls into interrupted ones.
 */

const SHELLS = new Set(["bash", "shell", "exec", "execute", "pwsh", "powershell", "cmd", "zsh", "sh"]);

/** A prefix that returns immediately, so the next segment is what the shell is waiting on. */
const TRIVIAL = /^(?:cd|pushd|popd|export|unset|pwd|true|:)\b/;

const SERVERS = [
  /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:dev|start|serve)(?:\s|$)/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:dev|start|serve)(?:\s|$)/,
  /^(?:npx|bunx)\s+(?:--yes\s+|-y\s+)?(?:vite|next|nuxt|astro)(?:\s|$)/,
  /^vite(?:\s+(?!build(?:\s|$)).*)?$/,
  /^next\s+(?:dev|start)(?:\s|$)/,
  /^nuxt\s+dev(?:\s|$)/,
  /^astro\s+dev(?:\s|$)/,
  /^ng\s+serve(?:\s|$)/,
  /^hugo\s+server(?:\s|$)/,
  /^php\s+artisan\s+serve(?:\s|$)/,
  /^rails\s+(?:server|s)(?:\s|$)/,
  /^mix\s+phx\.server(?:\s|$)/,
  /^uvicorn(?:\s|$)/,
  /^gunicorn(?:\s|$)/,
  /^flask\s+run(?:\s|$)/,
  /^python(?:3(?:\.\d+)?)?\s+-m\s+http\.server(?:\s|$)/,
  /^wrangler\s+dev(?:\s|$)/,
  /^firebase\s+emulators:start(?:\s|$)/,
  /^nodemon(?:\s|$)/,
  /^tsx\s+watch(?:\s|$)/,
  /^ts-node-dev(?:\s|$)/,
  /^watchexec(?:\s|$)/,
  /^dotnet\s+watch(?:\s|$)/,
  /^func\s+start(?:\s|$)/,
  /^docker\s+compose\s+up(?:\s|$)/,
  /^docker-compose\s+up(?:\s|$)/,
];

export interface RunningShell {
  /** The server invocation itself, for the row. */
  command: string;
  /** The shell's first line, when a `cd` or an assignment sits in front of it. */
  detail: string;
  since?: string;
}

export interface RunningShellView {
  status: string;
  turns: Array<{
    reverted?: boolean;
    tool_calls: Array<{
      tool: string;
      status: string;
      input: Record<string, unknown>;
      ts?: string;
    }>;
  }>;
}

function splitSegments(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";" || (ch === "&" && line[i + 1] === "&") || (ch === "|" && line[i + 1] === "|")) {
      out.push(cur);
      cur = "";
      if (ch !== ";") i++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function stripEnv(segment: string): string {
  let s = segment.trim();
  for (;;) {
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|\S*))\s+/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.replace(/\s+/g, " ").trim();
}

function detached(body: string): boolean {
  return /^docker(?:\s+compose|-compose)\s+up\b/.test(body) && /(?:^|\s)(?:-d|--detach)(?:\s|$)/.test(body);
}

function serverSegment(segment: string): string | undefined {
  const body = stripEnv(segment);
  if (!body || detached(body)) return undefined;
  return SERVERS.some((re) => re.test(body)) ? body : undefined;
}

function serverIn(command: string): { command: string; detail: string } | undefined {
  const line = command
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  if (!line) return undefined;
  const detail = line.replace(/\s+/g, " ").trim();
  for (const part of splitSegments(line)) {
    const hit = serverSegment(part);
    if (hit) return { command: hit, detail };
    const bare = stripEnv(part);
    if (!bare || TRIVIAL.test(bare)) continue;
    return undefined;
  }
  return undefined;
}

/** The server this session's shell is still waiting on, when the command is one that stays up. */
export function runningShell(view: RunningShellView): RunningShell | undefined {
  if (view.status !== "active") return undefined;
  let best: RunningShell | undefined;
  for (const turn of view.turns) {
    if (turn.reverted) continue;
    for (const call of turn.tool_calls) {
      if (call.status !== "pending" || !SHELLS.has(call.tool.toLowerCase())) continue;
      const raw = call.input.command;
      if (typeof raw !== "string") continue;
      const hit = serverIn(raw);
      if (!hit) continue;
      const since = call.ts;
      if (!best || (since !== undefined && (best.since === undefined || since > best.since))) {
        best = { ...hit, ...(since !== undefined ? { since } : {}) };
      }
    }
  }
  return best;
}
