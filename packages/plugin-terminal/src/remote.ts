/**
 * Terminals that live on the backend's machine. The session workspace of a
 * remote backend does not exist here, so spawning locally would either fail
 * or — worse — hand the reader a shell on the wrong computer. Instead the
 * backend's own /pty API owns the shell; this manager bridges every output
 * byte back into a local ring so reads, offsets, replays, and agent tools
 * behave exactly as they do for a local terminal.
 *
 * Wire facts the bridge relies on: outbound frames are raw terminal chunks,
 * one control frame (0x00 + JSON) carries the absolute output cursor after
 * replay, inbound frames are the input text, the server closes with 1000
 * when the process ends and with 4404 when the session is gone. A close the
 * server meant is final; anything else is a network drop worth retrying.
 */
import { OutputRing } from "./output";
import type { PtyCreateInput } from "./manager";
import type {
  PtyCloseResult,
  PtyEvent,
  PtyInfo,
  PtyReadPage,
  RemotePtyApi,
  TerminalActor,
  TerminalMode,
  TerminalSignal,
} from "./types";

interface RemoteEntry {
  info: PtyInfo;
  ring: OutputRing;
  listeners: Set<(event: PtyEvent) => void>;
  api: RemotePtyApi;
  directory: string;
  ws?: WebSocket;
  inputQueue: (string | Uint8Array)[];
  /** Server-side output cursor consumed so far, for resume after a drop. */
  cursor: number;
  /** Replay bytes are already counted in the meta cursor; live bytes are not. */
  metaSeen: boolean;
  intentionalClose: boolean;
  reconnects: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  exitedAt?: number;
  reaper?: ReturnType<typeof setTimeout>;
}

export interface RemotePtyManagerOptions {
  maxProcesses?: number;
  maxPerSession?: number;
  outputBytes?: number;
  exitTtlMs?: number;
  maxExited?: number;
  /** Reconnect attempts before the terminal is declared lost. */
  maxReconnects?: number;
  /** Test seam: replace the websocket constructor. */
  webSocket?: (url: string, headers: Record<string, string>) => WebSocket;
}

const textEncoder = new TextEncoder();

function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}

function metaCursor(data: Uint8Array): number | undefined {
  if (data.byteLength < 2 || data[0] !== 0) return undefined;
  try {
    const meta = JSON.parse(new TextDecoder().decode(data.subarray(1))) as { cursor?: unknown };
    return typeof meta.cursor === "number" ? meta.cursor : undefined;
  } catch {
    return undefined;
  }
}

export class RemotePtyManager {
  private readonly entries = new Map<string, RemoteEntry>();
  private readonly listeners = new Set<(info: PtyInfo) => void>();
  private readonly maxProcesses: number;
  private readonly maxPerSession: number;
  private readonly outputBytes: number;
  private readonly exitTtlMs: number;
  private readonly maxExited: number;
  private readonly maxReconnects: number;
  private readonly webSocket?: (url: string, headers: Record<string, string>) => WebSocket;

  constructor(options: RemotePtyManagerOptions = {}) {
    this.maxProcesses = options.maxProcesses ?? 32;
    this.maxPerSession = options.maxPerSession ?? 8;
    this.outputBytes = options.outputBytes ?? 256 * 1024;
    this.exitTtlMs = options.exitTtlMs ?? 5 * 60_000;
    this.maxExited = options.maxExited ?? 32;
    this.maxReconnects = options.maxReconnects ?? 5;
    this.webSocket = options.webSocket;
  }

  onChange(listener: (info: PtyInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: PtyCreateInput): Promise<PtyInfo> {
    if (!input.remote) throw new Error("remote terminal created without a backend binding");
    this.pruneExited();
    const running = this.list().filter((info) => info.status === "running");
    if (running.length >= this.maxProcesses) throw new Error("too many terminals are open");
    const owned = this.list(input.sessionId).filter((info) => info.status === "running");
    if (owned.length >= this.maxPerSession) throw new Error("too many terminals are open for this session");
    const { api, directory } = input.remote;
    const created = await api.create(directory, {
      command: input.argv[0],
      args: input.argv.slice(1),
      cwd: input.cwd,
      title: input.title,
      env: input.env,
      rows: input.rows,
      cols: input.cols,
    });
    const info: PtyInfo = {
      id: created.id,
      session_id: input.sessionId,
      title: created.title || input.title,
      command: created.command || input.command,
      cwd: created.cwd || input.cwd,
      pid: created.pid,
      started_at: Date.now(),
      status: "running",
      exit_code: null,
      mode: input.mode,
    };
    const entry: RemoteEntry = {
      info,
      ring: new OutputRing(this.outputBytes),
      listeners: new Set(),
      api,
      directory,
      inputQueue: [],
      cursor: 0,
      metaSeen: false,
      intentionalClose: false,
      reconnects: 0,
    };
    this.entries.set(info.id, entry);
    this.connect(entry);
    this.changed(info);
    return info;
  }

  list(sessionId?: string): PtyInfo[] {
    return [...this.entries.values()]
      .map((entry) => entry.info)
      .filter((info) => sessionId === undefined || info.session_id === sessionId)
      .sort((a, b) => b.started_at - a.started_at);
  }

  listAgent(sessionId: string): PtyInfo[] {
    return this.list(sessionId).filter((info) => info.mode === "shared");
  }

  get(sessionId: string, id: string): PtyInfo {
    const info = this.entries.get(id)?.info;
    if (!info || info.session_id !== sessionId) throw new Error(`there is no terminal called ${id}`);
    return info;
  }

  getAgent(sessionId: string, id: string): PtyInfo {
    return this.agentEntry(sessionId, id).info;
  }

  setMode(sessionId: string, id: string, mode: TerminalMode): PtyInfo {
    const entry = this.ownedEntry(sessionId, id);
    if (entry.info.mode !== mode) {
      entry.info.mode = mode;
      this.changed(entry.info);
    }
    return entry.info;
  }

  write(sessionId: string, id: string, data: string | Uint8Array, actor: TerminalActor = "user"): number {
    const entry = actor === "agent" ? this.agentEntry(sessionId, id) : this.ownedEntry(sessionId, id);
    if (entry.info.status !== "running") throw new Error(`terminal ${id} has exited`);
    const ws = entry.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(typeof data === "string" ? data : new TextDecoder().decode(data));
    } else {
      entry.inputQueue.push(data);
      if (entry.inputQueue.length > 256) entry.inputQueue.splice(0, entry.inputQueue.length - 256);
    }
    return typeof data === "string" ? data.length : data.byteLength;
  }

  /**
   * A remote PTY has no signal channel. The control characters the line
   * discipline already understands still work — they are how the keys
   * themselves do it — and anything beyond them reports honestly.
   */
  async signal(sessionId: string, id: string, signal: TerminalSignal, actor: TerminalActor = "user"): Promise<void> {
    const entry = actor === "agent" ? this.agentEntry(sessionId, id) : this.ownedEntry(sessionId, id);
    if (entry.info.status !== "running") throw new Error(`terminal ${id} has exited`);
    if (signal === "SIGINT") {
      this.write(sessionId, id, "\x03", actor);
      return;
    }
    if (signal === "SIGTSTP") {
      this.write(sessionId, id, "\x1a", actor);
      return;
    }
    throw new Error(`${signal} needs a local process; a remote terminal only carries input`);
  }

  async resize(sessionId: string, id: string, rows: number, cols: number): Promise<void> {
    const entry = this.ownedEntry(sessionId, id);
    if (entry.info.status !== "running") throw new Error(`terminal ${id} has exited`);
    await entry.api.resize(entry.directory, id, { rows, cols });
  }

  read(sessionId: string, id: string, offset?: number, maxBytes = 16 * 1024): PtyReadPage {
    return this.ownedEntry(sessionId, id).ring.read(offset, maxBytes);
  }

  readAgent(sessionId: string, id: string, offset?: number, maxBytes = 16 * 1024): PtyReadPage {
    return this.agentEntry(sessionId, id).ring.read(offset, maxBytes);
  }

  attach(sessionId: string, id: string, listener: (event: PtyEvent) => void): {
    info: PtyInfo;
    replay: Uint8Array;
    unsubscribe: () => void;
  } {
    const entry = this.ownedEntry(sessionId, id);
    entry.listeners.add(listener);
    return {
      info: entry.info,
      replay: entry.ring.replay(),
      unsubscribe: () => entry.listeners.delete(listener),
    };
  }

  async close(sessionId: string, id: string, actor: TerminalActor = "user"): Promise<PtyCloseResult> {
    const entry = actor === "agent" ? this.agentEntry(sessionId, id) : this.ownedEntry(sessionId, id);
    entry.intentionalClose = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.ws?.close();
    try {
      await entry.api.remove(entry.directory, id);
    } catch {
      // the session may already be gone on the far side; closing must not fail for it
    }
    this.entries.delete(id);
    for (const listener of entry.listeners) listener({ type: "exit", exitCode: entry.info.exit_code });
    entry.listeners.clear();
    this.changed(entry.info);
    return { cleanup: "exited" };
  }

  async closeSession(sessionId: string): Promise<void> {
    await Promise.all(this.list(sessionId).map((info) => this.close(sessionId, info.id).catch(() => undefined)));
  }

  async closeInside(directory: string, inside: (root: string, target: string) => boolean): Promise<void> {
    await Promise.all(
      this.list()
        .filter((info) => inside(directory, info.cwd))
        .map((info) => this.close(info.session_id, info.id).catch(() => undefined)),
    );
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.list().map((info) => this.close(info.session_id, info.id).catch(() => undefined)));
  }

  // ---- the wire ----

  private connect(entry: RemoteEntry): void {
    const connectOnce = async (): Promise<void> => {
      const target = await entry.api.open(entry.directory, entry.info.id, entry.metaSeen ? entry.cursor : undefined);
      if (entry.intentionalClose || entry.info.status !== "running") return;
      const ws = this.webSocket
        ? this.webSocket(target.url, target.headers)
        : new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket)(
            target.url,
            { headers: target.headers },
          );
      entry.ws = ws;
      // Bytes are only counted towards the resume cursor once this
      // connection's meta frame has landed — everything before it is replay,
      // already covered by the cursor the server reports in that frame.
      let live = false;
      ws.addEventListener("open", () => {
        entry.reconnects = 0;
        for (const queued of entry.inputQueue) {
          ws.send(typeof queued === "string" ? queued : new TextDecoder().decode(queued));
        }
        entry.inputQueue = [];
      });
      ws.addEventListener("message", (ev) => {
        if (entry.info.status !== "running" && entry.intentionalClose) return;
        if (typeof ev.data === "string") {
          this.pushData(entry, textEncoder.encode(ev.data), live);
          return;
        }
        const bytes = asBytes(ev.data);
        if (!bytes) return;
        const cursor = metaCursor(bytes);
        if (cursor !== undefined) {
          entry.cursor = cursor;
          entry.metaSeen = true;
          live = true;
          return;
        }
        this.pushData(entry, bytes, live);
      });
      ws.addEventListener("close", (ev) => {
        // 1000 is the process ending, 4404 the session being gone — both final.
        if (ev.code === 1000 || ev.code === 4404) {
          if (!entry.intentionalClose) this.settle(entry, null);
          return;
        }
        dropped();
      });
      ws.addEventListener("error", () => {
        // the close event that follows decides; there is nothing to do here
      });
    };
    const dropped = () => {
      if (entry.intentionalClose || entry.info.status !== "running") return;
      entry.ws = undefined;
      if (entry.reconnects >= this.maxReconnects) {
        this.settle(entry, null);
        return;
      }
      entry.reconnects += 1;
      entry.reconnectTimer = setTimeout(() => void connectOnce().catch(dropped), Math.min(250 * 2 ** entry.reconnects, 10_000));
      entry.reconnectTimer.unref?.();
    };
    void connectOnce().catch(dropped);
  }

  private pushData(entry: RemoteEntry, bytes: Uint8Array, live: boolean): void {
    entry.ring.push(bytes);
    if (live) entry.cursor += bytes.byteLength;
    const copy = new Uint8Array(bytes);
    for (const listener of entry.listeners) listener({ type: "data", data: copy });
  }

  // ---- bookkeeping, mirroring the local manager ----

  private ownedEntry(sessionId: string, id: string): RemoteEntry {
    this.get(sessionId, id);
    return this.entries.get(id)!;
  }

  private agentEntry(sessionId: string, id: string): RemoteEntry {
    const entry = this.ownedEntry(sessionId, id);
    if (entry.info.mode !== "shared") throw new Error(`there is no terminal called ${id}`);
    return entry;
  }

  private settle(entry: RemoteEntry, exitCode: number | null): void {
    if (entry.info.status === "exited") return;
    entry.info.status = "exited";
    entry.info.exit_code = exitCode;
    entry.exitedAt = Date.now();
    entry.ws?.close();
    entry.ws = undefined;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    for (const listener of entry.listeners) listener({ type: "exit", exitCode });
    entry.listeners.clear();
    this.changed(entry.info);
    this.pruneExited();
    if (this.entries.get(entry.info.id) === entry && this.exitTtlMs > 0) {
      entry.reaper = setTimeout(() => this.remove(entry), this.exitTtlMs);
      entry.reaper.unref?.();
    }
  }

  private pruneExited(): void {
    const now = Date.now();
    const exited = [...this.entries.values()]
      .filter((entry) => entry.info.status === "exited")
      .sort((a, b) => (a.exitedAt ?? a.info.started_at) - (b.exitedAt ?? b.info.started_at));
    for (const entry of exited) {
      if ((entry.exitedAt ?? now) + this.exitTtlMs <= now) this.remove(entry);
    }
    const excess = exited.length - this.maxExited;
    for (let i = 0; i < excess; i++) {
      const entry = exited[i]!;
      if (this.entries.has(entry.info.id)) this.remove(entry);
    }
  }

  private remove(entry: RemoteEntry): void {
    if (this.entries.get(entry.info.id) !== entry) return;
    if (entry.reaper) clearTimeout(entry.reaper);
    entry.reaper = undefined;
    this.entries.delete(entry.info.id);
    for (const listener of entry.listeners) listener({ type: "exit", exitCode: entry.info.exit_code });
    entry.listeners.clear();
    this.changed(entry.info);
  }

  private changed(info: PtyInfo): void {
    for (const listener of this.listeners) listener(info);
  }
}
