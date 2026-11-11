import type { Part } from "@opencode-ai/sdk/v2";
import {
  REBUILDABLE_EVENT_TYPES,
  type AssistantStep,
  type ContentBlock,
  type EventInput,
  type EventType,
  type RetryAction,
  type SessionDiagnostic,
} from "@agent-strata/schema";

export const SHELL_PERMS = new Set(["bash", "pwsh", "powershell", "cmd"]);

// OpenCode clocks are unix milliseconds. Fixture and synthetic values below
// this are not real instants, so those events keep the ingest clock.
const REAL_INSTANT_MS = 1_000_000_000_000;

export function sourceTime(ms?: number): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms < REAL_INSTANT_MS) return undefined;
  return new Date(ms).toISOString();
}

/** A content part's clock, kept only when the stamps are real instants. */
export function contentTimes(time?: { start: number; end?: number }): {
  started_ms?: number;
  ended_ms?: number;
} {
  const started_ms =
    time != null && Number.isFinite(time.start) && time.start >= REAL_INSTANT_MS ? time.start : undefined;
  const ended_ms =
    time?.end != null && Number.isFinite(time.end) && time.end >= REAL_INSTANT_MS ? time.end : undefined;
  return {
    ...(started_ms !== undefined ? { started_ms } : {}),
    ...(ended_ms !== undefined ? { ended_ms } : {}),
  };
}

/** One shape for a path: separators unified, and a Windows drive path compared without case. */
export function pathKey(path: string): string {
  const p = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p;
}

/** The sentence a failed assistant message carries. OpenCode puts it on the message, not in a part. */
export function assistantFailure(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: { message?: unknown } }).data;
  if (data && typeof data.message === "string" && data.message.trim()) return data.message;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name ? name : undefined;
}

export function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * What a deliberate stop looks like on the wire: OpenCode reports the abort it
 * ran as a session error. It is not a failure — a run that ended on the
 * reader's word must not paint the session as crashed, so the diagnostic is
 * dropped while the session stills the same way a real error would.
 */
function abortMessage(message: string): boolean {
  const text = message.trim().toLowerCase();
  return text === "aborted" || text === "the operation was aborted" || text === "the operation was aborted.";
}

/**
 * A stop the reader asked for, as opposed to a provider failure that happens
 * to be named `AbortError`. OpenCode's own abort is `MessageAbortedError`.
 * A bare `AbortError` only counts when the message is the abort wording —
 * matching the name alone swallowed unrelated provider failures.
 */
export function abortedDiagnostic(d: SessionDiagnostic): boolean {
  if (d.name === "MessageAbortedError") return true;
  if (d.name === "AbortError") return abortMessage(d.message);
  if (d.name !== undefined) return false;
  return abortMessage(d.message);
}

/** Only diagnostics that are safe to persist and show. Provider payloads and metadata stay behind. */
export function sessionDiagnostic(error: unknown): SessionDiagnostic {
  const outer = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const data = outer.data && typeof outer.data === "object" ? (outer.data as Record<string, unknown>) : {};
  const name = textField(outer.name);
  const message = textField(data.message) ?? name ?? "Unknown session error";
  const statusCode = typeof data.statusCode === "number" && Number.isInteger(data.statusCode) ? data.statusCode : undefined;
  const retries = typeof data.retries === "number" && Number.isInteger(data.retries) && data.retries >= 0 ? data.retries : undefined;
  return {
    message,
    ...(name ? { name } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(typeof data.isRetryable === "boolean" ? { isRetryable: data.isRetryable } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(textField(data.ref) ? { ref: textField(data.ref) } : {}),
    ...(textField(data.providerID) ? { providerID: textField(data.providerID) } : {}),
  };
}

export function recoveryAction(action: unknown): RetryAction | undefined {
  if (!action || typeof action !== "object") return undefined;
  const raw = action as Record<string, unknown>;
  const out: RetryAction = {
    ...(textField(raw.reason) ? { reason: textField(raw.reason) } : {}),
    ...(textField(raw.provider) ? { provider: textField(raw.provider) } : {}),
    ...(textField(raw.title) ? { title: textField(raw.title) } : {}),
    ...(textField(raw.message) ? { message: textField(raw.message) } : {}),
    ...(textField(raw.label) ? { label: textField(raw.label) } : {}),
    ...(textField(raw.link) ? { link: textField(raw.link) } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

// Deltas arrive per token; a reader needs about twenty frames a second.
export const STREAM_SNAPSHOT_MS = 50;

/** Bump when the mapping changes; stored sessions mapped by an older version are rebuilt. */
export const OPENCODE_MAPPER_VERSION = "opencode-16";

/** The event types an import reproduces from OpenCode's own record of a session. */
export const OPENCODE_REBUILT_TYPES: EventType[] = [...REBUILDABLE_EVENT_TYPES];

export type ToolPart = Extract<Part, { type: "tool" }>;

export interface ToolTrack {
  emittedCall: boolean;
  emittedResult: boolean;
  order: number;
  /** latest state of a part seen before its message named the turn */
  deferred?: ToolPart;
  /** the newest state this part was seen in, so a stall check can tell a running tool from a waiting one */
  status?: string;
  /** the child session this call opened, once any update has named one */
  child?: string;
}

export interface MsgState {
  role?: string;
  parentID?: string;
  created?: number;
  completed?: number;
  parts: Map<string, ContentBlock>;
  toolParts: Map<string, ToolTrack>;
  emittedAssistant: boolean;
  streamRetired?: boolean;
  /**
   * Parts first stored after streaming was retired. Later updates of those
   * parts are the reply arriving late, and they stay. A part that was already
   * stored is left alone — a replay after idle must not rewrite it.
   */
  lateParts?: Set<string>;
  /** message.updated declared this a compaction summary while parts still stream */
  summary?: boolean;
  lastStreamAt?: number;
  /** parts a live delta has extended */
  streamed?: Set<string>;
  patchSeen?: Set<string>;
  /** files a successful edit or write in this message already reported, by pathKey */
  editedPaths?: Set<string>;
  /** compaction parts this message already emitted, by part.id */
  compactionSeen?: Set<string>;
  /** one entry per model call this message ran, keyed by the step part's id */
  steps?: Map<string, AssistantStep>;
  /**
   * A close path (idle or error) already wrote this message's durable final
   * with `stop_reason: "interrupted"`. A real completion may still arrive and
   * replace it — unlike an ordinary final, an interrupted one is not the last
   * word.
   */
  interrupted?: boolean;
}

export interface MapperOptions {
  directory?: string;
  now?: () => number;
  /**
   * Where an attachment too big to inline goes. See `attachmentBlocks`.
   * Absent means the old behaviour: the reference is kept, the bytes are
   * not.
   */
  spill?: (mime: string, base64: string) => string | undefined;
}

export type SessionEventFactory<T> = (
  session: T,
  kind: EventInput["type"],
  data: unknown,
  id?: string,
  ts?: string,
) => EventInput;
