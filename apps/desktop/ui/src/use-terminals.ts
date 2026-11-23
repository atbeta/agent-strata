import { createEffect, createMemo, createResource, onCleanup } from "solid-js";
import { listTerminals, streamUrlFor } from "./api";

export type Terminals = ReturnType<typeof useTerminals>;

/**
 * The interactive terminals of one session.
 *
 * The composer capsule and the rail tab read this same list, and the capsule
 * has to keep working after the rail closes. A terminal the tab manufactured
 * on arrival is not in here as a special case: the tab does not manufacture
 * one. What remains is a shell someone started — the reader, the dock toggle,
 * or the agent.
 */
export function useTerminals(sessionId: () => string, enabled: () => boolean = () => true) {
  const [sessions, { refetch }] = createResource(
    () => (enabled() ? sessionId() : undefined),
    (id) => listTerminals(id).then((listed) => listed.sessions),
  );
  const running = createMemo(() => (sessions() ?? []).filter((row) => row.status === "running"));
  const count = createMemo(() => running().length);
  const titles = createMemo(() => running().map((row) => row.title).filter(Boolean));

  createEffect(() => {
    if (!enabled()) return;
    const session = sessionId();
    let source: EventSource | undefined;
    let closed = false;
    void streamUrlFor(`/plugins/terminal/events?session=${encodeURIComponent(session)}`).then((url) => {
      if (closed) return;
      source = new EventSource(url);
      source.onmessage = (event) => {
        const data = JSON.parse(String(event.data)) as { type?: string; data?: { session_id?: string } };
        if (data.type !== "terminal.changed") return;
        const owner = data.data?.session_id;
        if (owner !== undefined && owner !== session) return;
        void refetch();
      };
    }).catch(() => {});
    onCleanup(() => {
      closed = true;
      source?.close();
    });
  });

  return { sessions, count, titles, refetch };
}
