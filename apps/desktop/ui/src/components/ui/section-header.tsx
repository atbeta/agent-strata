import { Show } from "solid-js";
import { cn } from "@/lib/utils";
import { Icon } from "@/icons";

/**
 * A sidebar group header: a label, how many rows it holds, and an optional
 * right-aligned hint (a path, in mono).
 *
 * Two shapes, one element. Expanded it is a section divider — a small label
 * with air above it separating this group from the last. Collapsed it is a
 * compact row the same height as the sessions it hides, so a run of folded
 * groups reads as a tidy list instead of sparse drifting labels.
 *
 * `onToggle` makes the whole row a collapse control with a chevron; without
 * it the header stays inert text.
 */
export function SectionHeader(props: {
  label: string;
  count?: number;
  hint?: string;
  /** Long-form hover text; falls back to the hint. */
  title?: string;
  open?: boolean;
  onToggle?: () => void;
  class?: string;
}) {
  const inner = () => (
    <>
      <span class="shrink-0 truncate text-xs font-medium text-muted-foreground">
        {props.label}
      </span>
      <Show when={props.count !== undefined}>
        <span class="shrink-0 font-mono text-2xs text-muted-foreground/60 tabular-nums">
          {props.count}
        </span>
      </Show>
      <Show when={props.hint}>
        <span class="min-w-0 flex-1 truncate text-right font-mono text-2xs text-muted-foreground/70">
          {props.hint}
        </span>
      </Show>
    </>
  );
  return (
    <h2
      class={cn(
        "flex items-baseline gap-1.5 px-2",
        props.onToggle && props.open === false ? "py-0.5" : "pt-2.5 pb-1",
        props.class,
      )}
      title={props.title ?? props.hint}
    >
      <Show when={props.onToggle !== undefined} fallback={inner()}>
        <button
          type="button"
          class="group/hdr flex h-6 min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={props.open}
          onClick={() => props.onToggle!()}
        >
          <Icon
            name="chevron"
            class={cn(
              "size-3 shrink-0 text-muted-foreground/50 transition-transform group-hover/hdr:text-muted-foreground",
              props.open === false && "-rotate-90",
            )}
          />
          {inner()}
        </button>
      </Show>
    </h2>
  );
}
