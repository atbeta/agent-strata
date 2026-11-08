// Reading a plugin tool call off the wire.
//
// Kept apart from the route so the two things worth testing — what counts as a
// well-formed call, and what a session id means — can be tested without an
// HTTP server, and so the route reads as the sequence it is.

import type { ToolCallRequest } from "@agent-strata/plugin-sdk";

export type ParsedCall =
  | {
      ok: true;
      sessionId: string;
      input: Record<string, unknown>;
      callId?: string;
    }
  | { ok: false; status: number; error: string };

/**
 * `{ session_id, input, call_id? }`.
 *
 * `call_id` is optional and stays optional: the OpenCode shim cannot name the
 * backend's call id from a stable release, and refusing the call over a
 * missing join key would turn a display nicety into a broken tool.
 */
export async function readToolCall(
  req: Request,
  resolveSession: (given: string) => string,
): Promise<ParsedCall> {
  const body = (await req.json().catch(() => null)) as {
    session_id?: unknown;
    input?: unknown;
    call_id?: unknown;
  } | null;
  if (typeof body?.session_id !== "string" || body.session_id.length === 0) {
    return { ok: false, status: 400, error: "session_id required" };
  }
  if (body.input !== undefined && (typeof body.input !== "object" || body.input === null || Array.isArray(body.input))) {
    return { ok: false, status: 400, error: "input must be an object" };
  }
  const input = (body.input ?? {}) as Record<string, unknown>;
  const callId = typeof body.call_id === "string" && body.call_id.length > 0 ? body.call_id : undefined;
  return { ok: true, sessionId: resolveSession(body.session_id), input, callId };
}

/** The request a plugin receives, from a parsed call plus the host's dispatch fields. */
export function toolRequest(
  tool: string,
  parsed: Extract<ParsedCall, { ok: true }>,
  signal: AbortSignal,
): ToolCallRequest {
  return {
    tool,
    callId: parsed.callId,
    sessionId: parsed.sessionId,
    input: parsed.input,
    signal,
  };
}
