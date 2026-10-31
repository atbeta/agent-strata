export interface RequestToken {
  readonly sessionId: string;
  readonly generation: number;
  readonly sequence: number;
}

export interface RequestOwner {
  begin(sessionId: string): RequestToken;
  invalidate(): void;
  isCurrent(token: RequestToken): boolean;
}

/**
 * Which in-flight requests may still touch the composer.
 *
 * Currency is per session. Starting a request for B does not cancel the one
 * already in flight for A — that request was made for A and still belongs to
 * A. A newer request for the same session supersedes the older one, and
 * `invalidate` (the composer going away) drops every session at once.
 */
export function createRequestOwner(): RequestOwner {
  let epoch = 0;
  const sequence = new Map<string, number>();

  return {
    begin(id) {
      const next = (sequence.get(id) ?? 0) + 1;
      sequence.set(id, next);
      return { sessionId: id, generation: epoch, sequence: next };
    },
    invalidate() {
      epoch++;
    },
    isCurrent(token) {
      return token.generation === epoch && sequence.get(token.sessionId) === token.sequence;
    },
  };
}
