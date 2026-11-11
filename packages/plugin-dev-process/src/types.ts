import type { DevStopResult } from "@agent-strata/api";

export type DevState = "running" | "stopped" | "lost" | "orphaned";

export interface DevLost {
  /** `gone`: the pid is dead. `reused`: the number is alive, but it is a different process. */
  process: "gone" | "reused";
  /** Whether the recorded port still accepts a connection. Absent when no port was recorded. */
  port_held?: boolean;
  /** Pids listening on that port, when any could be named. */
  port_holders?: number[];
}

/** One running command, as the UI and the agent both see it. */
export interface DevProcess {
  id: string;
  session_id: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  started_at: number;
  /** Undefined while it runs; the exit code once it has stopped. */
  exit_code: number | null;
  /** True when it stopped because someone asked it to. */
  stopped: boolean;
  /** Set when the spawn itself failed, before a pid existed. */
  error?: string;
  /** Last line of output, for a one-line status. */
  last_line?: string;
  /** The port it was asked to listen on, when the caller named one. */
  port?: number;
  /**
   * Whether it has proved it can serve.
   *
   * `unknown` is the honest answer for a command nobody named a port for: a
   * dev server that prints nothing recognisable is not a failure, and calling
   * it ready would be a guess.
   */
  ready?: "yes" | "no" | "unknown";
  /** How long the port took to answer, when it answered. */
  ready_ms?: number;
  /** Where it is in its life. */
  state?: DevState;
  /** When it stopped, for a record that outlived its process. */
  stopped_at?: number;
  /** The shell the command ran in, so a caller knows what syntax it accepted. */
  shell?: string;
  /** Set when `state` is `lost`: whether the process and its port are still there. */
  lost?: DevLost;
}

export interface DevLogLine {
  /** Monotonic per process. Pass the last one back as `offset` to read only what followed. */
  seq: number;
  at: number;
  stream: "out" | "err";
  text: string;
  /** Written by the service, not by the command. A restart leaves one of these. */
  marker?: boolean;
}

/** One read of a process's output, plus the cursor for the next read. */
export interface DevLogPage {
  lines: DevLogLine[];
  /** Pass this as `offset` to receive only lines written after this page. */
  next_offset: number;
  /** Lines the cursor asked for had already fallen out of the retained window. */
  dropped: boolean;
}

export interface DevStartInput {
  session_id: string;
  command: string;
  cwd: string;
  /**
   * The port the command is expected to serve on.
   *
   * Given one, `start` waits until it accepts a connection before returning, so
   * a caller that needs the server up does not have to sleep and guess. Omitted,
   * a port printed in the output is used instead; failing that, `start` returns
   * as soon as the process has proved it did not exit immediately.
   */
  port?: number;
  /** How long to wait for the port, in milliseconds. */
  waitMs?: number;
}

/** One record as it is written down, so a later run can finish the story. */
export interface PersistedProcess {
  id: string;
  session_id: string;
  command: string;
  cwd: string;
  pid?: number;
  started_at: number;
  port?: number;
  state: DevState;
  exit_code?: number | null;
  stopped_at?: number;
  lost?: DevLost;
}

export type DevEvent =
  | { type: "dev.started"; session_id: string; process: DevProcess }
  | { type: "dev.output"; session_id: string; process_id: string; line: DevLogLine }
  | { type: "dev.exited"; session_id: string; process: DevProcess }
  | { type: "dev.removed"; session_id: string; process_id: string };

export interface DevManager {
  start(input: DevStartInput): Promise<DevProcess>;
  list(sessionID?: string): DevProcess[];
  get(id: string): DevProcess | undefined;
  logs(id: string, tail?: number): DevLogLine[];
  /** Lines after a cursor. `offset` is a seq; `since` is a timestamp in ms. */
  readLogs(id: string, query?: { tail?: number; since?: number; offset?: number }): DevLogPage;
  /** Stop a command, and say what is left of it. */
  stop(id: string): Promise<DevStopResult>;
  /**
   * Drop a finished record.
   *
   * Only a record with no live process can go: a running command's entry is
   * the handle that can stop it, and forgetting that handle would leave the
   * process holding a port with nothing able to name it. Returns false when
   * the id is already gone.
   */
  forget(id: string): boolean;
  /**
   * Stop a command and start the same one again, under the same id.
   *
   * The id is what a caller remembered. A stop followed by a start mints a
   * new one and throws that memory away.
   */
  restart(id: string): Promise<DevProcess>;
  /** Every process a session owns, stopped together. Called when a session goes away. */
  stopSession(sessionID: string): Promise<number>;
  stopAll(): Promise<void>;
  /** Kill what a previous run left behind. Called once, at startup. */
  reapStale(): Promise<number>;
  subscribe(listener: (event: DevEvent) => void): () => void;
}

export interface DevManagerOptions {
  /**
   * Where the live process table is written.
   *
   * A service that is killed outright cannot run `stopAll`, so its dev servers
   * outlive it. The file is the only thing that survives to tell the next run
   * what to clean up.
   */
  pidFile?: string;
}
