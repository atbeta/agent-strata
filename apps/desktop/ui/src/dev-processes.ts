import { createEffect, createMemo, createResource, onCleanup } from "solid-js";
import { deleteDevProcess, listDevProcesses, stopDevProcess, type DevProcess } from "./api";
import { devRunning } from "./dev-state";

export type DevProcesses = ReturnType<typeof useDevProcesses>;

/**
 * The commands one session left running.
 *
 * One resource feeds two places: the rail's background tab, which is the full
 * record (logs, pids, exit states), and the composer's pill, which is the way
 * in. Sharing it means the count on the pill, the count on the tab and the rows
 * they open cannot disagree, and the stream listener stays alive while the rail
 * is closed.
 *
 * The pill has no business polling the service on its own. The hook is called
 * once per session view and lives as long as that view does.
 */
export function useDevProcesses(sessionId: () => string, enabled: () => boolean = () => true) {
  const [processes, { refetch }] = createResource(
    () => (enabled() ? sessionId() : undefined),
    (id) => listDevProcesses(id).then((r) => r.processes).catch(() => [] as DevProcess[]),
  );
  const running = createMemo(() => (processes() ?? []).filter(devRunning));
  const count = createMemo(() => running().length);
  const commands = createMemo(() => running().map((p) => p.command));
  const stop = async (id: string) => {
    await stopDevProcess(id);
    void refetch();
  };
  const forget = async (id: string) => {
    await deleteDevProcess(id);
    void refetch();
  };
  // The agent can start or stop one of these mid-turn, and a restart can reap
  // one without an event reaching this session; only while something claims to
  // be running does the truth need re-asking.
  createEffect(() => {
    if (!enabled()) return;
    const session = sessionId();
    const onStream = (ev: Event) => {
      const evt = (ev as CustomEvent<{ session_id?: string; type?: string }>).detail;
      if (!evt?.type?.startsWith("dev.")) return;
      if (evt.session_id !== undefined && evt.session_id !== session) return;
      void refetch();
    };
    window.addEventListener("strata-stream-event", onStream);
    const tick = setInterval(() => {
      if (count() > 0) void refetch();
    }, 15_000);
    onCleanup(() => {
      window.removeEventListener("strata-stream-event", onStream);
      clearInterval(tick);
    });
  });
  return { processes, running, count, commands, stop, forget, refetch };
}
