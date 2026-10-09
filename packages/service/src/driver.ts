// Command plane. Reads stay on the event log; anything the UI asks a backend
// to *do* goes through this interface. OpenCode implements the full set.
// A later backend implements the subset it can, and the UI hides the rest.

export interface ModelChoice {
  providerID: string;
  modelID: string;
  name: string;
  variants?: string[];
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
  /** emit session.started for sessions that already exist, without their history */
  indexSessions(): Promise<string[]>;
  importSession(nativeId: string, directory?: string): Promise<void>;
  rename(nativeId: string, title: string, directory?: string): Promise<void>;
  archive(nativeId: string, directory?: string): Promise<void>;
  deleteSession(nativeId: string, directory?: string): Promise<void>;
  nativeId(casfId: string): string | undefined;
}
