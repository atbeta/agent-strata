import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { listAllDevProcesses, readDevLogs, stopDevProcess, type DevLogLine, type DevProcess, type SessionRow } from "./api";
import { t } from "./i18n";
import { displayTitle } from "./session-title";
import { fmtLatency } from "./transcript-format";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";

/** How often the running time and an open log refresh. */
const TICK_MS = 1_000;

function running(process: DevProcess): boolean {
  return process.exit_code === null;
}

function stateLabel(process: DevProcess): string {
  if (process.error && process.exit_code !== 0) return t("dev.failed");
  if (running(process)) return t("dev.running");
  if (process.stopped) return t("dev.stopped");
  return t("dev.exited", { code: process.exit_code ?? 0 });
}

function stateClass(process: DevProcess): string {
  if (process.error && process.exit_code !== 0) return "text-destructive";
  if (running(process)) return "text-status-active";
  if (process.stopped) return "text-muted-foreground";
  return "text-status-error";
}

/**
 * Every command left running, across every session.
 *
 * The per-session panel answers "what is this conversation running". This one
 * answers a different question — "what is on this machine" — which is the one
 * a reader asks when a port is taken, a build is eating CPU, or they are about
 * to close the app and want to know what closes with it.
 *
 * Nothing is filtered by the period tabs: a dev server started last week and
 * still up is exactly the thing worth seeing, so a date window would hide it.
 */
export function FleetDevSection(props: {
  sessions: SessionRow[];
  /** Bumped when the reader changes the overview's own filters. */
  refreshKey?: number;
  onOpenSession: (id: string) => void;
}) {
  const [now, setNow] = createSignal(Date.now());
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [err, setErr] = createSignal("");

  const [processes, { refetch }] = createResource(
    () => props.refreshKey ?? 1,
    () => listAllDevProcesses().then((r) => r.processes).catch(() => [] as DevProcess[]),
  );

  createEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    // A process can exit without any surface having asked; this is the floor.
    const poll = setInterval(() => void refetch(), TICK_MS * 5);
    onCleanup(() => {
      clearInterval(tick);
      clearInterval(poll);
    });
  });

  createEffect(() => {
    const onStream = (ev: Event) => {
      const evt = (ev as CustomEvent<{ type?: string }>).detail;
      if (!evt?.type?.startsWith("dev.")) return;
      void refetch();
    };
    window.addEventListener("strata-stream-event", onStream);
    onCleanup(() => window.removeEventListener("strata-stream-event", onStream));
  });

  const titleOf = (sessionId: string): string => {
    const row = props.sessions.find((s) => s.summary.session_id === sessionId);
    if (!row) return sessionId;
    return displayTitle(row.title ?? row.summary.title) ?? t("common.untitled");
  };

  const live = () => (processes() ?? []).filter(running);

  const stop = async (id: string) => {
    setErr("");
    setBusy(id);
    try {
      await stopDevProcess(id);
      void refetch();
    } catch (e) {
      setErr(t("dev.stop.failed", { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const uptime = (process: DevProcess): string | undefined =>
    running(process) ? fmtLatency(Math.max(0, now() - process.started_at)) : undefined;

  return (
    <Show when={live().length > 0}>
      <section>
        <h2 class="text-xs font-medium text-muted-foreground">
          {t("fleet.dev")}
          <span class="ml-1.5 tabular-nums text-muted-foreground/60">{live().length}</span>
        </h2>
        <Show when={err()}>
          <p class="mt-1.5 text-xs text-destructive">{err()}</p>
        </Show>
        <ul class="mt-2.5 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          <For each={live()}>
            {(process) => (
              <li>
                <div class="flex items-start gap-1 px-3 py-2">
                  <RowButton
                    aria-expanded={openId() === process.id}
                    onClick={() => setOpenId(openId() === process.id ? null : process.id)}
                    class="min-w-0 flex-1 items-start px-1 py-1 hover:bg-secondary"
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block truncate font-mono text-xs" title={process.command}>
                        {process.command}
                      </span>
                      <span class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs">
                        <span class={stateClass(process)}>{stateLabel(process)}</span>
                        <Show when={process.pid !== undefined}>
                          <span class="text-muted-foreground">{t("dev.pid", { pid: process.pid ?? 0 })}</span>
                        </Show>
                        <Show when={uptime(process)}>
                          {(time) => <span class="text-muted-foreground">{t("dev.uptime", { time: time() })}</span>}
                        </Show>
                      </span>
                      <Show when={!process.error && process.last_line}>
                        {(line) => (
                          <span class="mt-0.5 block truncate text-2xs text-muted-foreground" title={line()}>
                            {line()}
                          </span>
                        )}
                      </Show>
                    </span>
                  </RowButton>
                  {/* Outside the row, not inside it: a button nested in a button
                      is invalid markup and swallows the outer row's click. */}
                  <Button
                    type="button"
                    variant="quiet"
                    size="xs"
                    class="mt-1 max-w-[9rem] shrink-0 truncate px-1.5 text-2xs underline decoration-dotted underline-offset-2"
                    title={titleOf(process.session_id)}
                    onClick={() => props.onOpenSession(process.session_id)}
                  >
                    {titleOf(process.session_id)}
                  </Button>
                  <Button
                    type="button"
                    variant="icon"
                    size="xs"
                    class="mt-1 shrink-0 px-1.5"
                    disabled={busy() === process.id}
                    onClick={() => void stop(process.id)}
                  >
                    {busy() === process.id ? t("dev.stopping") : t("dev.stop")}
                  </Button>
                </div>
                <Show when={openId() === process.id}>
                  <FleetDevLogs processId={process.id} />
                </Show>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  );
}

/** The tail of one process's output, read on a slow tick while it is open. */
function FleetDevLogs(props: { processId: string }) {
  const [lines, setLines] = createSignal<DevLogLine[]>([]);
  const [failed, setFailed] = createSignal(false);

  createEffect(() => {
    const id = props.processId;
    let alive = true;
    const read = async () => {
      try {
        const result = await readDevLogs(id, 200);
        if (!alive) return;
        setLines(result.lines);
        setFailed(false);
      } catch {
        if (alive) setFailed(true);
      }
    };
    void read();
    const timer = setInterval(() => void read(), TICK_MS * 2);
    onCleanup(() => {
      alive = false;
      clearInterval(timer);
    });
  });

  return (
    <div class="max-h-56 overflow-auto border-t border-border/60 bg-muted/30 px-3 py-1.5">
      <Show when={failed()}>
        <p class="text-2xs text-destructive">{t("dev.logs.failed")}</p>
      </Show>
      <Show when={!failed() && lines().length === 0}>
        <p class="text-2xs text-muted-foreground">{t("dev.logs.empty")}</p>
      </Show>
      <For each={lines()}>
        {(line) => (
          <div
            class={`whitespace-pre-wrap break-all font-mono text-2xs ${
              line.stream === "err" ? "text-status-error" : "text-foreground/80"
            }`}
          >
            {line.text}
          </div>
        )}
      </For>
    </div>
  );
}
