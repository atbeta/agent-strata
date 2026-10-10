import { sessionIdentity } from "@agent-strata/schema";

interface Held {
  /** the session id the holder writes under */
  casfId: string;
  /** the connection that is driving it */
  connection: string;
}

/**
 * The sessions a live connection is driving. One agent's session can reach the
 * layer over more than one channel — `opencode acp` over stdio and
 * `opencode serve` over HTTP name the same session — and the channel that holds
 * it owns that identity. While it is held, no other channel may write a second
 * copy of the same session under its own id.
 *
 * The registry is runtime state, not stored: a claim lasts exactly as long as
 * the connection that took it, and the session goes back to the layer when that
 * connection goes away.
 */
export class SessionClaims {
  private held = new Map<string, Held>();

  claim(identity: string, casfId: string, connection: string): void {
    this.held.set(identity, { casfId, connection });
  }

  /** Whether some other connection already drives this identity under another id. */
  shadowed(source: { backend: string; agent?: string; native_id?: string }, casfId: string): boolean {
    const identity = sessionIdentity(source);
    if (!identity) return false;
    const owner = this.held.get(identity);
    return owner !== undefined && owner.casfId !== casfId;
  }

  /** A connection that goes away hands every session it was driving back. */
  release(connection: string): void {
    for (const [identity, h] of this.held) {
      if (h.connection === connection) this.held.delete(identity);
    }
  }
}