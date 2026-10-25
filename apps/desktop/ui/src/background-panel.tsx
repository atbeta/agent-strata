import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { readDevLogs, type DevLogLine, type DevProcess } from "./api";
import { dotClass, devRunning, stateClass, stateLabel } from "./dev-state";
import { t } from "./i18n";
import { fmtLatency } from "./transcript-format";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";

/** How often the running time and the open log refresh. */
const TICK_MS = 1_000;

/**
 * One line per process: a status dot, the command, and the number that keeps
 * moving. Everything else — the pid, the error it died with, the last line it
 * printed — is a click away in the detail well, where it cannot crowd the row.
 *
 * Shared with the fleet overview: the two lists ask different questions but a
 * process looks the same in both, so the row lives here once.
 */
export function DevRow(props: {
  process: DevProcess;
  now: number;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  onStop: () => void;
  /** An action that rides beside Stop — the fleet row's session link. */
  extra?: JSX.Element;
}) {
  const p = () => props.process;
  return (
    <div class="flex items-center gap-1 px-2 py-0.5">
      <RowButton
        aria-expanded={props.open}
        onClick={props.onToggle}
        class="min-w-0 flex-1 gap-2 px-1 py-1 hover:bg-secondary"
      >
        <span
          class={`size-1.5 shrink-0 rounded-full ${dotClass(p())}`}
          title={stateLabel(p())}
        />
        <span class="min-w-0 flex-1 truncate font-mono text-xs" title={p().command}>
          {p().command}
        </span>
        <Show
          when={devRunning(p())}
          fallback={
            <span class={`shrink-0 text-2xs ${stateClass(p())}`}>{stateLabel(p())}</span>
          }
        >
          <span class="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {fmtLatency(Math.max(0, props.now - p().started_at))}
          </span>
        </Show>
      </RowButton>
      {props.extra}
      <Show when={devRunning(p())}>
        <Button
          type="button"
          variant="icon"
          size="xs"
          class="shrink-0 px-1.5"
          disabled={props.busy}
          onClick={props.onStop}
        >
          {props.busy ? t("dev.stopping") : t("dev.stop")}
        </Button>
      </Show>
    </div>
  );
}

/**
 * What the collapsed row left out: the words for the state, the pid a reader
 * needs for `kill`, the error a failed start printed. Sits between the row and
 * its log so the click that opened the log opens the context too.
 */
export function DevRowDetail(props: { process: DevProcess }) {
  const p = () => props.process;
  return (
    <div class="space-y-0.5 px-3 pb-1 pt-1.5 text-2xs text-muted-foreground">
      <p>
        {stateLabel(p())}
        <Show when={p().pid !== undefined}>
          {" · "}
          {t("dev.pid", { pid: p().pid ?? 0 })}
        </Show>
      </p>
      <Show when={p().error}>
        <p class="break-words text-destructive">{p().error}</p>
      </Show>
      <Show when={!p().error && p().last_line}>
        <p class="truncate" title={p().last_line}>
          {p().last_line}
        </p>
      </Show>
    </div>
  );
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
                <DevRow
                  process={process}
                  now={now()}
                  open={openId() === process.id}
                  onToggle={() => setOpenId(openId() === process.id ? null : process.id)}
                  busy={busy() === process.id}
                  onStop={() => void stop(process.id)}
                />
                <Show when={openId() === process.id}>
                  <DevRowDetail process={process} />
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
