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
}

export interface BackendCapabilities {
  prompt: boolean;
  abort: boolean;
  models: boolean;
  agents: boolean;
  /** pull an existing native session's history into the event log */
  import: boolean;
}

export interface BackendDriver {
  id: string;
  backend: string;
  baseUrl: string;
  name?: string;
  directory?: string;
  capabilities: BackendCapabilities;
  stop(): void;
  createSession(opts?: { title?: string }): Promise<{ casfId: string; nativeId: string }>;
  prompt(nativeId: string, text: string, opts?: PromptOpts): Promise<void>;
  abort(nativeId: string): Promise<void>;
  listModels(): Promise<ModelChoice[]>;
  listAgents(): Promise<{ name: string; mode?: string }[]>;
  /** emit session.started for sessions that already exist, without their history */
  indexSessions(): Promise<string[]>;
  importSession(nativeId: string): Promise<void>;
  nativeId(casfId: string): string | undefined;
}
