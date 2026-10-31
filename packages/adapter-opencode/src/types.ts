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
  /**
   * Keep an attachment's bytes somewhere the reader can fetch them later.
   *
   * A tool result carrying a screenshot larger than the inline cap cannot put
   * the picture in the event: every reader of the transcript would pay to load
   * it, and the event would be megabytes. It used to drop the bytes and keep
   * the filename, which left nothing to look at. This hands them to the sink
   * instead and returns the id the block refers to.
   *
   * Returns undefined when the sink has nowhere to put them; the block then
   * degrades exactly as it did before.
   */
  spillAttachment?(mime: string, base64: string): string | undefined;
}

/** What the caller knows about a session before this adapter re-reads it. */
export interface OpencodeSyncGuard {
  /** its stored events were written by an older mapping, so rebuild rather than append */
  stale?: (casfId: string) => boolean;
  /** another channel is driving it now; it is left to that channel untouched */
  taken?: (casfId: string) => boolean;
  /** this server just answered for it, so it owns the session */
  claimed?: (casfId: string) => void;
  /**
   * The live local sessions this driver owns (native id + the workspace they
   * were stored under). Sync diffs it against what the crawl found: a session
   * deleted while nobody was listening arrives as silence, so each miss gets
   * one direct lookup before it is believed gone.
   */
  local?: () => { id: string; directory?: string }[];
  /** a local session the reconcile pass confirmed the upstream deleted */
  reconciled?: (casfId: string) => void;
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
