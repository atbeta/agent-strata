import type { SessionView, ViewTail } from "./api";
import { mergeViewTail } from "./live";
import { filesKeyOf, tailMatches, viewFromTail } from "./view-cache";
import { createRequestOwner } from "./request-owner";

export function createSessionViewLoader(deps: {
  readFull: (sessionId: string, replayPos?: number | null) => Promise<SessionView>;
  readTail: (sessionId: string, filesKey?: string) => Promise<ViewTail>;
  currentSessionId?: () => string;
}) {
  const fullOwner = createRequestOwner();
  const tailOwner = createRequestOwner();
  const ownsFull = (token: ReturnType<typeof fullOwner.begin>, sessionId: string) =>
    fullOwner.isCurrent(token) && (deps.currentSessionId?.() ?? sessionId) === sessionId;
  const ownsTail = (token: ReturnType<typeof tailOwner.begin>, sessionId: string) =>
    tailOwner.isCurrent(token) && (deps.currentSessionId?.() ?? sessionId) === sessionId;

  return {
    invalidate() {
      fullOwner.invalidate();
      tailOwner.invalidate();
    },

    async loadFull(
      sessionId: string,
      replayPos: number | null | undefined,
      commit: (view: SessionView, filesKey: string) => void,
    ): Promise<SessionView | undefined> {
      tailOwner.invalidate();
      const token = fullOwner.begin(sessionId);
      const full = await deps.readFull(sessionId, replayPos);
      if (!ownsFull(token, sessionId) || full.session_id !== sessionId) return undefined;
      const key = filesKeyOf(full);
      commit(full, key);
      return full;
    },

    async loadCold(
      sessionId: string,
      commitPreview: (view: SessionView, filesKey?: string) => void,
      commitFull: (view: SessionView, filesKey: string) => void,
    ): Promise<SessionView | undefined> {
      tailOwner.invalidate();
      const token = fullOwner.begin(sessionId);
      const tail = await deps.readTail(sessionId);
      if (!ownsFull(token, sessionId) || tail.session_id !== sessionId) return undefined;
      const preview = viewFromTail(tail);
      commitPreview(preview, tail.files_key);

      const full = await deps.readFull(sessionId).catch(() => undefined);
      if (!ownsFull(token, sessionId)) return undefined;
      if (!full || full.session_id !== sessionId) return preview;
      const key = filesKeyOf(full);
      commitFull(full, key);
      return full;
    },

    async refreshTail(
      sessionId: string,
      filesKey: string | undefined,
      base: () => SessionView | undefined,
      commit: (view: SessionView, filesKey: string | undefined, changed: boolean) => void,
    ): Promise<"stale" | "full" | "applied"> {
      const token = tailOwner.begin(sessionId);
      const tail = await deps.readTail(sessionId, filesKey);
      if (!ownsTail(token, sessionId) || tail.session_id !== sessionId) return "stale";
      const current = base();
      if (!current || current.session_id !== sessionId) return "full";
      if (tailMatches(current, tail)) {
        commit(current, tail.files_key, false);
        return "applied";
      }
      const merged = mergeViewTail(current, tail);
      if (!merged) return "full";
      commit(merged, tail.files_key, true);
      return "applied";
    },
  };
}
