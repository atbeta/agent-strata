import { signalPty, spawnPty, terminatePty } from "./native";
import { OutputRing } from "./output";
import { terminalEnv } from "./shells";
import type {
  PtyCloseResult,
  PtyEvent,
  PtyInfo,
  PtyProcess,
  PtyReadPage,
  PtySignal,
  PtySpawn,
  PtyTerminate,
  TerminalActor,
  TerminalMode,
  TerminalSignal,
} from "./types";

interface Entry {
  info: PtyInfo;
  ring: OutputRing;
  /** The width the slave is wrapping at. Reads use it to put a hard-wrapped row back on one line. */
  cols: number;
  child?: PtyProcess;
  listeners: Set<(event: PtyEvent) => void>;
  exitedAt?: number;
  reaper?: ReturnType<typeof setTimeout>;
}

export interface PtyCreateInput {
  sessionId: string;
  title: string;
  argv: string[];
  command: string;
  cwd: string;
  rows: number;
  cols: number;
  mode: TerminalMode;
  env?: Record<string, string>;
}

export interface PtyManagerOptions {
  spawn?: PtySpawn;
  terminate?: PtyTerminate;
  signal?: PtySignal;
  platform?: NodeJS.Platform;
  maxProcesses?: number;
  maxPerSession?: number;
  outputBytes?: number;
  exitTtlMs?: number;
  maxExited?: number;
}

let counter = 0;

export class PtyManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(info: PtyInfo) => void>();
  private readonly spawn: PtySpawn;
  private readonly terminate: PtyTerminate;
  private readonly signalProcess: PtySignal;
  private readonly platform: NodeJS.Platform;
  private readonly maxProcesses: number;
  private readonly maxPerSession: number;
  private readonly outputBytes: number;
  private readonly exitTtlMs: number;
  private readonly maxExited: number;

  constructor(options: PtyManagerOptions = {}) {
    this.spawn = options.spawn ?? spawnPty;
    this.terminate = options.terminate ?? terminatePty;
    this.signalProcess = options.signal ?? signalPty;
    this.platform = options.platform ?? process.platform;
    this.maxProcesses = options.maxProcesses ?? 32;
    this.maxPerSession = options.maxPerSession ?? 8;
    this.outputBytes = options.outputBytes ?? 256 * 1024;
    this.exitTtlMs = options.exitTtlMs ?? 5 * 60_000;
    this.maxExited = options.maxExited ?? 32;
  }

  onChange(listener: (info: PtyInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(input: PtyCreateInput): PtyInfo {
    this.pruneExited();
    const running = this.list().filter((info) => info.status === "running");
    if (running.length >= this.maxProcesses) throw new Error("too many terminals are open");
    const owned = this.list(input.sessionId).filter((info) => info.status === "running");
    if (owned.length >= this.maxPerSession) throw new Error("too many terminals are open for this session");
    counter += 1;
    const id = `pty_${Date.now().toString(36)}_${counter.toString(36)}`;
    const info: PtyInfo = {
      id,
      session_id: input.sessionId,
      title: input.title,
      command: input.command,
      cwd: input.cwd,
      started_at: Date.now(),
      status: "running",
      exit_code: null,
      mode: input.mode,
    };
    const entry: Entry = {
      info,
      ring: new OutputRing(this.outputBytes),
      cols: input.cols,
      listeners: new Set(),
    };
    this.entries.set(id, entry);
    try {
      const child = this.spawn({
        argv: input.argv,
        cwd: input.cwd,
        env: { ...terminalEnv(), ...input.env },
        rows: input.rows,
        cols: input.cols,
        detached: this.platform !== "win32",
        onData: (data) => {
          entry.ring.push(data);
          const copy = new Uint8Array(data);
          for (const listener of entry.listeners) listener({ type: "data", data: copy });
        },
      });
      entry.child = child;
      info.pid = child.pid;
      void child.exited.then(
        (code) => this.settle(entry, code),
        () => this.settle(entry, null),
      );
      this.changed(info);
      return info;
    } catch (error) {
      this.entries.delete(id);
      throw error;
    }
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
    if (!entry.child || entry.info.status !== "running") throw new Error(`terminal ${id} has exited`);
    return entry.child.terminal.write(data);
  }

  async signal(sessionId: string, id: string, signal: TerminalSignal, actor: TerminalActor = "user"): Promise<void> {
    const entry = actor === "agent" ? this.agentEntry(sessionId, id) : this.ownedEntry(sessionId, id);
    if (!entry.child || entry.info.status !== "running") throw new Error(`terminal ${id} has exited`);
    await this.signalProcess(entry.child, signal, this.platform);
  }

  resize(sessionId: string, id: string, rows: number, cols: number): void {
    const entry = this.ownedEntry(sessionId, id);
    if (!entry.child || entry.info.status !== "running") throw new Error(`terminal ${id} has exited`);
    entry.cols = cols;
    entry.child.terminal.resize(cols, rows);
  }

  /** The width currently in effect, for rejoining rows the terminal wrapped. */
  columns(sessionId: string, id: string): number {
    return this.agentEntry(sessionId, id).cols;
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
    const cleanup = await this.closeEntry(entry);
    this.entries.delete(id);
    this.changed(entry.info);
    return { cleanup };
  }

  async closeSession(sessionId: string): Promise<void> {
    await Promise.all(this.list(sessionId).map((info) => this.close(sessionId, info.id)));
  }

  async closeInside(directory: string, inside: (root: string, target: string) => boolean): Promise<void> {
    await Promise.all(
      this.list()
        .filter((info) => inside(directory, info.cwd))
        .map((info) => this.close(info.session_id, info.id)),
    );
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.list().map((info) => this.close(info.session_id, info.id)));
  }

  private ownedEntry(sessionId: string, id: string): Entry {
    this.get(sessionId, id);
    return this.entries.get(id)!;
  }

  private agentEntry(sessionId: string, id: string): Entry {
    const entry = this.ownedEntry(sessionId, id);
    if (entry.info.mode !== "shared") throw new Error(`there is no terminal called ${id}`);
    return entry;
  }

  private async closeEntry(entry: Entry): Promise<"exited" | "unconfirmed"> {
    if (entry.reaper) clearTimeout(entry.reaper);
    entry.reaper = undefined;
    for (const listener of entry.listeners) listener({ type: "exit", exitCode: entry.info.exit_code });
    entry.listeners.clear();
    let cleanup: "exited" | "unconfirmed" = "exited";
    if (entry.child && entry.info.status === "running") cleanup = await this.terminate(entry.child, this.platform);
    this.settle(entry, entry.info.exit_code ?? 0);
    return cleanup;
  }

  private settle(entry: Entry, exitCode: number | null): void {
    if (entry.info.status === "exited") return;
    entry.info.status = "exited";
    entry.info.exit_code = exitCode;
    entry.exitedAt = Date.now();
    entry.child = undefined;
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
      .sort((a, b) => (a.exitedAt ?? a.info.started_at) - (b.exitedAt ?? a.info.started_at));
    for (const entry of exited) {
      if ((entry.exitedAt ?? now) + this.exitTtlMs <= now) this.remove(entry);
    }
    const excess = exited.length - this.maxExited;
    for (let i = 0; i < excess; i++) {
      const entry = exited[i]!;
      if (this.entries.has(entry.info.id)) this.remove(entry);
    }
  }

  private remove(entry: Entry): void {
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
