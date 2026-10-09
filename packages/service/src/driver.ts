// Command plane. Reads stay on the event log; anything the UI asks a backend
// to *do* goes through this interface. OpenCode implements the full set.
// A later backend implements the subset it can, and the UI hides the rest.

import type { EventInput, EventType } from "@agent-strata/schema";

/** Where backends write: the log, the live overlay, and in-place rebuilds. */
export interface BackendSink {
  append(events: EventInput[]): unknown;
  publish(events: EventInput[]): void;
  replaceSession(
    sessionId: string,
    events: EventInput[],
    opts: { replaceTypes: EventType[]; mapper?: string },
  ): number;
}

export interface ModelChoice {
  providerID: string;
  modelID: string;
  name: string;
  variants?: string[];
  /** model context window, when the backend publishes one */
  context?: number;
}

export interface PromptOpts {
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  /** project directory this session lives in; overrides the connection default */
  directory?: string;
}

export interface WorkspaceInfo {
  id?: string;
  name?: string;
  directory: string;
}

export interface BackendCapabilities {
  prompt: boolean;
  abort: boolean;
  models: boolean;
  agents: boolean;
  /** pull an existing native session's history into the event log */
  import: boolean;
  /** rename, archive, delete */
  manage: boolean;
}

export interface BackendDriver {
  id: string;
  backend: string;
  baseUrl: string;
  name?: string;
  directory?: string;
  capabilities: BackendCapabilities;
  stop(): void;
  createSession(opts?: { title?: string; directory?: string }): Promise<{ casfId: string; nativeId: string }>;
  prompt(nativeId: string, text: string, opts?: PromptOpts): Promise<void>;
  abort(nativeId: string, directory?: string): Promise<void>;
  listModels(): Promise<ModelChoice[]>;
  listAgents(): Promise<{ name: string; mode?: string }[]>;
  /** projects the backend already knows, plus any directory the caller can open */
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  /** emit session metadata for sessions that already exist, without their history */
  indexSessions(): Promise<string[]>;
  /** pull metadata and transcripts that changed since the last sync */
  sync(): Promise<number>;
  importSession(nativeId: string, directory?: string): Promise<void>;
  rename(nativeId: string, title: string, directory?: string): Promise<void>;
  archive(nativeId: string, directory?: string): Promise<void>;
  deleteSession(nativeId: string, directory?: string): Promise<void>;
  nativeId(casfId: string): string | undefined;
}
