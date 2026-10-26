import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { apiFetch, SERVICE_BOOT_MS } from "./api";
import { settled } from "./resource";
import {
  STARTUP_SLOW_MS,
  startupCanEnter,
  startupStage,
  syncProgress,
  type StartupHealth,
} from "./startup";
import type { ConnectionsCtl } from "./use-connections";
import type { SessionListCtl } from "./use-session-list";
import type { WorkspaceCtl } from "./use-workspace";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One health request, bounded.
 *
 * A fetch to a socket nobody is listening on fails at once; a socket that is
 * listening but stuck does not. The timeout keeps one wedged request from
 * holding the whole launch behind it.
 */
async function healthOk(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_200);
  try {
    const res = await apiFetch("/health", { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The launch, as one state instead of four screens noticing the same absence.
 *
 * The hook owns the health probe, the first reread after the sidecar answers,
 * and the stages the startup screen shows. It deliberately does not own the
 * event stream: the app already has one, and a second one would make sync
 * progress arrive twice.
 */
export function useStartup(opts: {
  conns: ConnectionsCtl;
  list: SessionListCtl;
  ws: WorkspaceCtl;
}) {
  const [health, setHealth] = createSignal<StartupHealth>("checking");
  const [elapsed, setElapsed] = createSignal(0);
  const [visible, setVisible] = createSignal(false);
  const [skipped, setSkipped] = createSignal(false);
  const [entered, setEntered] = createSignal(false);
  /** Once launch is over it stays over, even when a later sync starts. */
  const [launched, setLaunched] = createSignal(false);
  const started = Date.now();

  let generation = 0;
  let wasUp = false;

  const probe = async () => {
    const mine = ++generation;
    setHealth("checking");
    const deadline = Date.now() + SERVICE_BOOT_MS;
    for (;;) {
      if (await healthOk()) {
        if (mine === generation) setHealth("up");
        return;
      }
      if (Date.now() >= deadline) {
        if (mine === generation) setHealth("down");
        return;
      }
      await sleep(300);
      if (mine !== generation) return;
    }
  };

  onMount(() => {
    void probe();
    const tick = setInterval(() => setElapsed(Date.now() - started), 1_000);
    // A launch that is over before the next frame should not flash a screen.
    // The gap before this timer is a plain background, not the old red one.
    const show = setTimeout(() => setVisible(true), 150);
    onCleanup(() => {
      generation++;
      clearInterval(tick);
      clearTimeout(show);
    });
  });

  // The sidecar has answered for the first time. Every first read was racing
  // it; reread them once here instead of leaving each screen to recover alone.
  createEffect(() => {
    const up = health() === "up";
    if (up && !wasUp) {
      wasUp = true;
      opts.conns.refetchConns();
      opts.list.refetch();
      opts.ws.refetchWs();
    }
    if (!up) wasUp = false;
  });

  // `/health` is up but the connection read itself failed. That is a lost
  // request, not "there is no backend"; reread it until the real phase arrives.
  createEffect(() => {
    if (health() !== "up") return;
    const phase = opts.conns.phase();
    if (phase !== "unreachable") return;
    const timer = setInterval(() => opts.conns.refetchConns(), 1_000);
    onCleanup(() => clearInterval(timer));
  });

  // Same for the first session list: a read that lost the race is retried,
  // while a list that already has data may keep showing it through a refetch.
  createEffect(() => {
    if (health() !== "up") return;
    if (settled(opts.list.data)) return;
    if (!opts.list.data.error) return;
    const timer = setInterval(() => opts.list.refetch(), 1_500);
    onCleanup(() => clearInterval(timer));
  });

  const sessions = (): "loading" | "ready" | "error" => {
    if (settled(opts.list.data)) return "ready";
    // A refetch clears the old answer before the new one lands; the error
    // left beside it is history, not a verdict on the request in flight.
    if (opts.list.data.loading) return "loading";
    return opts.list.data.error ? "error" : "loading";
  };

  const syncing = () => opts.conns.syncTicks().size > 0;
  const stage = createMemo(() =>
    startupStage({
      health: health(),
      connections: opts.conns.phase(),
      sessions: sessions(),
      syncing: syncing(),
      skipped: skipped(),
    }),
  );
  const sync = createMemo(() => syncProgress(opts.conns.syncTicks()));

  // A sync is part of the launch only until the first launch finishes. Later
  // background syncs must not put the startup screen back over a window the
  // reader is already using, so success latches instead of being re-derived.
  createEffect(() => {
    if (stage() === "ready") setLaunched(true);
  });

  const ready = () => launched() || entered();
  const canEnter = () =>
    startupCanEnter(stage(), { elapsedMs: elapsed(), sessionsReady: sessions() === "ready" });
  const slow = () =>
    elapsed() >= STARTUP_SLOW_MS &&
    (stage() === "service" ||
      stage() === "opencode" ||
      stage() === "sessions" ||
      stage() === "sync");

  const enter = () => {
    setSkipped(true);
    setEntered(true);
  };

  const retry = () => {
    setSkipped(false);
    void probe();
    opts.conns.refetchConns();
    opts.list.refetch();
    opts.ws.refetchWs();
  };

  return { stage, sync, ready, canEnter, slow, visible, elapsed, enter, retry };
}
