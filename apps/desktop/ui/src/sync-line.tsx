import { createMemo, Show } from "solid-js";
import { t } from "./i18n";
import { cn } from "./lib/utils";
import { syncProgress } from "./startup";

/**
 * A two-pixel line at the top of the content, for a sync long enough to
 * notice.
 *
 * The sidebar footer already carries a spinner, but a footer is the last place
 * a reader looks when the page in front of them stops moving. This line sits
 * over the header border, takes no layout space, and says nothing in words —
 * the counts stay in its accessible label and the footer's tooltip.
 */
export function SyncLine(props: {
  ticks: ReadonlyMap<string, { done: number; total: number }>;
  show: boolean;
}) {
  const progress = createMemo(() => syncProgress(props.ticks));
  const percent = () => {
    const p = progress();
    if (!p || p.total <= 0) return 0;
    return Math.min(100, Math.round((p.done / p.total) * 100));
  };
  const label = () => {
    const p = progress();
    if (!p || p.total <= 0) return t("sidebar.sync.scanning");
    return t("sidebar.sync.progress", { done: p.done, total: p.total });
  };

  return (
    <Show when={props.show && progress()}>
      <div
        class="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-foreground/5"
        role="progressbar"
        aria-label={label()}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress()?.indeterminate ? undefined : percent()}
      >
        <div
          class={cn(
            "h-full bg-foreground/25 transition-[width] duration-300",
            progress()?.indeterminate && "w-1/3 motion-safe:animate-pulse",
          )}
          style={progress()?.indeterminate ? undefined : { width: `${percent()}%` }}
        />
      </div>
    </Show>
  );
}
