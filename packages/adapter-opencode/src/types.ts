import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import type { EventInput, EventType } from "@agent-strata/schema";

export interface Sink {
  append(events: EventInput[]): unknown;
  /** live-only state such as a message still being written; never stored */
  publish?(events: EventInput[]): void;
  replaceSession?(
    sessionId: string,
    events: EventInput[],
    opts: { replaceTypes: EventType[]; mapper?: string },
  ): unknown;
  /** record which mapping wrote a session strata watched from its creation */
  markMapped?(sessionId: string, mapper: string): void;
  /**
   * The transcript revision the sink last recorded for a session, absent
   * until one is marked. Lets a sync skip re-reading a transcript the store
   * already holds, across restarts where memory would have forgotten it.
   */
  sessionRevision?(sessionId: string): number | null;
  markRevision?(sessionId: string, rev: number): void;
}

/** What the caller knows about a session before this adapter re-reads it. */
export interface OpencodeSyncGuard {
  /** its stored events were written by an older mapping, so rebuild rather than append */
  stale?: (casfId: string) => boolean;
  /** another channel is driving it now; it is left to that channel untouched */
  taken?: (casfId: string) => boolean;
  /** this server just answered for it, so it owns the session */
  claimed?: (casfId: string) => void;
  /** sessions read so far / sessions found; fires once discovery knows the total */
  progress?(done: number, total: number): void;
}

/** A piece of a prompt as OpenCode's prompt endpoint takes it. */
export type OpencodePromptPart = TextPartInput | FilePartInput;

export type OnAsk = (
  req: Extract<EventInput, { type: "permission.requested" }>,
) => Promise<{ decision: "allow" | "deny"; scope?: "once" | "always"; external?: boolean }>;

export type OnQuestion = (
  req: Extract<EventInput, { type: "question.asked" }>,
) => Promise<{ decision: "reply" | "reject"; answers?: string[][]; external?: boolean }>;
