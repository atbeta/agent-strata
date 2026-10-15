import type { Turn } from "./api";

/**
 * A prompt the reader has sent, shown before the backend has echoed it back.
 *
 * Pressing Enter cleared the composer and then nothing happened for a round
 * trip: POST, the agent's own SDK, its event stream, back over SSE, and a
 * second request to read the tail. The reader had typed a sentence, hit Enter,
 * and watched an empty column — which reads as a hang, not as a message on its
 * way. The turn exists locally from that instant; the real one replaces it.
 *
 * The echo is not a guess at what the backend will store. It carries only the
 * text the composer actually held, and it disappears the moment the store's
 * turn count passes the baseline recorded when it went out, so there is never
 * a window with the message twice.
 */

/** A turn id no backend can mint, so the echo can never collide with a real one. */
export const ECHO_TURN_ID = "__pending__";

export interface PendingEcho {
  /** How many real turns existed when this went out. */
  base: number;
  /** The draft as it was sent. Attachments are not echoed — see below. */
  text: string;
}

export function echoTurn(text: string): Turn {
  return {
    turn_id: ECHO_TURN_ID,
    // A send can carry only a file and no prose; the backend still makes a
    // turn, so the echo has to exist to be replaced by it.
    user: text ? [{ type: "text", text }] : undefined,
    assistant: [],
    tool_calls: [],
  };
}

/**
 * The real turns, plus the one in flight — until the real turns outnumber the
 * baseline, which is the point at which the backend's own turn is in hand and
 * the echo would be a second copy of one sentence.
 */
export function withEcho(turns: readonly Turn[], echo: PendingEcho | undefined): Turn[] {
  if (!echo) return [...turns];
  if (turns.length > echo.base) return [...turns];
  return [...turns, echoTurn(echo.text)];
}
