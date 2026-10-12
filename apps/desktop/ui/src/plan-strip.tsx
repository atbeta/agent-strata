import { createSignal, For, Show } from "solid-js";
import { Icon } from "./icons";
import { t } from "./i18n";
import { planProgress, readPlanOpen, writePlanOpen, type PlanItem } from "./plan-progress";

/**
 * Collapsed or expanded belongs to the window, not to the session — same story
 * as the side panel: `keyed` routing rebuilds `SessionDetail` on every tab
 * click, so a signal inside it would lose the choice.
 */
const [planOpen, setPlanOpen] = createSignal(readPlanOpen());

/**
 * The session's todo list tucked under the composer: one line when collapsed —
 * progress and the step it is on — the full list when opened.
 */
export function PlanStrip(props: { plan: readonly PlanItem[]; generating: boolean }) {
  const progress = () => planProgress(props.plan);
  const toggle = () => {
    const next = !planOpen();
    setPlanOpen(next);
    writePlanOpen(next);
  };
  return (
    <div class="rounded-t-2xl border border-b-0 border-input bg-secondary/70 px-3 pb-4 pt-2">
      <button
        type="button"
        class="flex w-full items-center gap-2 text-left"
        aria-expanded={planOpen()}
        onClick={toggle}
      >
        <span class="shrink-0 text-2xs font-medium text-muted-foreground">{t("plan.title")}</span>
        <span class="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {t("plan.progress", { done: progress().done, total: progress().total })}
        </span>
        <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {planOpen() ? "" : progress().allDone ? t("plan.done") : progress().current}
        </span>
        <Icon
          name="chevron"
          class={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${planOpen() ? "rotate-180" : ""}`}
        />
      </button>
      <Show when={planOpen()}>
        <ul class="mt-1.5 max-h-[40vh] space-y-1 overflow-y-auto text-sm">
          <For each={props.plan}>
            {(item) => (
              <li class="flex gap-2 px-1">
                <span
                  class={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                    item.status === "completed"
                      ? "bg-status-completed"
                      : item.status === "in_progress"
                        ? "bg-status-active"
                        : "bg-status-pending"
                  }`}
                />
                <span
                  class={
                    item.status === "completed"
                      ? "text-muted-foreground line-through"
                      : item.status === "in_progress"
                        ? "text-foreground"
                        : ""
                  }
                >
                  {item.content}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
