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
