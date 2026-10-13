import {
  createOpencodeClient,
  type Event,
  type FilePartInput,
  type OpencodeClient,
  type Part,
  type Session,
  type TextPartInput,
} from "@opencode-ai/sdk/v2";
import {
  isStreamingSnapshot,
  makeEvent,
  type ContentBlock,
  type EventInput,
  type EventType,
} from "@agent-strata/schema";
import { evaluate, type Policy } from "@agent-strata/policy";
import { createPatch } from "diff";

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
}

/** What the caller knows about a session before this adapter re-reads it. */
export interface OpencodeSyncGuard {
  /** its stored events were written by an older mapping, so rebuild rather than append */
  stale?: (casfId: string) => boolean;
  /** another channel is driving it now; it is left to that channel untouched */
  taken?: (casfId: string) => boolean;
  /** this server just answered for it, so it owns the session */
  claimed?: (casfId: string) => void;
}

/** A piece of a prompt as OpenCode's prompt endpoint takes it. */
export type OpencodePromptPart = TextPartInput | FilePartInput;

export type OnAsk = (
  req: Extract<EventInput, { type: "permission.requested" }>,
) => Promise<{ decision: "allow" | "deny"; scope?: "once" | "always"; external?: boolean }>;

export type OnQuestion = (
  req: Extract<EventInput, { type: "question.asked" }>,
) => Promise<{ decision: "reply" | "reject"; answers?: string[][] }>;

const SHELL_PERMS = new Set(["bash", "pwsh", "powershell", "cmd"]);

/** OpenCode's global bus wraps the event, and newer servers put the body in `data`. */
export function normalizeOpencodeEvent(raw: unknown): Event | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  let evt = raw as Record<string, unknown>;
  if (evt.payload && typeof evt.payload === "object") evt = evt.payload as Record<string, unknown>;
  if (evt.data && typeof evt.data === "object" && !evt.properties) {
    evt = { ...evt, properties: evt.data };
  }
  if (typeof evt.type !== "string") return undefined;
  return evt as unknown as Event;
}

function eventSessionID(evt: Event): string | undefined {
  if (!("properties" in evt) || !evt.properties || typeof evt.properties !== "object") return undefined;
  const id = (evt.properties as { sessionID?: unknown }).sessionID;
  return typeof id === "string" ? id : undefined;
}

/** `/global/event` wraps the payload and names the project directory beside it. */
function eventDirectory(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const dir = (raw as { directory?: unknown }).directory;
  return typeof dir === "string" && dir.length > 0 ? dir : undefined;
}

// OpenCode clocks are unix milliseconds. Fixture and synthetic values below
// this are not real instants, so those events keep the ingest clock.
function sourceTime(ms?: number): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms < 1_000_000_000_000) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Providers the model picker may offer.
 *
 * OpenCode's `connected` list also names every sibling that shares an env var
 * with a key the user stored (`source: "api"`). Those siblings send that key
 * to a different product and the request fails. A provider that is itself only
 * an env var stays, because that var is the credential.
 */
export function pickableProviders<T extends { id: string }>(
  all: readonly T[],
  connected: readonly string[] | undefined,
): T[] {
  const listed = connected ? all.filter((row) => connected.includes(row.id)) : [...all];
  const claimed = new Set<string>();
  for (const row of listed) {
    if (providerSource(row) !== "api") continue;
    for (const name of providerEnv(row)) claimed.add(name);
  }
  if (claimed.size === 0) return listed;
  return listed.filter(
    (row) => providerSource(row) !== "env" || !providerEnv(row).some((name) => claimed.has(name)),
  );
}

function providerSource(row: { id: string }): string | undefined {
  const source = (row as { source?: unknown }).source;
  return typeof source === "string" ? source : undefined;
}

function providerEnv(row: { id: string }): string[] {
  const env = (row as { env?: unknown }).env;
  if (!Array.isArray(env)) return [];
  return env.filter((name): name is string => typeof name === "string" && name.length > 0);
}

/** One shape for a path: separators unified, and a Windows drive path compared without case. */
function pathKey(path: string): string {
  const p = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p;
}

/**
 * The change a finished edit or write made. An edit carries OpenCode's own
 * unified diff in its metadata; a write carries the whole new file.
 */
function fileChangeOf(
  tool: string,
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): { path: string; change: "add" | "modify"; diff: string; whole_file?: true } | undefined {
  const { filePath, oldString, newString, content } = input ?? {};
  if (typeof filePath !== "string") return undefined;
  if (tool === "edit") {
    const filediff = metadata?.filediff as { patch?: unknown } | undefined;
    const patch = typeof filediff?.patch === "string" ? filediff.patch : metadata?.diff;
    if (typeof patch === "string" && patch) return { path: filePath, change: "modify", diff: patch };
    if (typeof oldString === "string" && typeof newString === "string") {
      return { path: filePath, change: "modify", diff: createPatch(filePath, oldString, newString) };
    }
    return undefined;
  }
  if (tool === "write" && typeof content === "string") {
    return {
      path: filePath,
      change: metadata?.exists === false ? "add" : "modify",
      diff: createPatch(filePath, "", content),
      whole_file: true,
    };
  }
  return undefined;
}

/** The child session a task tool opened. Only that tool's metadata.sessionId names one. */
function taskChild(tool: string, metadata: Record<string, unknown> | undefined): string | undefined {
  if (tool !== "task" || !metadata) return undefined;
  const id = metadata.sessionId;
  if (typeof id !== "string" || !id) return undefined;
  return id.startsWith("opencode:") ? id : `opencode:${id}`;
}

/** The sentence a failed assistant message carries. OpenCode puts it on the message, not in a part. */
function assistantFailure(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: { message?: unknown } }).data;
  if (data && typeof data.message === "string" && data.message.trim()) return data.message;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name ? name : undefined;
}

// Deltas arrive per token; a reader needs about twenty frames a second.
export const STREAM_SNAPSHOT_MS = 50;

/** How long a command may take to fail before it counts as started. */
export const COMMAND_START_MS = 1_500;

export class UnknownCommandError extends Error {
  constructor(name: string) {
    super(`unknown command: /${name}`);
    this.name = "UnknownCommandError";
  }
}

function mcpAuthFailure(text: string, secret = ""): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 200 || (secret.length >= 8 && trimmed.includes(secret))) return "mcp auth failed";
  return trimmed;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const data = (e as { data?: { message?: unknown } })?.data;
  if (data && typeof data.message === "string" && data.message) return data.message;
  const direct = (e as { message?: unknown })?.message;
  if (typeof direct === "string" && direct) return direct;
  const text = typeof e === "string" ? e : JSON.stringify(e);
  return !text || text === "{}" ? "opencode server error" : text;
}

/** Shown when a prompt was refused or never accepted. Callers must not repeat the text. */
export const PROMPT_NOT_ACCEPTED = "prompt was not accepted";

export function promptFailure(err: unknown, text: string): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return PROMPT_NOT_ACCEPTED;
  const message = errorMessage(err);
  const sample = text.trim().slice(0, 80);
  if (!message || message.length > 300 || (sample.length >= 12 && message.includes(sample))) return PROMPT_NOT_ACCEPTED;
  return message;
}

/** Bump when the mapping changes; stored sessions mapped by an older version are rebuilt. */
export const OPENCODE_MAPPER_VERSION = "opencode-6";

/** The event types an import reproduces from OpenCode's own record of a session. */
export const OPENCODE_REBUILT_TYPES: EventType[] = [
  "session.started",
  "session.updated",
  "session.compacted",
  "turn.user",
  "turn.assistant",
  "tool.call",
  "tool.result",
  "file.changed",
];

export interface SnapshotMessage {
  info: { id: string; role: string; time?: { created?: number; completed?: number } };
  parts: Part[];
}

/** OpenCode's stored session, replayed as the bus events that would have built it. */
export function snapshotEvents(sessionID: string, info: unknown, messages: SnapshotMessage[]): Event[] {
  const part = (p: Part) =>
    ({
      id: `import:${p.id}`,
      type: "message.part.updated",
      properties: { sessionID, part: p, time: Date.now() },
    }) as unknown as Event;
  const out: Event[] = [
    { id: `import:${sessionID}`, type: "session.created", properties: { sessionID, info } } as unknown as Event,
  ];
  for (const m of messages) {
    const open = m.info.role === "assistant" && m.info.time?.completed === undefined;
    // parts first: a completed assistant message emits turn.assistant on message.updated
    for (const p of m.parts) out.push(part(p));
    out.push({
      id: `import:${m.info.id}`,
      type: "message.updated",
      properties: { sessionID, info: m.info },
    } as unknown as Event);
    // role and parent land on message.updated, so an in-progress assistant
    // only streams once the parts are applied a second time
    if (open) for (const p of m.parts) out.push(part(p));
  }
  return out;
}

/** Every rebuildable event for one session, mapped from scratch. */
export function rebuildEvents(events: Event[], directory?: string): EventInput[] {
  const mapper = new OpencodeMapper({ directory });
  return events
    .flatMap((e) => mapper.handle(e))
    .filter((e) => !isStreamingSnapshot(e) && OPENCODE_REBUILT_TYPES.includes(e.type));
}

type ToolPart = Extract<Part, { type: "tool" }>;

// The desktop renders images only from data: and blob: URLs (img-src CSP),
// so a remote image stays a file reference.
function fileBlock(part: Extract<Part, { type: "file" }>): ContentBlock {
  const inline = part.url.startsWith("data:");
  if (inline && part.mime.startsWith("image/")) {
    const comma = part.url.indexOf(",");
    if (comma > 0 && part.url.slice(0, comma).endsWith(";base64"))
      return { type: "image", mime: part.mime, data: part.url.slice(comma + 1) };
  }
  if (part.source && "path" in part.source) return { type: "file_ref", path: part.source.path };
  return { type: "file_ref", path: part.filename ?? (inline ? part.mime : part.url) };
}

interface ToolTrack {
  emittedCall: boolean;
  emittedResult: boolean;
  order: number;
  /** latest state of a part seen before its message named the turn */
  deferred?: ToolPart;
}

interface MsgState {
  role?: string;
  parentID?: string;
  created?: number;
  completed?: number;
  parts: Map<string, ContentBlock>;
  toolParts: Map<string, ToolTrack>;
  emittedAssistant: boolean;
  lastStreamAt?: number;
  /** parts a live delta has extended */
  streamed?: Set<string>;
  patchSeen?: Set<string>;
  /** files a successful edit or write in this message already reported, by pathKey */
  editedPaths?: Set<string>;
  /** compaction parts this message already emitted, by part.id */
  compactionSeen?: Set<string>;
}

interface SessionState {
  sessionID: string;
  casfId: string;
  started: boolean;
  /**
   * We met this session through one of its messages rather than through a
   * session.created, so the started event went out with no clock to put on it.
   * The next session event carries the real one and re-stamps it.
   */
  startedBlind?: boolean;
  updated?: number;
  messages: Map<string, MsgState>;
  pendingUserMsgs: Set<string>;
  /** last title / directory / archive we emitted, so cost-only session.updated stays quiet */
  metaSeen?: boolean;
  title?: string;
  workspace?: string;
  archived?: boolean;
  parent?: string;
  /** last revert message id we emitted; cleared after revert: null */
  revertMessageID?: string;
}

export class OpencodeMapper {
  sessions = new Map<string, SessionState>();
  /** assistant messages with text no snapshot has carried yet, by message id */
  private held = new Map<string, { s: SessionState; m: MsgState }>();

  constructor(private opts: { directory?: string; now?: () => number } = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A snapshot of a held message, unless the last one went out inside the window. */
  private streamSnapshot(messageID: string): EventInput | undefined {
    const held = this.held.get(messageID);
    if (!held) return undefined;
    const { s, m } = held;
    if (m.emittedAssistant || !m.parentID) {
      this.held.delete(messageID);
      return undefined;
    }
    const now = this.now();
    if (now - (m.lastStreamAt ?? 0) < STREAM_SNAPSHOT_MS) return undefined;
    this.held.delete(messageID);
    const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
    if (!content.length) return undefined;
    m.lastStreamAt = now;
    return this.ev(
      s,
      "turn.assistant",
      { turn_id: m.parentID, msg_id: messageID, partial: true, content },
      `opencode:${messageID}:assistant.partial:${Bun.hash(JSON.stringify(content)).toString(36)}`,
      // A snapshot has no clock of its own; the ingest clock would make it the
      // newest thing in a replayed session and reorder the session list.
      sourceTime(m.created ?? s.updated),
    );
  }

  hasHeldStreams(): boolean {
    return this.held.size > 0;
  }

  /** Frames the window held back, for the ones whose window has passed. */
  flushStreaming(): EventInput[] {
    const out: EventInput[] = [];
    for (const messageID of [...this.held.keys()]) {
      const snap = this.streamSnapshot(messageID);
      if (snap) out.push(snap);
    }
    return out;
  }

  ev(
    s: SessionState,
    kind: EventInput["type"],
    data: unknown,
    id?: string,
    ts?: string,
  ): EventInput {
    const base = makeEvent({
      session_id: s.casfId,
      source: { backend: "opencode", native_id: s.sessionID },
      type: kind,
      data,
      ...(ts ? { ts } : {}),
    } as EventInput);
    if (id) base.id = id;
    return base;
  }

  private ensureSession(sessionID: string): { s: SessionState; out: EventInput[] } {
    const out: EventInput[] = [];
    let s = this.sessions.get(sessionID);
    if (!s) {
      s = {
        sessionID,
        casfId: `opencode:${sessionID}`,
        started: false,
        messages: new Map(),
        pendingUserMsgs: new Set(),
      };
      this.sessions.set(sessionID, s);
    }
    if (!s.started) {
      s.started = true;
      s.startedBlind = true;
      out.push(
        this.ev(
          s,
          "session.started",
          { workspace: this.opts.directory ?? "unknown" },
          `opencode:${sessionID}:session.started`,
        ),
      );
    } else if (s.startedBlind && s.updated != null) {
      // The store rewrites a stored event's clock when it is handed a source
      // one, so re-sending the same event id with the real time corrects the
      // timestamp connect already wrote, instead of adding a second row. It
      // waits for a real clock rather than taking a second wrong one.
      const at = sourceTime(s.updated);
      if (at) {
        s.startedBlind = false;
        out.push(
          this.ev(
            s,
            "session.started",
            { workspace: this.opts.directory ?? "unknown" },
            `opencode:${sessionID}:session.started`,
            at,
          ),
        );
      }
    }
    return { s, out };
  }

  // session.created records the baseline. It emits when already archived, or
  // when the created payload already carries a revert (import / rebuild).
  // session.updated emits when title, directory, archive, or revert actually changes.
  private syncMeta(
    s: SessionState,
    info: {
      title?: string;
      directory?: string;
      parentID?: string;
      time?: { updated?: number; created?: number; archived?: number };
      revert?: { messageID: string };
    },
    source: "created" | "updated",
  ): EventInput | undefined {
    const title = info.title;
    const workspace = info.directory;
    const archived = (info.time?.archived ?? 0) > 0;
    const parent = info.parentID ? `opencode:${info.parentID}` : s.parent;
    const revertID = info.revert?.messageID || undefined;
    if (info.time?.updated || info.time?.created) {
      s.updated = info.time.updated ?? info.time.created ?? s.updated;
    }
    const changed =
      !s.metaSeen ||
      s.title !== title ||
      s.workspace !== workspace ||
      s.archived !== archived ||
      (info.parentID !== undefined && s.parent !== parent) ||
      revertID !== s.revertMessageID;
    s.metaSeen = true;
    s.title = title;
    s.workspace = workspace;
    s.archived = archived;
    if (info.parentID) s.parent = parent;
    if (!changed) return;
    if (source === "created" && !archived && !revertID) return;
    const stamp = info.time?.updated ?? info.time?.archived ?? 0;
    // { turn_id } while set; null only on the clear; omit if this session never had one.
    let revert: { turn_id: string } | null | undefined;
    if (revertID) {
      revert = { turn_id: revertID };
      s.revertMessageID = revertID;
    } else if (s.revertMessageID !== undefined) {
      revert = null;
      s.revertMessageID = undefined;
    }
    // A clear must not hash like a session that never had a revert: the store
    // keeps the first body for a given id, so a colliding clear would be dropped.
    const hash = Bun.hash(
      `${title ?? ""}\0${workspace ?? ""}\0${archived ? 1 : 0}${info.parentID ? `\0${info.parentID}` : ""}${revertID ? `\0${revertID}` : revert === null ? "\0" : ""}`,
    ).toString(36);
    return this.ev(
      s,
      "session.updated",
      {
        title,
        workspace,
        archived,
        ...(parent ? { parent_session_id: parent } : {}),
        ...(revert !== undefined ? { revert } : {}),
      },
      `opencode:${s.sessionID}:session.updated:${stamp}:${hash}`,
      sourceTime(info.time?.updated ?? info.time?.archived),
    );
  }

  private ensureMsg(s: SessionState, messageID: string): MsgState {
    let m = s.messages.get(messageID);
    if (!m) {
      m = {
        parts: new Map(),
        toolParts: new Map(),
        emittedAssistant: false,
      };
      s.messages.set(messageID, m);
    }
    return m;
  }

  private flushUser(s: SessionState, out: EventInput[], msgID: string) {
    if (!s.pendingUserMsgs.delete(msgID)) return;
    const m = s.messages.get(msgID);
    if (!m) return;
    const content = [...m.parts.values()].filter((b) => b.type !== "thinking");
    if (!content.length) return;
    out.push(
      this.ev(
        s,
        "turn.user",
        { turn_id: msgID, content },
        `opencode:${msgID}:turn.user`,
        sourceTime(m.created ?? s.updated),
      ),
    );
  }

  private toolEvents(s: SessionState, m: MsgState, part: ToolPart, t: ToolTrack): EventInput[] {
    const out: EventInput[] = [];
    const st = part.state;
    const child = taskChild(part.tool, st.status === "pending" ? undefined : st.metadata);
    if (!t.emittedCall && st.status !== "pending") {
      t.emittedCall = true;
      out.push(
        this.ev(
          s,
          "tool.call",
          {
            turn_id: m.parentID ?? part.messageID,
            call_id: part.callID,
            tool: part.tool,
            input: st.input,
            order: t.order,
            // `order` counts only within this message. Naming the message
            // too is what lets a reader see a call beside the words that
            // asked for it instead of in a pile at the end of the turn.
            msg_id: part.messageID,
            ...(child ? { child_session_id: child } : {}),
          },
          `opencode:${part.id}:tool.call`,
          sourceTime(st.time.start || s.updated),
        ),
      );
    }
    if (!t.emittedResult && (st.status === "completed" || st.status === "error")) {
      t.emittedResult = true;
      out.push(
        this.ev(
          s,
          "tool.result",
          {
            call_id: part.callID,
            status: st.status === "completed" ? "ok" : "error",
            output: st.status === "completed" ? st.output : st.error,
            latency_ms: Math.max(0, Math.round(st.time.end - st.time.start)),
            ...(child ? { child_session_id: child } : {}),
          },
          `opencode:${part.id}:tool.result`,
          sourceTime(st.time.end || s.updated),
        ),
      );
      if (st.status === "completed") {
        const change = fileChangeOf(part.tool, st.input, st.metadata);
        if (change) {
          out.push(
            this.ev(
              s,
              "file.changed",
              { ...change, call_id: part.callID },
              `opencode:${part.id}:file`,
              sourceTime(st.time.end || s.updated),
            ),
          );
        }
      }
    }
    return out;
  }

  handle(evt: Event): EventInput[] {
    const out: EventInput[] = [];
    const props = "properties" in evt ? evt.properties : undefined;
    const sessionID =
      props && "sessionID" in props ? (props.sessionID as string) : undefined;

    switch (evt.type) {
      case "session.created": {
        const p = evt.properties;
        // A message can arrive before session.created. That first event already
        // stored session.started under a stable id, so a second started event
        // cannot replace its workspace. Publish the real directory as an update.
        const already = this.sessions.get(p.sessionID)?.started === true;
        // Seeded before ensureSession so that a session we only knew through a
        // message can already be re-stamped by it; after, the clock this event
        // carries would arrive too late for the check that wants it.
        const known = this.sessions.get(p.sessionID);
        if (known) known.updated = p.info.time?.updated ?? p.info.time?.created ?? known.updated;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        s.updated = p.info.time?.updated ?? p.info.time?.created ?? s.updated;
        if (!already) {
          const i = out.findIndex((e) => e.type === "session.started");
          const started = this.ev(
            s,
            "session.started",
            {
              workspace: p.info.directory,
              title: p.info.title,
              parent_session_id: p.info.parentID ? `opencode:${p.info.parentID}` : undefined,
            },
            `opencode:${p.sessionID}:session.started`,
            sourceTime(s.updated),
          );
          if (i >= 0) out[i] = started;
          else out.push(started);
        }
        const meta = this.syncMeta(s, p.info, already ? "updated" : "created");
        if (meta) out.push(meta);
        return out;
      }
      case "session.updated": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        const meta = this.syncMeta(s, p.info, "updated");
        if (meta) out.push(meta);
        return out;
      }
      case "session.deleted": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
        out.push(
          this.ev(
            s,
            "session.deleted",
            {},
            `opencode:${p.sessionID}:session.deleted`,
            sourceTime(p.info?.time?.updated),
          ),
        );
        return out;
      }
      case "message.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const info = evt.properties.info;
        const m = this.ensureMsg(s, info.id);
        m.role = info.role;
        if (info.time?.created) m.created = info.time.created;
        // The SDK types a message's clock as a union — only an assistant
        // message carries `completed` — so this reads it off one shape.
        const clock = info.time as { completed?: number } | undefined;
        if (clock?.completed !== undefined) m.completed = clock.completed;
        if (info.role === "user") {
          s.pendingUserMsgs.add(info.id);
          return out;
        }
        if (info.role === "assistant") {
          m.parentID = info.parentID;
          this.flushUser(s, out, info.parentID);
          for (const t of m.toolParts.values()) {
            const part = t.deferred;
            if (!part) continue;
            t.deferred = undefined;
            out.push(...this.toolEvents(s, m, part, t));
          }
          if (info.time.completed !== undefined && !m.emittedAssistant) {
            m.emittedAssistant = true;
            this.held.delete(info.id);
            const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
            const failure = assistantFailure(info.error);
            const u = info.tokens;
            // Providers occasionally report a negative count (usually output);
            // CASF keeps usage non-negative, and clamping here beats dropping
            // the whole turn on a schema rejection.
            const count = (n: number | undefined) =>
              n === undefined ? undefined : Math.max(0, Math.round(n));
            out.push(
              this.ev(
                s,
                "turn.assistant",
                {
                  turn_id: info.parentID,
                  msg_id: info.id,
                  content,
                  model: `${info.providerID}/${info.modelID}`,
                  usage: {
                    input: count(u.input) ?? 0,
                    output: count(u.output) ?? 0,
                    reasoning: count(u.reasoning),
                    cache_read: count(u.cache.read),
                    cache_write: count(u.cache.write),
                  },
                  cost_usd: info.cost,
                  latency_ms: Math.max(0, Math.round(info.time.completed - info.time.created)),
                  stop_reason: info.finish ?? (failure ? "error" : undefined),
                  ...(failure ? { error: failure } : {}),
                },
                `opencode:${info.id}:turn.assistant`,
                sourceTime(info.time.completed ?? info.time.created ?? s.updated),
              ),
            );
          }
        }
        return out;
      }
      case "message.part.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const part: Part = evt.properties.part;
        const m = this.ensureMsg(s, part.messageID);
        // An import read mid-reply carries an open part as OpenCode last stored
        // it, which can be older than the deltas already applied; and deltas
        // still in flight would land on top of anything newer. A closed part
        // carries its final text.
        const stale =
          evt.id.startsWith("import:") &&
          !m.emittedAssistant &&
          !!m.streamed?.has(part.id) &&
          (part.type === "text" || part.type === "reasoning") &&
          part.time?.end === undefined;
        if (stale) {
          // keep the delta-built text
        } else if (part.type === "text") {
          // Text OpenCode writes itself (a read file's contents, "continue"
          // nudges). An import replays parts before their message, so the role
          // is unknown here and the rule applies to every message.
          if (part.synthetic || part.ignored) m.parts.delete(part.id);
          else m.parts.set(part.id, { type: "text", text: part.text });
        } else if (part.type === "reasoning") {
          m.parts.set(part.id, { type: "thinking", text: part.text });
        } else if (part.type === "file") {
          m.parts.set(part.id, fileBlock(part));
        } else if (part.type === "tool") {
          // Parts are created in the order the model declared them, so first
          // sight is the declaration order. tool.call is not emitted until the
          // part leaves `pending`, which for parallel calls is the order they
          // actually started — record the ordinal so readers can restore the
          // order the model wrote.
          let t = m.toolParts.get(part.id);
          if (!t) {
            t = { emittedCall: false, emittedResult: false, order: m.toolParts.size };
            m.toolParts.set(part.id, t);
          }
          if (part.state.status === "completed") {
            const change = fileChangeOf(part.tool, part.state.input, part.state.metadata);
            if (change) (m.editedPaths ??= new Set()).add(pathKey(change.path));
          }
          // A call belongs to the user turn its message answers, and only
          // message.updated names that turn. A stored session replays parts
          // before their message, so the call waits for it.
          if (m.parentID === undefined) {
            t.deferred = part;
            return out;
          }
          out.push(...this.toolEvents(s, m, part, t));
          return out;
        }
        if (part.type === "compaction") {
          const seen = (m.compactionSeen ??= new Set());
          if (seen.has(part.id)) return out;
          seen.add(part.id);
          // Same hole as the patch part below: a compaction carries no clock,
          // so emitting without one stamped it with ingest time — sessions that
          // only re-connected looked freshly active in the list.
          out.push(
            this.ev(
              s,
              "session.compacted",
              { message_id: part.messageID, auto: part.auto },
              `opencode:${part.id}:compaction`,
              sourceTime(m.created ?? m.completed ?? s.updated),
            ),
          );
          return out;
        }
        if (part.type === "patch") {
          const seen = (m.patchSeen ??= new Set());
          // A patch part carries no clock of its own, and emitting without one
          // hands the store the ingest clock — so replaying a session on every
          // connect stamped all of its history with the moment we connected,
          // and the session list sorted by that instead of by when the agent
          // last worked. The message this part belongs to does carry one, and
          // the edits land as it finishes.
          const at = sourceTime(m.completed ?? m.created ?? s.updated);
          for (const f of part.files) {
            const key = `${part.id}:${f}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (m.editedPaths?.has(pathKey(f))) continue;
            out.push(
              this.ev(
                s,
                "file.changed",
                { path: f, change: "modify" },
                `opencode:${part.id}:file:${f}`,
                at,
              ),
            );
          }
          return out;
        }
        // shared tail for content parts (text/reasoning/file):
        // — user messages emit turn.user as soon as text lands so the prompt
        //   echoes instantly (id is a content hash: a later, fuller part
        //   snapshot re-emits and the projector overwrites it). The store
        //   keeps every version, so content with images waits for flushUser
        //   and goes out once, whole, under the message's stable id.
        // — assistant messages emit throttled partial turn.assistant
        //   snapshots so the UI streams during generation
        if (m.role === "user") {
          const content = [...m.parts.values()].filter((b) => b.type !== "thinking");
          if (content.some((b) => b.type === "image")) {
            s.pendingUserMsgs.add(part.messageID);
          } else if (content.length) {
            s.pendingUserMsgs.delete(part.messageID);
            out.push(
              this.ev(
                s,
                "turn.user",
                { turn_id: part.messageID, content },
                `opencode:${part.messageID}:turn.user:${Bun.hash(JSON.stringify(content)).toString(36)}`,
                sourceTime(m.created ?? s.updated),
              ),
            );
          }
        } else if (m.role === "assistant" && m.parentID && !m.emittedAssistant) {
          this.held.set(part.messageID, { s, m });
          const snap = this.streamSnapshot(part.messageID);
          if (snap) out.push(snap);
        }
        return out;
      }
      case "message.part.delta": {
        const p = evt.properties;
        if (p.field !== "text") return out;
        const s = this.sessions.get(p.sessionID);
        const m = s?.messages.get(p.messageID);
        const block = m?.parts.get(p.partID);
        // A delta extends a part already held. One for a part never seen (the
        // stream joined mid-message) waits for that part's next full update.
        if (!s || !m || !block || (block.type !== "text" && block.type !== "thinking")) return out;
        m.parts.set(p.partID, { ...block, text: block.text + p.delta });
        (m.streamed ??= new Set()).add(p.partID);
        if (m.role === "assistant" && m.parentID && !m.emittedAssistant) {
          this.held.set(p.messageID, { s, m });
          const snap = this.streamSnapshot(p.messageID);
          if (snap) out.push(snap);
        }
        return out;
      }
      case "session.idle":
      case "session.status": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const idle =
          evt.type === "session.idle" || evt.properties.status.type === "idle";
        if (idle) {
          for (const msgID of [...s.pendingUserMsgs]) this.flushUser(s, out, msgID);
          // a message that never finished is retired by the overlay at idle; a
          // late frame for it would bring it back
          for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
        }
        out.push(
          this.ev(
            s,
            "session.status",
            { state: idle ? "idle" : "busy" },
            `opencode:${sessionID}:status:${evt.id}`,
          ),
        );
        return out;
      }
      case "question.asked": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        out.push(
          this.ev(
            s,
            "question.asked",
            {
              request_id: p.id,
              questions: p.questions.map((q) => ({
                question: q.question,
                header: q.header,
                options: q.options.map((o) => ({ label: o.label, description: o.description })),
                multiple: q.multiple,
                custom: q.custom,
              })),
            },
            `opencode:${p.id}:question.asked`,
          ),
        );
        return out;
      }
      case "question.replied": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        out.push(
          this.ev(
            s,
            "question.resolved",
            { request_id: p.requestID, decision: "reply", answers: p.answers },
            `opencode:${p.requestID}:question.resolved`,
          ),
        );
        return out;
      }
      case "question.rejected": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        out.push(
          this.ev(
            s,
            "question.resolved",
            { request_id: p.requestID, decision: "reject" },
            `opencode:${p.requestID}:question.resolved`,
          ),
        );
        return out;
      }
      case "permission.asked": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        const shell = SHELL_PERMS.has(p.permission);
        const input: Record<string, unknown> = { ...p.metadata, patterns: p.patterns };
        if (shell) input.command = p.patterns.join("\n");
        out.push(
          this.ev(
            s,
            "permission.requested",
            {
              request_id: p.id,
              call_id: p.tool?.callID,
              tool: p.permission,
              input,
            },
            `opencode:${p.id}:permission.requested`,
          ),
        );
        return out;
      }
      case "permission.replied": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        out.push(
          this.ev(
            s,
            "permission.resolved",
            {
              request_id: p.requestID,
              decision: p.reply === "reject" ? "deny" : "allow",
              by: "user",
              scope: p.reply === "always" ? "always" : "once",
            },
            `opencode:${p.requestID}:permission.resolved`,
          ),
        );
        return out;
      }
      case "todo.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const entries = evt.properties.todos
          .filter((t) => ["pending", "in_progress", "completed"].includes(t.status))
          .map((t) => ({
            content: t.content,
            status: t.status as "pending" | "in_progress" | "completed",
          }));
        out.push(
          this.ev(
            s,
            "plan.updated",
            { entries },
            `opencode:${sessionID}:plan:${Bun.hash(JSON.stringify(entries)).toString(36)}`,
          ),
        );
        return out;
      }
      default:
        return out;
    }
  }
}

export function createIngestor(opts: {
  mapper: OpencodeMapper;
  sink: Sink;
  policy?: Policy | (() => Policy | undefined);
  onAsk?: OnAsk;
  onQuestion?: OnQuestion;
  /** OpenCode already answered this ask, so the waiting prompt can leave. */
  onSettled?: (requestId: string, decision: "allow" | "deny") => void;
  reply: (requestID: string, reply: "once" | "always" | "reject", message?: string) => Promise<unknown>;
  replyQuestion?: (requestID: string, answers: string[][]) => Promise<unknown>;
  rejectQuestion?: (requestID: string) => Promise<unknown>;
}): { handle: (evt: Event) => void; stop: () => void } {
  const { mapper, sink } = opts;

  const emit = (evts: EventInput[]) => {
    const live = evts.filter(isStreamingSnapshot);
    const durable = live.length ? evts.filter((e) => !isStreamingSnapshot(e)) : evts;
    if (durable.length) sink.append(durable);
    if (live.length) sink.publish?.(live);
  };

  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  // Deltas pause between steps and stop at the end of a part; the text that
  // arrived inside the last window would otherwise wait for the next event.
  const scheduleFlush = () => {
    if (flushTimer || !mapper.hasHeldStreams()) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      try {
        emit(mapper.flushStreaming());
      } catch (err) {
        console.error("opencode stream flush error:", err);
      }
      scheduleFlush();
    }, STREAM_SNAPSHOT_MS);
  };

  const emitResolved = (sessionID: string, data: Record<string, unknown>) => {
    const s = mapper.sessions.get(sessionID);
    if (!s) return;
    emit([
      mapper.ev(s, "permission.resolved", data, `opencode:${data.request_id}:permission.resolved`),
    ]);
  };

  const handlePermission = async (evt: Extract<Event, { type: "permission.asked" }>) => {
    const p = evt.properties;
    const shell = SHELL_PERMS.has(p.permission);
    const input: Record<string, unknown> = { ...p.metadata, patterns: p.patterns };
    if (shell) input.command = p.patterns.join("\n");
    const tool = shell ? "bash" : p.permission;
    const policy =
      typeof opts.policy === "function" ? opts.policy() : opts.policy;
    const d = policy
      ? evaluate(policy, { tool, input })
      : { decision: "ask" as const };
    if (d.decision === "allow") {
      await opts.reply(p.id, "once");
      emitResolved(p.sessionID, {
        request_id: p.id, decision: "allow", by: "policy",
        scope: "once", rule_id: d.rule_id, reason: d.reason,
      });
      return;
    }
    if (d.decision === "deny") {
      await opts.reply(p.id, "reject", d.reason);
      emitResolved(p.sessionID, {
        request_id: p.id, decision: "deny", by: "policy",
        scope: "once", rule_id: d.rule_id, reason: d.reason,
      });
      return;
    }
    if (!opts.onAsk) return;
    const s = mapper.sessions.get(p.sessionID);
    if (!s) return;
    const req = mapper.ev(
      s,
      "permission.requested",
      { request_id: p.id, call_id: p.tool?.callID, tool: p.permission, input },
      `opencode:${p.id}:permission.requested`,
    ) as Extract<EventInput, { type: "permission.requested" }>;
    const ans = await opts.onAsk(req);
    if (ans.external) return;
    if (ans.decision === "allow") {
      const scope = ans.scope === "always" ? "always" : "once";
      await opts.reply(p.id, scope);
      emitResolved(p.sessionID, {
        request_id: p.id, decision: "allow", by: "user", scope,
      });
      return;
    }
    await opts.reply(p.id, "reject");
    emitResolved(p.sessionID, {
      request_id: p.id, decision: "deny", by: "user", scope: "once",
    });
  };

  const emitQuestionResolved = (
    sessionID: string,
    requestID: string,
    decision: "reply" | "reject",
    answers?: string[][],
  ) => {
    const s = mapper.sessions.get(sessionID);
    if (!s) return;
    emit([
      mapper.ev(
        s,
        "question.resolved",
        { request_id: requestID, decision, answers },
        `opencode:${requestID}:question.resolved`,
      ),
    ]);
  };

  const handleQuestion = async (evt: Extract<Event, { type: "question.asked" }>) => {
    if (!opts.onQuestion || !opts.replyQuestion || !opts.rejectQuestion) return;
    const p = evt.properties;
    const s = mapper.sessions.get(p.sessionID);
    if (!s) return;
    const req = mapper.ev(
      s,
      "question.asked",
      {
        request_id: p.id,
        questions: p.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
          multiple: q.multiple,
          custom: q.custom,
        })),
      },
      `opencode:${p.id}:question.asked`,
    ) as Extract<EventInput, { type: "question.asked" }>;
    const ans = await opts.onQuestion(req);
    if (ans.decision === "reply") {
      await opts.replyQuestion(p.id, ans.answers ?? []);
      emitQuestionResolved(p.sessionID, p.id, "reply", ans.answers);
      return;
    }
    await opts.rejectQuestion(p.id);
    emitQuestionResolved(p.sessionID, p.id, "reject");
  };

  return {
    handle(evt: Event) {
      emit(mapper.handle(evt));
      // Unmarked, a session watched from its creation reads as stale to every
      // later sync, which then rebuilds it in the middle of a reply.
      if (evt.type === "session.created" && !evt.id.startsWith("import:")) {
        sink.markMapped?.(`opencode:${evt.properties.sessionID}`, OPENCODE_MAPPER_VERSION);
      }
      scheduleFlush();
      if (evt.type === "permission.asked") {
        void handlePermission(evt).catch((err) =>
          console.error("opencode permission handling error:", err),
        );
      }
      if (evt.type === "permission.replied") {
        const reply = evt.properties.reply;
        opts.onSettled?.(evt.properties.requestID, reply === "reject" ? "deny" : "allow");
      }
      if (evt.type === "question.asked") {
        void handleQuestion(evt).catch((err) =>
          console.error("opencode question handling error:", err),
        );
      }
    },
    stop() {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    },
  };
}

export async function connectOpencode(opts: {
  baseUrl: string;
  directory?: string;
  // HTTP basic auth for `opencode serve --username/--password`
  username?: string;
  password?: string;
  sink: Sink;
  policy?: Policy | (() => Policy | undefined);
  onAsk?: OnAsk;
  onQuestion?: OnQuestion;
  onSettled?: (requestId: string, decision: "allow" | "deny") => void;
  onEvent?: (evt: Event) => void;
  connectTimeoutMs?: number;
  /** How long prompt_async may take to accept. It returns once the run has started. */
  promptAcceptMs?: number;
  fetch?: typeof fetch;
}): Promise<{
  stop: () => void;
  importSession: (
    sessionID: string,
    directory?: string,
    options?: { force?: boolean },
  ) => Promise<boolean>;
  createSession: (opts?: { title?: string; directory?: string }) => Promise<{ id: string }>;
  prompt: (
    sessionID: string,
    parts: OpencodePromptPart[],
    opts?: {
      model?: { providerID: string; modelID: string };
      agent?: string;
      variant?: string;
      directory?: string;
    },
  ) => Promise<void>;
  command: (
    sessionID: string,
    c: {
      command: string;
      arguments: string;
      agent?: string;
      model?: { providerID: string; modelID: string };
      variant?: string;
      directory?: string;
      parts?: FilePartInput[];
    },
  ) => Promise<void>;
  listModels: () => Promise<
    { providerID: string; modelID: string; name: string; variants: string[]; context?: number }[]
  >;
  listAgents: () => Promise<{ name: string; mode?: string }[]>;
  listSessions: () => Promise<{ id: string; title: string; directory: string }[]>;
  listWorkspaces: () => Promise<{ id: string; name?: string; directory: string }[]>;
  abort: (sessionID: string, directory?: string) => Promise<void>;
  mcpConnect: (name: string, directory?: string) => Promise<void>;
  mcpDisconnect: (name: string, directory?: string) => Promise<void>;
  mcpAdd: (
    name: string,
    config: { type: "local"; command: string[] } | { type: "remote"; url: string },
    directory?: string,
  ) => Promise<void>;
  mcpAuthStart: (
    name: string,
    directory: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ authorizationUrl?: string; oauthState?: string }>;
  mcpAuthFinish: (name: string, code: string, directory: string | undefined, signal: AbortSignal) => Promise<void>;
  revert: (sessionID: string, messageID: string, directory?: string) => Promise<void>;
  unrevert: (sessionID: string, directory?: string) => Promise<void>;
  fork: (sessionID: string, messageID: string, directory?: string) => Promise<{ id: string }>;
  summarize: (
    sessionID: string,
    directory?: string,
    model?: { providerID: string; modelID: string },
  ) => Promise<void>;
  indexSessions: () => Promise<string[]>;
  refreshSessions: (guard?: OpencodeSyncGuard) => Promise<number>;
  rebuildSession: (sessionID: string, directory?: string) => Promise<number>;
  updateSession: (
    sessionID: string,
    patch: { title?: string; archived?: boolean },
    directory?: string,
  ) => Promise<void>;
  deleteSession: (sessionID: string, directory?: string) => Promise<void>;
}> {
  const abort = new AbortController();
  // The SDK builds the SSE request with its own internal signal and ignores a
  // caller-provided one. Wrap fetch so stop() truly ends the stream: an
  // in-flight request is aborted via our signal, an already-open response body
  // has its reader cancelled, and any later retried fetch hangs so the
  // abandoned generator goes inert instead of reconnecting forever.
  const rawFetch = opts.fetch ?? globalThis.fetch;
  let openReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abortingFetch = async (request: Request): Promise<Response> => {
    if (abort.signal.aborted) return new Promise<Response>(() => {});
    // Bun cuts a request quiet for 5 minutes, and a command answers only when its run is done
    const signal = request.signal ? AbortSignal.any([abort.signal, request.signal]) : abort.signal;
    const res = await rawFetch(new Request(request, { signal }), { timeout: false } as RequestInit);
    if (!res.body) return res;
    const real = res.body.getReader();
    openReader = real;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { done, value } = await real.read();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      },
      cancel() {
        void real.cancel();
      },
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  abort.signal.addEventListener("abort", () => {
    try {
      void openReader?.cancel().catch(() => {});
    } catch {
      // reader may already be released
    }
  });
  const client: OpencodeClient = createOpencodeClient({
    baseUrl: opts.baseUrl,
    directory: opts.directory,
    headers:
      opts.username !== undefined || opts.password !== undefined
        ? {
            Authorization: `Basic ${btoa(`${opts.username ?? ""}:${opts.password ?? ""}`)}`,
          }
        : undefined,
    fetch: abortingFetch as typeof fetch,
  });
  const mapper = new OpencodeMapper({ directory: opts.directory });
  const ingestor = createIngestor({
    mapper,
    sink: opts.sink,
    policy: opts.policy,
    onAsk: opts.onAsk,
    onQuestion: opts.onQuestion,
    onSettled: opts.onSettled,
    reply: async (requestID, r, message) => {
      await client.permission.reply({ requestID, reply: r, message });
    },
    replyQuestion: async (requestID, answers) => {
      await client.question.reply({ requestID, answers, directory: opts.directory });
    },
    rejectQuestion: async (requestID) => {
      await client.question.reject({ requestID, directory: opts.directory });
    },
  });

  const connectTimeout = opts.connectTimeoutMs ?? 10_000;
  const promptAcceptMs = opts.promptAcceptMs ?? 20_000;
  // `/event` is one project directory. `/global/event` carries every project,
  // which is what a desktop session list has to follow. A 404 only rejects
  // once the body is read, so probe the global bus and fall back to `/event`.
  let preferGlobal = true;
  const openStream = async () => {
    if (preferGlobal) {
      try {
        return await client.global.event();
      } catch {
        preferGlobal = false;
      }
    }
    return client.event.subscribe();
  };
  const firstEvent = async (
    open: () => Promise<{ stream: AsyncGenerator<unknown> }>,
    timeoutMs: number,
  ) => {
    let opened: { stream: AsyncGenerator<unknown> };
    try {
      opened = await open();
    } catch {
      return undefined;
    }
    const stream = opened.stream;
    const iter = stream[Symbol.asyncIterator]();
    const pending = iter.next();
    pending.catch(() => {});
    const first = await Promise.race([
      pending.then(
        (value) => value,
        () => "error" as const,
      ),
      Bun.sleep(timeoutMs).then(() => "timeout" as const),
    ]);
    if (first === "timeout" || first === "error" || first.done) {
      // return() waits on the in-flight read, which is the thing that timed
      // out, so it must not be awaited. stop()/abort cancels the body.
      void stream.return(undefined).catch(() => {});
      return undefined;
    }
    return { iter, value: first.value };
  };
  // Global and the per-directory bus share one budget. A quiet socket must not
  // pay the timeout twice before connect gives up.
  const connectStarted = Date.now();
  let got = await firstEvent(
    () => client.global.event() as Promise<{ stream: AsyncGenerator<unknown> }>,
    Math.min(connectTimeout, 3_000),
  );
  if (!got) {
    preferGlobal = false;
    const left = connectTimeout - (Date.now() - connectStarted);
    if (left >= 200) {
      got = await firstEvent(
        () => client.event.subscribe() as Promise<{ stream: AsyncGenerator<unknown> }>,
        left,
      );
    }
  }
  if (!got) {
    abort.abort();
    throw new Error(`opencode event stream produced no events within ${connectTimeout}ms`);
  }
  const importedRevision = new Map<string, number>();
  const importTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const sessionInfo = async (sessionID: string, directory?: string): Promise<Session> => {
    const sess = await client.session.get({ sessionID, directory: directory ?? opts.directory });
    if (!sess.data) throw new Error(`session ${sessionID} not found`);
    return sess.data;
  };
  const readSession = async (sessionID: string, directory?: string): Promise<Event[]> => {
    const info = await sessionInfo(sessionID, directory);
    const msgs = await client.session.messages({ sessionID, directory: directory ?? opts.directory });
    return snapshotEvents(sessionID, info, msgs.data ?? []);
  };
  const importSession = async (
    sessionID: string,
    directory?: string,
    options: { force?: boolean } = {},
  ): Promise<boolean> => {
    const info = await sessionInfo(sessionID, directory);
    // The session doc carries its own revision. An unchanged one means the
    // messages fetch — the expensive part, the whole transcript — would replay
    // exactly what the store already holds, so a click on a session the
    // listener already imported costs one small GET instead.
    const updated = info.time?.updated ?? info.time?.created ?? 0;
    if (!options.force && importedRevision.get(sessionID) === updated) return false;
    const msgs = await client.session.messages({ sessionID, directory: directory ?? opts.directory });
    for (const evt of snapshotEvents(sessionID, info, msgs.data ?? [])) ingestor.handle(evt);
    importedRevision.set(sessionID, updated);
    return true;
  };
  const rebuildSession = async (sessionID: string, directory?: string): Promise<number> => {
    if (!opts.sink.replaceSession) throw new Error("this sink cannot rebuild sessions");
    const events = rebuildEvents(await readSession(sessionID, directory), opts.directory);
    await opts.sink.replaceSession(`opencode:${sessionID}`, events, {
      replaceTypes: OPENCODE_REBUILT_TYPES,
      mapper: OPENCODE_MAPPER_VERSION,
    });
    return events.length;
  };
  const dispatch = (raw: unknown) => {
    const evt = normalizeOpencodeEvent(raw);
    if (!evt) return;
    ingestor.handle(evt);
    const type = evt.type;
    const sessionID = eventSessionID(evt);
    const directory = eventDirectory(raw);
    if (
      sessionID &&
      (type.startsWith("session.next.") || type === "session.idle" || type === "session.status")
    ) {
      const prev = importTimers.get(sessionID);
      if (prev) clearTimeout(prev);
      importTimers.set(
        sessionID,
        setTimeout(() => {
          importTimers.delete(sessionID);
          void importSession(sessionID, directory, { force: true }).catch((err) =>
            console.error("import session failed:", err),
          );
        }, 400),
      );
    }
    if (!opts.onEvent) return;
    try {
      opts.onEvent(evt);
    } catch (err) {
      console.error("opencode onEvent error:", err);
    }
  };
  dispatch(got.value);

  const pump = async (iter: AsyncIterator<unknown>) => {
    for (;;) {
      const r = await iter.next();
      if (r.done || abort.signal.aborted) return;
      dispatch(r.value);
    }
  };
  // Filled in once refreshSessions exists. A drop in the first tick has nothing to catch up yet.
  let catchUp: () => void = () => {};
  const quiet: AsyncIterator<unknown> = (async function* () {})();
  const loop = (async () => {
    let current: AsyncIterator<unknown> = got.iter;
    let pause = 1_000;
    while (!abort.signal.aborted) {
      try {
        await pump(current);
      } catch (err) {
        if (!abort.signal.aborted) console.error("opencode event stream error:", err);
      }
      if (abort.signal.aborted) return;
      await Bun.sleep(pause);
      if (abort.signal.aborted) return;
      const again = await firstEvent(
        () => openStream() as Promise<{ stream: AsyncGenerator<unknown> }>,
        3_000,
      );
      if (!again) {
        current = quiet;
        pause = Math.min(pause * 2, 15_000);
        if (!abort.signal.aborted) console.error("opencode event stream reconnect failed");
        continue;
      }
      pause = 1_000;
      current = again.iter;
      dispatch(again.value);
      catchUp();
    }
  })();

  const walkChildren = async (
    sessionID: string,
    directory: string | undefined,
    visit: (info: Session) => Promise<void>,
  ) => {
    const pending = [sessionID];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      let kids;
      try {
        kids = await client.session.children({ sessionID: id, directory });
      } catch (err) {
        console.error(`opencode children failed for ${id}:`, err);
        continue;
      }
      for (const info of kids.data ?? []) {
        if (!info?.id) continue;
        await visit(info);
        pending.push(info.id);
      }
    }
  };

  const mcpAuthFetch = (path: string, directory: string | undefined, signal: AbortSignal, body?: unknown) => {
    const q = new URLSearchParams();
    const dir = directory ?? opts.directory;
    if (dir) q.set("directory", dir);
    const timeout = AbortSignal.timeout(300_000);
    return rawFetch(
      new Request(`${opts.baseUrl.replace(/\/+$/, "")}${path}?${q}`, {
        method: "POST",
        headers: {
          ...(opts.username !== undefined || opts.password !== undefined
            ? { authorization: `Basic ${btoa(`${opts.username ?? ""}:${opts.password ?? ""}`)}` }
            : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([signal, timeout, abort.signal]),
      }),
      { timeout: false } as RequestInit,
    );
  };

  const api = {
    stop() {
      abort.abort();
      ingestor.stop();
      for (const timer of importTimers.values()) clearTimeout(timer);
      importTimers.clear();
      void loop;
    },
    async createSession(sessOpts?: { title?: string; directory?: string }) {
      const r = await client.session.create({
        title: sessOpts?.title,
        directory: sessOpts?.directory ?? opts.directory,
      });
      if (!r.data) throw new Error("session.create returned no data");
      return { id: r.data.id };
    },
    async prompt(
      sessionID: string,
      parts: OpencodePromptPart[],
      promptOpts?: {
        model?: { providerID: string; modelID: string };
        agent?: string;
        variant?: string;
        directory?: string;
      },
    ) {
      const said = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      let sent: Awaited<ReturnType<typeof client.session.promptAsync>>;
      try {
        sent = await client.session.promptAsync(
          {
            sessionID,
            directory: promptOpts?.directory ?? opts.directory,
            model: promptOpts?.model,
            agent: promptOpts?.agent,
            // server schema accepts `variant` (reasoning effort); SDK types lag
            ...(promptOpts?.variant ? ({ variant: promptOpts.variant } as object) : {}),
            parts,
          },
          { signal: AbortSignal.timeout(promptAcceptMs) },
        );
      } catch (err) {
        throw new Error(promptFailure(err, said));
      }
      if ("error" in sent && sent.error) throw new Error(promptFailure(sent.error, said));
    },
    async command(
      sessionID: string,
      c: {
        command: string;
        arguments: string;
        agent?: string;
        model?: { providerID: string; modelID: string };
        variant?: string;
        directory?: string;
        parts?: FilePartInput[];
      },
    ) {
      const directory = c.directory ?? opts.directory;
      const listed = await client.command.list({ directory });
      if (listed.error) throw new Error(errorMessage(listed.error));
      if (!(listed.data ?? []).some((x) => x.name === c.command)) throw new UnknownCommandError(c.command);
      const run = client.session.command({
        sessionID,
        directory,
        command: c.command,
        arguments: c.arguments,
        agent: c.agent,
        model: c.model ? `${c.model.providerID}/${c.model.modelID}` : undefined,
        variant: c.variant,
        parts: c.parts,
      });
      // OpenCode answers when the whole run is done, and the run goes on if
      // nobody waits; a command that fails to start fails at once.
      const early = await Promise.race([
        run.then(
          (r) => ({ r }),
          (thrown: unknown) => ({ thrown }),
        ),
        Bun.sleep(COMMAND_START_MS).then(() => undefined),
      ]);
      if (early === undefined) {
        const report = (err: unknown) => {
          if (!abort.signal.aborted) console.error(`opencode command /${c.command} failed:`, err);
        };
        void run.then((r) => r.error && report(r.error), report);
        return;
      }
      if ("thrown" in early) throw early.thrown;
      if (early.r.error) throw new Error(errorMessage(early.r.error));
    },
    async listModels() {
      const r = await client.provider.list();
      // `connected` is broader than a stored key: a sibling that only shares
      // the env var is listed too, and it cannot take that key. Each
      // provider's default model sorts first.
      const out: { providerID: string; modelID: string; name: string; variants: string[]; context?: number }[] =
        [];
      for (const p of pickableProviders(r.data?.all ?? [], r.data?.connected)) {
        const def = r.data?.default?.[p.id];
        const models = Object.entries(p.models ?? {});
        models.sort(([a], [b]) => (a === def ? -1 : b === def ? 1 : 0));
        for (const [modelID, m] of models) {
          const raw = m as { name?: string; variants?: object; limit?: { context?: number } };
          const context = raw.limit?.context;
          out.push({
            providerID: p.id,
            modelID,
            name: raw.name ?? modelID,
            variants: Object.keys(raw.variants ?? {}),
            ...(typeof context === "number" && context > 0 ? { context } : {}),
          });
        }
      }
      return out;
    },
    async listAgents() {
      const r = await client.app.agents();
      // same cut as the official desktop picker: subagents and hidden builtins stay out
      return (r.data ?? [])
        .filter((a) => a.mode !== "subagent" && a.hidden !== true)
        .map((a) => ({ name: a.name, mode: a.mode }));
    },
    async listSessions() {
      const r = await client.session.list({ directory: opts.directory, roots: true, limit: 80 });
      return (r.data ?? []).map((s) => ({ id: s.id, title: s.title, directory: s.directory }));
    },
    async listWorkspaces() {
      const r = await client.project.list();
      const out: { id: string; name?: string; directory: string }[] = [];
      for (const project of r.data ?? []) {
        out.push({ id: project.id, name: project.name, directory: project.worktree });
        for (const sandbox of project.sandboxes ?? []) {
          out.push({ id: project.id, name: project.name, directory: sandbox });
        }
      }
      return out;
    },
    async abort(sessionID: string, directory?: string) {
      await client.session.abort({ sessionID, directory: directory ?? opts.directory });
    },
    async mcpConnect(name: string, directory?: string) {
      await client.mcp.connect({ name, directory: directory ?? opts.directory });
    },
    async mcpDisconnect(name: string, directory?: string) {
      await client.mcp.disconnect({ name, directory: directory ?? opts.directory });
    },
    async mcpAdd(
      name: string,
      config: { type: "local"; command: string[] } | { type: "remote"; url: string },
      directory?: string,
    ) {
      const added = await client.mcp.add({ name, config, directory: directory ?? opts.directory });
      if (added.error) throw new Error(errorMessage(added.error));
    },
    async mcpAuthStart(name: string, directory: string | undefined, signal: AbortSignal) {
      const res = await mcpAuthFetch(`/mcp/${encodeURIComponent(name)}/auth`, directory, signal);
      const text = await res.text();
      if (!res.ok) throw new Error(mcpAuthFailure(text));
      try {
        return JSON.parse(text) as { authorizationUrl?: string; oauthState?: string };
      } catch {
        throw new Error("mcp auth failed");
      }
    },
    async mcpAuthFinish(name: string, code: string, directory: string | undefined, signal: AbortSignal) {
      const res = await mcpAuthFetch(`/mcp/${encodeURIComponent(name)}/auth/callback`, directory, signal, { code });
      const text = await res.text();
      if (!res.ok) throw new Error(mcpAuthFailure(text, code));
      let status: { status?: unknown; error?: unknown } | undefined;
      try {
        status = JSON.parse(text) as { status?: unknown; error?: unknown };
      } catch {
        status = undefined;
      }
      if (status?.status === "failed") {
        throw new Error(mcpAuthFailure(typeof status.error === "string" ? status.error : "", code));
      }
    },
    async revert(sessionID: string, messageID: string, directory?: string) {
      await client.session.revert({ sessionID, messageID, directory: directory ?? opts.directory });
    },
    async unrevert(sessionID: string, directory?: string) {
      await client.session.unrevert({ sessionID, directory: directory ?? opts.directory });
    },
    async fork(sessionID: string, messageID: string, directory?: string) {
      const r = await client.session.fork({ sessionID, messageID, directory: directory ?? opts.directory });
      if (!r.data) throw new Error("session.fork returned no data");
      return { id: r.data.id };
    },
    async summarize(
      sessionID: string,
      directory?: string,
      model?: { providerID: string; modelID: string },
    ) {
      await client.session.summarize({
        sessionID,
        directory: directory ?? opts.directory,
        ...(model ? { providerID: model.providerID, modelID: model.modelID } : {}),
      });
    },
    async updateSession(sessionID: string, patch: { title?: string; archived?: boolean }, directory?: string) {
      const r = await client.session.update({
        sessionID,
        directory: directory ?? opts.directory,
        title: patch.title,
        time: patch.archived ? { archived: Date.now() } : undefined,
      });
      if (r.data) {
        ingestor.handle({
          id: `write:${sessionID}:updated`,
          type: "session.updated",
          properties: { sessionID, info: r.data },
        } as Event);
      }
    },
    async deleteSession(sessionID: string, directory?: string) {
      await client.session.delete({ sessionID, directory: directory ?? opts.directory });
      ingestor.handle({
        id: `write:${sessionID}:deleted`,
        type: "session.deleted",
        properties: {
          sessionID,
          info: {
            id: sessionID,
            directory: directory ?? opts.directory ?? "",
            title: "",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      } as Event);
    },
    async indexSessions() {
      const sessions = await client.session.list({ directory: opts.directory, roots: true, limit: 80 });
      const ids: string[] = [];
      const visit = async (info: Session) => {
        ingestor.handle({
          id: `index:${info.id}`,
          type: "session.updated",
          properties: { sessionID: info.id, info },
        } as Event);
        ids.push(info.id);
      };
      for (const info of sessions.data ?? []) {
        await visit(info);
        await walkChildren(info.id, info.directory || opts.directory, visit);
      }
      return ids;
    },
    /**
     * Re-read every project the server knows and pull transcripts that moved
     * since the last sync. Safe to call repeatedly: an unchanged session is
     * not imported again.
     */
    async refreshSessions(guard?: OpencodeSyncGuard) {
      const directories = new Set<string | undefined>([opts.directory]);
      try {
        const projects = await client.project.list();
        for (const project of projects.data ?? []) {
          if (project.worktree) directories.add(project.worktree);
          for (const sandbox of project.sandboxes ?? []) directories.add(sandbox);
        }
      } catch (err) {
        console.error("opencode project list failed:", err);
      }
      const seen = new Set<string>();
      let imported = 0;
      for (const directory of directories) {
        let sessions;
        try {
          sessions = await client.session.list({ directory, roots: true, limit: 80 });
        } catch (err) {
          console.error(`opencode session list failed for ${directory ?? "(default)"}:`, err);
          continue;
        }
        const visit = async (info: Session) => {
          if (!info?.id || seen.has(info.id)) return;
          seen.add(info.id);
          // The same session can be driven over another channel at once. Whoever
          // holds it writes it; touching it here would make a second copy of a
          // conversation the user is already watching.
          if (guard?.taken?.(`opencode:${info.id}`)) return;
          // Sync walks every project the server knows while indexSessions walks
          // one, so most sessions arrive by this road. Claiming here is what
          // keeps a second OpenCode from making all of them unroutable.
          guard?.claimed?.(`opencode:${info.id}`);
          try {
            ingestor.handle({
              id: `sync:${info.id}:${info.time?.updated ?? 0}`,
              type: "session.updated",
              properties: { sessionID: info.id, info },
            } as Event);
            const updated = info.time?.updated ?? info.time?.created ?? 0;
            if (importedRevision.get(info.id) === updated) return;
            const dir = info.directory || directory;
            if (guard?.stale?.(`opencode:${info.id}`)) await rebuildSession(info.id, dir);
            else await importSession(info.id, dir);
            importedRevision.set(info.id, updated);
            imported += 1;
          } catch (err) {
            console.error(`sync session ${info.id} failed:`, err);
          }
        };
        for (const info of sessions.data ?? []) {
          if (!info?.id || seen.has(info.id)) continue;
          await visit(info);
          await walkChildren(info.id, info.directory || directory, visit);
        }
      }
      return imported;
    },
    importSession,
    rebuildSession,
  };
  catchUp = () => {
    void api.refreshSessions().catch((err) => console.error("opencode catch-up failed:", err));
  };
  return api;
}
