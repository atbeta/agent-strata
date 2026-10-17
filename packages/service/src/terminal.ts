import type { ServerWebSocket } from "bun";

/**
 * A shell in the session's workspace. The page talks only to strata. The
 * OpenCode password and the short-lived connect ticket stay on this side of
 * the socket bridge.
 */

export const PTY_ID = /^[\w.-]+$/;

export interface PtyShell {
  name: string;
  path: string;
  /** The backend's own verdict. Anything false here cannot be asked for by name,
   *  and the list is reported as it came so the page can say why. */
  acceptable: boolean;
}

export interface PtyInfo {
  id: string;
  title: string;
  command: string;
  cwd: string;
  status: "running" | "exited";
}

export interface TerminalApi {
  shells(directory: string): Promise<PtyShell[]>;
  list(directory: string): Promise<PtyInfo[]>;
  create(directory: string, command: string | undefined, title: string | undefined): Promise<PtyInfo>;
  remove(directory: string, id: string): Promise<void>;
  resize(directory: string, id: string, size: { rows: number; cols: number }): Promise<void>;
  /** Mint a ticket and the upstream socket. The ticket never leaves this process. */
  open(directory: string, id: string): Promise<{ url: string; headers: Record<string, string> }>;
}

export class TerminalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A shell the caller named must be one the backend marked acceptable. The path comes from that list. */
export function shellCommand(
  shells: PtyShell[],
  requested: unknown,
): { ok: true; command?: string } | { ok: false } {
  if (requested === undefined || requested === "") return { ok: true };
  if (typeof requested !== "string") return { ok: false };
  const hit = shells.find((s) => s.acceptable && s.name === requested && s.path.length > 0);
  if (!hit) return { ok: false };
  return { ok: true, command: hit.path };
}

export function terminalTitle(value: unknown): { ok: true; title?: string } | { ok: false } {
  if (value === undefined || value === "") return { ok: true };
  if (typeof value !== "string") return { ok: false };
  const title = value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  return { ok: true, title: title || undefined };
}

export function terminalSize(rows: unknown, cols: unknown): { rows: number; cols: number } | undefined {
  if (typeof rows !== "number" || typeof cols !== "number") return undefined;
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return undefined;
  if (rows < 1 || rows > 400 || cols < 1 || cols > 500) return undefined;
  return { rows, cols };
}

/** OpenCode marks a cursor update as a binary frame of 0x00 plus JSON. That is not terminal output. */
export function isPtyMeta(data: Uint8Array): boolean {
  if (data.byteLength < 2 || data[0] !== 0) return false;
  try {
    const meta = JSON.parse(new TextDecoder().decode(data.subarray(1))) as { cursor?: unknown };
    return typeof meta.cursor === "number";
  } catch {
    return false;
  }
}

export function ptyInfo(value: unknown): PtyInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !PTY_ID.test(row.id)) return undefined;
  return {
    id: row.id,
    title: typeof row.title === "string" && row.title ? row.title : row.id,
    command: typeof row.command === "string" ? row.command : "",
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    status: row.status === "exited" ? "exited" : "running",
  };
}

export function ptyShells(value: unknown): PtyShell[] {
  if (!Array.isArray(value)) return [];
  const out: PtyShell[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.name !== "string" || typeof row.path !== "string") continue;
    out.push({ name: row.name, path: row.path, acceptable: row.acceptable === true });
  }
  return out;
}

interface TerminalLink {
  upstream?: WebSocket;
  /** keystrokes that arrive before the upstream socket is open */
  queue: string[];
  closed: boolean;
  open: () => Promise<{ url: string; headers: Record<string, string> }>;
}

type UpgradeServer = {
  upgrade(req: Request, options: { data: TerminalLink }): boolean;
};

function sessionId(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function matchTerminal(pathname: string): { casfId: string; ptyId?: string; action?: string } | undefined {
  const m = pathname.match(/^\/sessions\/([^/]+)\/terminal(?:\/([^/]+)(?:\/(size|connect))?)?$/);
  if (!m) return undefined;
  const casfId = sessionId(m[1]!);
  if (!casfId) return undefined;
  const ptyId = m[2] ? sessionId(m[2]) : undefined;
  if (m[2] && !ptyId) return undefined;
  return { casfId, ptyId, action: m[3] };
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "content-type": "application/json" } });

export async function terminalRoute(
  req: Request,
  url: URL,
  lookup: (casfId: string) => { directory: string; terminal: TerminalApi } | undefined,
): Promise<Response | undefined> {
  const hit = matchTerminal(url.pathname);
  if (!hit) return undefined;
  if (hit.action === "connect") return json({ error: "expected websocket" }, 400);
  const owned = lookup(hit.casfId);
  if (!owned) return json({ error: "not found" }, 404);
  const { directory, terminal } = owned;
  try {
    if (!hit.ptyId && req.method === "GET") {
      const sessions = await terminal.list(directory);
      // The shell list is a second upstream call, and this route is on the pane's
      // path for every session switch. A backend without /pty/shells must not
      // cost the reader their terminal list, so this one call degrades to "no
      // choices" on its own instead of taking the whole response down with it.
      const shells = await terminal.shells(directory).catch(() => [] as PtyShell[]);
      return json({ sessions, shells });
    }
    if (!hit.ptyId && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { shell?: unknown; title?: unknown; cwd?: unknown };
      // cwd, args, and env are not the caller's to choose
      const title = terminalTitle(body.title);
      if (!title.ok) return json({ error: "invalid title" }, 400);
      let command: string | undefined;
      if (body.shell !== undefined && body.shell !== "") {
        const choice = shellCommand(await terminal.shells(directory), body.shell);
        if (!choice.ok) return json({ error: "unknown shell" }, 400);
        command = choice.command;
      }
      return json(await terminal.create(directory, command, title.title));
    }
    if (hit.ptyId && !hit.action && req.method === "DELETE") {
      if (!PTY_ID.test(hit.ptyId)) return json({ error: "not found" }, 404);
      await terminal.remove(directory, hit.ptyId);
      return json({ ok: true });
    }
    if (hit.ptyId && hit.action === "size" && req.method === "POST") {
      if (!PTY_ID.test(hit.ptyId)) return json({ error: "not found" }, 404);
      const body = (await req.json().catch(() => ({}))) as { rows?: unknown; cols?: unknown };
      const size = terminalSize(body.rows, body.cols);
      if (!size) return json({ error: "invalid size" }, 400);
      await terminal.resize(directory, hit.ptyId, size);
      return json({ ok: true });
    }
  } catch (e) {
    if (e instanceof TerminalError) return json({ error: e.message }, e.status);
    return json({ error: "terminal failed" }, 502);
  }
  return json({ error: "method not allowed" }, 405);
}

/** Accept the page socket. Returns "upgraded" when Bun has taken the request. */
export function terminalUpgrade(
  req: Request,
  url: URL,
  server: UpgradeServer,
  lookup: (casfId: string) => { directory: string; terminal: TerminalApi } | undefined,
): "upgraded" | Response | undefined {
  const hit = matchTerminal(url.pathname);
  if (!hit || hit.action !== "connect") return undefined;
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected websocket" }, 400);
  if (!hit.ptyId || !PTY_ID.test(hit.ptyId)) return json({ error: "not found" }, 404);
  const owned = lookup(hit.casfId);
  if (!owned) return json({ error: "not found" }, 404);
  const ptyId = hit.ptyId;
  const data: TerminalLink = {
    queue: [],
    closed: false,
    open: () => owned.terminal.open(owned.directory, ptyId),
  };
  if (server.upgrade(req, { data })) return "upgraded";
  return json({ error: "upgrade failed" }, 400);
}

function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}

export function terminalOpen(ws: ServerWebSocket<TerminalLink>): void {
  const link = ws.data;
  void link
    .open()
    .then((target) => {
      if (link.closed) return;
      // Bun's client takes headers here. The DOM typing only knows protocol names.
      const upstream = new (WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WebSocket)(target.url, { headers: target.headers });
      link.upstream = upstream;
      const send = (data: string | Uint8Array) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      };
      upstream.addEventListener("open", () => {
        if (link.closed) {
          upstream.close();
          return;
        }
        for (const queued of link.queue) upstream.send(queued);
        link.queue = [];
      });
      upstream.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") {
          send(ev.data);
          return;
        }
        const bytes = asBytes(ev.data);
        if (bytes && !isPtyMeta(bytes)) send(bytes);
      });
      upstream.addEventListener("close", () => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
      upstream.addEventListener("error", () => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
    })
    .catch(() => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
}

export function terminalMessage(ws: ServerWebSocket<TerminalLink>, message: string | Buffer): void {
  const text = typeof message === "string" ? message : new TextDecoder().decode(message);
  const upstream = ws.data.upstream;
  if (!upstream || upstream.readyState !== WebSocket.OPEN) {
    ws.data.queue.push(text);
    return;
  }
  upstream.send(text);
}

export function terminalClose(ws: ServerWebSocket<TerminalLink>): void {
  ws.data.closed = true;
  ws.data.upstream?.close();
}
