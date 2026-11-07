import { createSignal, For, Show } from "solid-js";
import { Icon } from "./icons";
import { t } from "./i18n";
import {
  planOpensOnEntry,
  planProgress,
  planSegments,
  readPlanChoice,
  writePlanChoice,
  type PlanItem,
} from "./plan-progress";
import { Button } from "@/components/ui/button";

/**
 * The session's todo list tucked under the composer: one line when collapsed —
 * progress and the step it is on — the full list when opened.
 *
 * The choice is read from this session's own key and written back to it, so it
 * survives leaving and coming back without leaking into the next session. A
 * component-level signal is right here and a module-level one would be wrong:
 * `keyed` routing rebuilds `SessionDetail` per session, so this initialiser
 * runs again for each one, which is exactly what a per-session read needs.
 */
export function PlanStrip(props: {
  sessionId: string;
  plan: readonly PlanItem[];
  generating: boolean;
  /** another strip sits above this one — keep the seam, drop the rounding */
  stacked?: boolean;
}) {
  const progress = () => planProgress(props.plan);
  const segments = () => planSegments(props.plan);
  const percent = () => {
    const p = progress();
    return p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
  };
  /** The colour alone must not be the status: the words go to a screen reader. */
  const statusLabel = (status: PlanItem["status"]) =>
    status === "completed"
      ? t("plan.status.completed")
      : status === "in_progress"
        ? t("plan.status.in_progress")
        : t("plan.status.pending");
  const statusTone = (status: PlanItem["status"]) =>
    status === "completed"
      ? "text-faint-foreground"
      : status === "in_progress"
        ? "text-foreground font-medium"
        : "text-muted-foreground";
  const [choice, setChoice] = createSignal<boolean | undefined>(readPlanChoice(props.sessionId));
  /** No choice yet means the plan gets to decide, and only a toggle outranks it. */
  const open = () => choice() ?? planOpensOnEntry(props.plan, props.generating);
  const toggle = () => {
    const next = !open();
    setChoice(next);
    writePlanChoice(props.sessionId, next);
  };
  return (
    <div
      class={`border border-b-0 bg-secondary/70 px-3 pb-4 pt-2 ${
        props.stacked ? "border-input border-t-input/60" : "rounded-t-2xl border-input"
      }`}
    >
      <Button
        type="button"
        variant="quiet"
        class="h-auto w-full justify-start whitespace-normal px-0 text-left font-normal"
        aria-expanded={open()}
        onClick={toggle}
      >
        <span class="shrink-0 text-2xs font-medium text-muted-foreground">{t("plan.title")}</span>
        <span class="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {t("plan.progress", { done: progress().done, total: progress().total })}
        </span>
        <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {open() ? "" : progress().allDone ? t("plan.done") : progress().current}
        </span>
        <Icon
          name="chevron"
          class={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open() ? "rotate-180" : ""}`}
        />
      </Button>
      <Show when={open()}>
        {/* A segment per step while the list is short enough for each to be
            seen: the same total width as a ratio fill, but every mark sits
            opposite the row it describes, so the strip says where in the plan
            the run is rather than only how much of it is done. A list too long
            to segment falls back to the ratio fill — a sliver no reader can
            connect to a row is noise. */}
        <div class="mt-1.5 h-0.5 overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
          <Show
            when={segments()}
            fallback={
              <div
                class="h-full rounded-full bg-status-completed transition-[width] duration-300"
                style={{ width: `${percent()}%` }}
              />
            }
          >
            {(parts) => (
              <div class="flex h-full gap-px">
                <For each={parts()}>
                  {(part) => (
                    <span
                      class={`h-full flex-1 rounded-[1px] transition-colors ${
                        part.status === "completed"
                          ? "bg-status-completed"
                          : part.status === "in_progress"
                            ? "bg-status-active motion-safe:animate-pulse"
                            : "bg-foreground/10"
                      }`}
                    />
                  )}
                </For>
              </div>
            )}
          </Show>
        </div>
        <ul class="expand-in mt-2 max-h-[40vh] space-y-1 overflow-y-auto text-xs leading-5">
          <For each={props.plan}>
            {(item) => (
              <li
                class={`flex gap-2 rounded-sm px-1 ${
                  item.status === "in_progress"
                    ? "bg-status-active/10 shadow-[inset_2px_0_0_var(--status-active)]"
                    : ""
                }`}
                aria-current={item.status === "in_progress" ? "step" : undefined}
              >
                <span class="mt-1 grid size-3.5 shrink-0 place-items-center" aria-hidden="true">
                  <Show when={item.status === "completed"}>
                    <Icon name="check" class="size-3 text-status-completed" />
                  </Show>
                  <Show when={item.status === "in_progress"}>
                    <span class="size-1.5 rounded-full bg-status-active motion-safe:animate-pulse" />
                  </Show>
                  <Show when={item.status === "pending"}>
                    <span class="size-1.5 rounded-full border border-muted-foreground/40" />
                  </Show>
                </span>
                <span class="sr-only">{statusLabel(item.status)}</span>
                <span class={`min-w-0 ${statusTone(item.status)}`}>{item.content}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
