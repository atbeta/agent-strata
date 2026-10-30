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

export function createRequestOwner(): RequestOwner {
  let sessionId: string | undefined;
  let generation = 0;
  let sequence = 0;

  return {
    begin(id) {
      if (id !== sessionId) {
        sessionId = id;
        generation++;
      }
      return { sessionId: id, generation, sequence: ++sequence };
    },
    invalidate() {
      sessionId = undefined;
      generation++;
      sequence++;
    },
    isCurrent(token) {
      return token.sessionId === sessionId && token.generation === generation && token.sequence === sequence;
    },
  };
}
