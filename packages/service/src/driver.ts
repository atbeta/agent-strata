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
  markMapped(sessionId: string, mapper: string): void;
}

export interface ModelChoice {
  providerID: string;
  modelID: string;
  name: string;
  variants?: string[];
  /** model context window, when the backend publishes one */
  context?: number;
}

/** One piece of a prompt. Paths are relative to the session's workspace. */
export type PromptPart =
  | { type: "text"; text: string }
  | {
      type: "file_ref";
      path: string;
      /** where the `@path` that picked it sits in the first text part */
      mention?: { start: number; end: number };
    }
  | { type: "attachment"; mime: string; /** a data: URL */ url: string; filename?: string };

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
  /** run the backend's own commands (`/init`, …) */
  commands?: boolean;
  /** file and attachment parts in a prompt; without it only text goes through */
  attachments?: boolean;
}

/**
 * Live state a backend holds outside any session's record: files, commands,
 * VCS. Read through on demand and never written to the log.
 */
export interface BackendExtension {
  kind: "opencode";
  /** the backend API paths a client may read */
  paths: ReadonlySet<string>;
  get(path: string, query: URLSearchParams, directory?: string, signal?: AbortSignal): Promise<Response>;
}

export interface SyncGuard {
  /** the session's stored events were written by an older version of this mapping */
  stale?: (casfId: string) => boolean;
  /** another channel is driving this session right now, and it owns it */
  taken?: (casfId: string) => boolean;
}

export interface BackendDriver {
  id: string;
  backend: string;
  /**
   * The agent that holds this driver's sessions. Two channels onto one agent
   * (an ACP stdio agent and that agent's own HTTP server) share it, which is
   * what makes their session ids line up as one identity.
   */
  agent: string;
  baseUrl: string;
  name?: string;
  directory?: string;
  capabilities: BackendCapabilities;
  /** absent for a backend with nothing beyond the command plane */
  extension?: BackendExtension;
  stop(): void;
  createSession(opts?: { title?: string; directory?: string }): Promise<{ casfId: string; nativeId: string }>;
  prompt(nativeId: string, parts: PromptPart[], opts?: PromptOpts): Promise<void>;
  abort(nativeId: string, directory?: string): Promise<void>;
  listModels(): Promise<ModelChoice[]>;
  listAgents(): Promise<{ name: string; mode?: string }[]>;
  /** projects the backend already knows, plus any directory the caller can open */
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  /** emit session metadata for sessions that already exist, without their history */
  indexSessions(): Promise<string[]>;
  /** version of the mapping behind this backend's stored events; absent when they cannot be rebuilt */
  mapperVersion?: string;
  /** pull metadata and transcripts that changed since the last sync; stale sessions are rebuilt instead */
  sync(guard?: SyncGuard): Promise<number>;
  /** replace a session's stored transcript with a fresh read of the backend's own record */
  rebuild(nativeId: string, directory?: string): Promise<number>;
  importSession(nativeId: string, directory?: string): Promise<void>;
  rename(nativeId: string, title: string, directory?: string): Promise<void>;
  archive(nativeId: string, directory?: string): Promise<void>;
  deleteSession(nativeId: string, directory?: string): Promise<void>;
  nativeId(casfId: string): string | undefined;
}
