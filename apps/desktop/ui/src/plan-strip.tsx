import { createSignal, For, Show } from "solid-js";
import { Icon } from "./icons";
import { t } from "./i18n";
import {
  planOpensOnEntry,
  planProgress,
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
export function PlanStrip(props: { sessionId: string; plan: readonly PlanItem[]; generating: boolean }) {
  const progress = () => planProgress(props.plan);
  const [choice, setChoice] = createSignal<boolean | undefined>(readPlanChoice(props.sessionId));
  /** No choice yet means the plan gets to decide, and only a toggle outranks it. */
  const open = () => choice() ?? planOpensOnEntry(props.plan, props.generating);
  const toggle = () => {
    const next = !open();
    setChoice(next);
    writePlanChoice(props.sessionId, next);
  };
  return (
    <div class="rounded-t-2xl border border-b-0 border-input bg-secondary/70 px-3 pb-4 pt-2">
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
