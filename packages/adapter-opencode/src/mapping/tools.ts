import type { Part } from "@opencode-ai/sdk/v2";
import type { ContentBlock, EventInput } from "@agent-strata/schema";
import { createPatch } from "diff";
import { sourceTime, type MsgState, type SessionEventFactory, type ToolPart, type ToolTrack } from "./model";
import type { SessionState } from "./session";

/**
 * The change a finished edit or write made. An edit carries OpenCode's own
 * unified diff in its metadata; a write carries the whole new file.
 */
export function fileChangeOf(
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
export function taskChild(tool: string, metadata: Record<string, unknown> | undefined): string | undefined {
  if (tool !== "task" || !metadata) return undefined;
  const id = metadata.sessionId;
  if (typeof id !== "string" || !id) return undefined;
  return id.startsWith("opencode:") ? id : `opencode:${id}`;
}

// The desktop renders images only from data: and blob: URLs (img-src CSP),
// so a remote image stays a file reference.
export function fileBlock(part: Extract<Part, { type: "file" }>): ContentBlock {
  const inline = part.url.startsWith("data:");
  if (inline && part.mime.startsWith("image/")) {
    const comma = part.url.indexOf(",");
    if (comma > 0 && part.url.slice(0, comma).endsWith(";base64"))
      return { type: "image", mime: part.mime, data: part.url.slice(comma + 1) };
  }
  // A workspace mention keeps only its path. Its extension already says what it
  // is, and a `text/plain` badge on every `@file` would be noise on the most
  // common kind of reference there is.
  if (part.source && "path" in part.source) return { type: "file_ref", path: part.source.path };
  // An attachment has no workspace path, so `mime` is the only thing that says
  // what it was: without it the transcript shows a bare filename, and a dropped
  // PDF reads exactly like a mentioned text file.
  return { type: "file_ref", path: part.filename ?? (inline ? part.mime : part.url), mime: part.mime };
}

const ATTACH_INLINE_MAX = 1_000_000;

/**
 * A completed tool's attachments, as content blocks.
 *
 * Inline `data:` payloads are capped: a screenshot the size of a small repo
 * belongs to the tool's own record, not to a durable event every reader of it
 * pays to load. Past the cap the bytes used to be dropped outright, leaving a
 * filename and no way to see the picture — which is useless for the one thing a
 * screenshot is for. They go to `spill` now and the block keeps a reference, so
 * the reader can ask for the picture when they want it and nobody else pays.
 */
export function attachmentBlocks(
  attachments: Array<Extract<Part, { type: "file" }>> | undefined,
  spill?: (mime: string, base64: string) => string | undefined,
): { attachments: ContentBlock[] } | {} {
  if (!attachments?.length) return {};
  const blocks = attachments.map((a) => {
    if (a.url.startsWith("data:") && a.url.length > ATTACH_INLINE_MAX) {
      const source = a.source && "path" in a.source ? a.source.path : undefined;
      const path = source ?? a.filename ?? a.mime;
      const comma = a.url.indexOf(",");
      const base64 = comma > 0 ? a.url.slice(comma + 1) : "";
      // A sink that cannot store it falls back to the old behaviour: a
      // reference with no bytes behind it. Better a filename than a crash.
      const attachment = base64 && spill ? spill(a.mime, base64) : undefined;
      return {
        type: "file_ref" as const,
        path,
        mime: a.mime,
        ...(attachment ? { attachment } : {}),
      };
    }
    return fileBlock(a);
  });
  return blocks.length ? { attachments: blocks } : {};
}

export function toolEvents(
  s: SessionState,
  m: MsgState,
  part: ToolPart,
  t: ToolTrack,
  ev: SessionEventFactory<SessionState>,
  spill?: (mime: string, base64: string) => string | undefined,
): EventInput[] {
  const out: EventInput[] = [];
  const st = part.state;
  t.status = st.status;
  const child = taskChild(part.tool, st.status === "pending" ? undefined : st.metadata);
  const callData = (childId?: string) => ({
    turn_id: m.parentID ?? part.messageID,
    call_id: part.callID,
    tool: part.tool,
    input: st.input,
    order: t.order,
    // `order` counts only within this message. Naming the message
    // too is what lets a reader see a call beside the words that
    // asked for it instead of in a pile at the end of the turn.
    msg_id: part.messageID,
    ...(childId ? { child_session_id: childId } : {}),
  });
  /**
   * A task part is running before the session it opens exists, so its id
   * arrives in a later update than the call itself. Reading it only at the
   * first non-pending sighting dropped it: the card named no child for as
   * long as the child was working, and the id came back with the result
   * instead — the one moment there is nothing left to go and watch.
   *
   * The call is restated to carry it. A second `tool.call` for one call_id
   * is an update rather than a second card: whichever event the projector
   * meets first writes the call, and the other fills in the child.
   */
  if (st.status !== "pending" && child && child !== t.child) {
    t.child = child;
    if (t.emittedCall) {
      out.push(
        ev(
          s,
          "tool.call",
          callData(child),
          `opencode:${part.id}:tool.child`,
          sourceTime(st.time.start || s.updated),
        ),
      );
    }
  }
  if (!t.emittedCall && st.status !== "pending") {
    t.emittedCall = true;
    out.push(
      ev(
        s,
        "tool.call",
        callData(child),
        `opencode:${part.id}:tool.call`,
        sourceTime(st.time.start || s.updated),
      ),
    );
  }
  if (!t.emittedResult && (st.status === "completed" || st.status === "error")) {
    t.emittedResult = true;
    out.push(
      ev(
        s,
        "tool.result",
        {
          call_id: part.callID,
          status: st.status === "completed" ? "ok" : "error",
          output: st.status === "completed" ? st.output : st.error,
          ...(st.status === "completed" ? attachmentBlocks(st.attachments, spill) : {}),
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
          ev(
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
