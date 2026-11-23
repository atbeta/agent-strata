/**
 * What a memory entry is.
 *
 * An entry is one fact, written once and read by every later session. The
 * shape is deliberately flat: the reader edits it by hand, the agent edits it
 * through a tool, and both must see the same fields.
 */

export type MemoryScope = "global" | "workspace";

/** Where an entry came from. The reader's own edit is not the agent's claim. */
export type MemorySource = "agent" | "user";

export interface MemoryEntry {
  id: string;
  /** The fact itself: one sentence, self-contained, no pronouns pointing back at the conversation. */
  text: string;
  /** Disabled entries stay in the file and are not injected. */
  enabled: boolean;
  /**
   * A stable name for the fact, so a later write replaces it instead of
   * piling up beside it. `deploy.prod` rather than free text.
   */
  key?: string;
  source: MemorySource;
  created_at: string;
  updated_at: string;
}

export interface MemoryFile {
  version: 1;
  /** Bumped on every write; a reader that saw an older one knows to re-read. */
  revision: number;
  memories: MemoryEntry[];
}

/** A workspace the plugin has seen, so the settings page can offer it. */
export interface WorkspaceEntry {
  key: string;
  path: string;
  last_used: string;
}

export interface WorkspaceIndex {
  version: 1;
  workspaces: WorkspaceEntry[];
}

export const EMPTY_FILE: MemoryFile = { version: 1, revision: 0, memories: [] };
