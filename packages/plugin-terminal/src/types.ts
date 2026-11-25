export interface PtyShell {
  name: string;
  path: string;
  acceptable: boolean;
}

export type TerminalMode = "user" | "shared";
export type TerminalActor = "agent" | "user";
export type TerminalSignal = "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGTSTP" | "SIGHUP";
export type TerminalWaitReason = "output_idle" | "timeout" | "session_exit" | "aborted";

export interface PtyInfo {
  id: string;
  session_id: string;
  title: string;
  command: string;
  cwd: string;
  pid?: number;
  started_at: number;
  status: "running" | "exited";
  exit_code: number | null;
  mode: TerminalMode;
}

export interface PtyProcess {
  pid: number;
  exited: Promise<number>;
  terminal: {
    write(data: string | Uint8Array): number;
    resize(cols: number, rows: number): void;
    close(): void;
  };
  kill(signal?: number | NodeJS.Signals): void;
}

export interface PtySpawnInput {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  rows: number;
  cols: number;
  detached: boolean;
  onData(data: Uint8Array): void;
}

export type PtySpawn = (input: PtySpawnInput) => PtyProcess;
export type PtyCleanup = "exited" | "unconfirmed";
export type PtyTerminate = (child: PtyProcess, platform: NodeJS.Platform) => Promise<PtyCleanup>;
export type PtySignal = (
  child: PtyProcess,
  signal: TerminalSignal,
  platform: NodeJS.Platform,
) => Promise<void>;
export interface PtyCloseResult {
  cleanup: PtyCleanup;
}

export type PtyEvent =
  | { type: "data"; data: Uint8Array }
  | { type: "exit"; exitCode: number | null };

export interface PtyReadPage {
  data: Uint8Array;
  next_offset: number;
  dropped: boolean;
}

/** A synchronous value or the promise of it — a manager method may be either. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The surface the panel, the agent tools, and the lifecycle hooks share.
 * The local manager spawns on this machine; the remote one drives the
 * backend's own /pty API for sessions whose workspace lives there. Reads,
 * offsets, replays, and change events behave the same on both — output is
 * always buffered in this process, whoever owns the shell.
 */
export interface TerminalManager {
  create(input: import("./manager").PtyCreateInput): MaybePromise<PtyInfo>;
  list(sessionId?: string): PtyInfo[];
  listAgent(sessionId: string): PtyInfo[];
  get(sessionId: string, id: string): PtyInfo;
  getAgent(sessionId: string, id: string): PtyInfo;
  setMode(sessionId: string, id: string, mode: TerminalMode): PtyInfo;
  write(sessionId: string, id: string, data: string | Uint8Array, actor?: TerminalActor): number;
  signal(sessionId: string, id: string, signal: TerminalSignal, actor?: TerminalActor): Promise<void>;
  resize(sessionId: string, id: string, rows: number, cols: number): MaybePromise<void>;
  read(sessionId: string, id: string, offset?: number, maxBytes?: number): PtyReadPage;
  readAgent(sessionId: string, id: string, offset?: number, maxBytes?: number): PtyReadPage;
  attach(
    sessionId: string,
    id: string,
    listener: (event: PtyEvent) => void,
  ): { info: PtyInfo; replay: Uint8Array; unsubscribe: () => void };
  close(sessionId: string, id: string, actor?: TerminalActor): Promise<PtyCloseResult>;
  closeSession(sessionId: string): Promise<void>;
  closeInside(directory: string, inside: (root: string, target: string) => boolean): Promise<void>;
  closeAll(): Promise<void>;
  onChange(listener: (info: PtyInfo) => void): () => void;
}

/**
 * The piece of a backend's /pty API the remote manager drives. Structurally
 * satisfied by the service's opencode extension — the plugin never imports
 * the service, so the shape is restated here.
 */
export interface RemotePtyApi {
  shells(directory: string): Promise<PtyShell[]>;
  create(
    directory: string,
    input: { command?: string; args?: string[]; cwd?: string; title?: string; env?: Record<string, string>; rows?: number; cols?: number },
  ): Promise<{ id: string; title: string; command: string; cwd: string; status: string; pid?: number }>;
  remove(directory: string, id: string): Promise<void>;
  resize(directory: string, id: string, size: { rows: number; cols: number }): Promise<void>;
  open(directory: string, id: string, cursor?: number): Promise<{ url: string; headers: Record<string, string> }>;
}
