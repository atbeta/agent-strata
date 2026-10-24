import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { readDevLogs, stopDevProcess, type DevLogLine, type DevProcess } from "./api";
import { t } from "./i18n";
import { fmtLatency } from "./transcript-format";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";

/** How often the running time and the open log refresh. */
const TICK_MS = 1_000;

/** Whether a process is still up, by the only definition the panel has. */
export function devRunning(process: DevProcess): boolean {
  return process.exit_code === null;
}

/**
 * What the row says about a process, in the order that matters.
 *
 * A process that never started has no exit code and no uptime: it has an error,
 * and that error is the whole story. A stopped one is not "exited 143" to a
 * reader who pressed the button — it is stopped.
 */
function stateLabel(process: DevProcess): string {
  if (process.error && process.exit_code !== 0) return t("dev.failed");
  if (devRunning(process)) return t("dev.running");
  if (process.stopped) return t("dev.stopped");
  return t("dev.exited", { code: process.exit_code ?? 0 });
}

function stateClass(process: DevProcess): string {
  if (process.error && process.exit_code !== 0) return "text-destructive";
  if (devRunning(process)) return "text-status-active";
  if (process.stopped) return "text-muted-foreground";
  return "text-status-error";
}

/**
 * The commands a session left running, and the controls for them.
 *
 * They live here rather than in the transcript because they outlive a turn: a
 * dev server started twenty minutes ago is not part of any one reply, and a
 * reader asking "what is on port 3000" should not have to scroll to find out.
 *
 * The list itself is owned by the rail, which also puts its count on the tab —
 * one read, one subscription, two places that need the same answer.
 */
export function BackgroundPanel(props: {
  processes: () => DevProcess[];
  onStop: (id: string) => Promise<void>;
}) {
  const [now, setNow] = createSignal(Date.now());
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [err, setErr] = createSignal("");

  createEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    onCleanup(() => clearInterval(timer));
  });

  const stop = async (id: string) => {
    setErr("");
    setBusy(id);
    try {
      await props.onStop(id);
    } catch (e) {
      setErr(t("dev.stop.failed", { reason: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const uptime = (process: DevProcess): string | undefined => {
    if (!devRunning(process)) return undefined;
    return fmtLatency(Math.max(0, now() - process.started_at));
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <Show when={err()}>
        <p class="shrink-0 border-b border-border px-3 py-1.5 text-xs text-destructive">{err()}</p>
      </Show>
      <Show
        when={props.processes().length > 0}
        fallback={
          <div class="px-3 py-4">
            <p class="text-xs text-muted-foreground">{t("dev.empty")}</p>
            <p class="mt-1 text-2xs text-muted-foreground/80">{t("dev.empty.hint")}</p>
          </div>
        }
      >
        <ul class="min-h-0 flex-1 overflow-y-auto py-1">
          <For each={props.processes()}>
            {(process) => (
              <li class="border-b border-border/60 last:border-b-0">
                <div class="flex items-start gap-1 px-2 py-1.5">
                  <RowButton
                    aria-expanded={openId() === process.id}
                    onClick={() => setOpenId(openId() === process.id ? null : process.id)}
                    class="min-w-0 flex-1 items-start px-1 py-1 hover:bg-secondary"
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block truncate font-mono text-xs" title={process.command}>
                        {process.command}
                      </span>
                      <span class="mt-0.5 flex items-center gap-1.5 text-2xs">
                        <span class={stateClass(process)}>{stateLabel(process)}</span>
                        <Show when={process.pid !== undefined}>
                          <span class="text-muted-foreground">{t("dev.pid", { pid: process.pid ?? 0 })}</span>
                        </Show>
                        <Show when={uptime(process)}>
                          {(time) => <span class="text-muted-foreground">{t("dev.uptime", { time: time() })}</span>}
                        </Show>
                      </span>
                      <Show when={process.error}>
                        {(message) => (
                          <span class="mt-0.5 block truncate text-2xs text-destructive" title={message()}>
                            {message()}
                          </span>
                        )}
                      </Show>
                      <Show when={!process.error && process.last_line}>
                        {(line) => (
                          <span class="mt-0.5 block truncate text-2xs text-muted-foreground" title={line()}>
                            {line()}
                          </span>
                        )}
                      </Show>
                    </span>
                  </RowButton>
                  <Show when={devRunning(process)}>
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
                  </Show>
                </div>
                <Show when={openId() === process.id}>
                  <ProcessLogs processId={process.id} />
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/**
 * The tail of one process's output.
 *
 * Read on a slow tick rather than streamed: a dev server writes in bursts, and
 * a pane that re-renders on every line spends more time laying out than the
 * reader spends reading.
 */
function ProcessLogs(props: { processId: string }) {
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
    <div class="max-h-56 overflow-auto border-t border-border/60 bg-muted/30 px-2 py-1.5">
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
