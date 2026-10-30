// Command plane. Reads stay on the event log; anything the UI asks a backend
// to *do* goes through this interface. OpenCode implements the full set.
// A later backend implements the subset it can, and the UI hides the rest.

import type { EventInput, EventType } from "@agent-strata/schema";
import type { ProviderApi } from "./provider-auth";
import type { TerminalApi } from "./terminal";

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
  /** the transcript revision stored for a session; absent until one is marked */
  sessionRevision(sessionId: string): number | null;
  markRevision(sessionId: string, rev: number): void;
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

export interface CommandOpts extends PromptOpts {
  /** files and attachments that go along; commands take no text parts */
  parts?: PromptPart[];
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
  /** run a command in the session's shell with the agent answering (`!ls`) */
  shell?: boolean;
  /** file and attachment parts in a prompt; without it only text goes through */
  attachments?: boolean;
  revert?: boolean;
  fork?: boolean;
  summarize?: boolean;
  /** publish a session to the backend's share service and take it down again */
  share?: boolean;
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
  /** API keys for model providers; absent when this backend has none */
  providers?: ProviderApi;
  /** a shell in the session workspace; absent when this backend has no terminal */
  terminal?: TerminalApi;
}

export interface SyncGuard {
  /** the session's stored events were written by an older version of this mapping */
  stale?: (casfId: string) => boolean;
  /** another channel is driving this session right now, and it owns it */
  taken?: (casfId: string) => boolean;
  /**
   * This driver just read the session, so it owns it.
   *
   * Without this, a session that arrived through a sync is in the store with no
   * recorded owner — and the moment a second backend of the same kind connects,
   * "exactly one candidate" stops being true and the session becomes
   * unroutable, along with everything the user could do to it.
   */
  claimed?: (casfId: string) => void;
  /**
   * The live local sessions this driver owns (native id + the workspace they
   * were stored under). A driver that reconciles diffs it against what it
   * found upstream: a session deleted while nobody was listening arrives as
   * silence, so each miss gets one direct lookup before it is believed gone.
   */
  local?: () => { id: string; directory?: string }[];
  /** a local session the reconcile pass confirmed the backend deleted */
  reconciled?: (casfId: string) => void;
  /** sessions read so far / sessions found; fires once discovery knows the total */
  progress?(done: number, total: number): void;
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
  /** run one of the backend's commands; resolves once it has started */
  command?(nativeId: string, name: string, args: string, opts?: CommandOpts): Promise<void>;
  /**
   * Run a command in the session's shell, the agent answering for it.
   *
   * Not a local exec: this is what OpenCode's own composer does with a leading
   * `!`, and the reply arrives as an ordinary turn. Whether the command is
   * allowed is the backend's decision, surfacing as the same permission asks a
   * tool call produces.
   */
  shell?(nativeId: string, command: string, opts?: PromptOpts): Promise<void>;
  abort(nativeId: string, directory?: string): Promise<void>;
  mcpConnect?(name: string, directory?: string): Promise<void>;
  mcpDisconnect?(name: string, directory?: string): Promise<void>;
  /** OpenCode keeps this server until that process stops. */
  mcpAdd?(
    name: string,
    config: { type: "local"; command: string[] } | { type: "remote"; url: string },
    directory?: string,
  ): Promise<void>;
  mcpAuthStart?(
    name: string,
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<{ authorizationUrl?: string; oauthState?: string }>;
  mcpAuthFinish?(name: string, code: string, directory: string | undefined, signal: AbortSignal): Promise<void>;
  revert?(nativeId: string, messageId: string, directory?: string): Promise<void>;
  unrevert?(nativeId: string, directory?: string): Promise<void>;
  /**
   * Answer a question the backend asked, by the id it gave it.
   *
   * Separate from the promise the question arrives on, because that promise only
   * exists in the process that received the question. Answering one after a
   * restart goes through here instead.
   */
  replyPermission?(
    requestId: string,
    reply: "once" | "always" | "reject",
    directory?: string,
  ): Promise<unknown>;
  replyQuestion?(requestId: string, answers: string[][], directory?: string): Promise<unknown>;
  rejectQuestion?(requestId: string, directory?: string): Promise<unknown>;
  /** copies the messages before `beforeId`, or all of them without one */
  fork?(nativeId: string, beforeId: string | undefined, directory?: string): Promise<{ casfId: string; nativeId: string }>;
  summarize?(
    nativeId: string,
    directory?: string,
    model?: { providerID: string; modelID: string },
  ): Promise<void>;
  /** publish the session; resolves with the share URL when the backend hands one back */
  share?(nativeId: string, directory?: string): Promise<string | undefined>;
  unshare?(nativeId: string, directory?: string): Promise<void>;
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
  archive(nativeId: string, directory?: string, archived?: boolean): Promise<void>;
  deleteSession(nativeId: string, directory?: string): Promise<void>;
  nativeId(casfId: string): string | undefined;
}
