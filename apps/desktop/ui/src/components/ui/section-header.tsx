import { Show, type JSX } from "solid-js";
import { cn } from "@/lib/utils";
import { Icon, type Name } from "@/icons";

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
  /** `onToggle` normally draws a chevron; a group whose icon already says
      open/closed (the project folder) can skip it. */
  chevron?: boolean;
  /** A glyph before the label — a folder for project groups, which can swap
      between its open and closed shapes as `open` changes. */
  icon?: Name;
  /** An inline control at the row's right edge — a group-level action that is
      not part of the fold toggle (a "+" to start a session in this project). */
  action?: JSX.Element;
  /** Open, but with nothing under the label. The air above an expanded
      section exists to separate it from the sessions of the group before
      it; an empty folder has no sessions to separate, so it stays a row. */
  tight?: boolean;
  class?: string;
}) {
  const inner = () => (
    <>
      <Show when={props.icon}>
        {(name) => <Icon name={name()} class="size-3.5 shrink-0 text-muted-foreground/70" />}
      </Show>
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
        props.onToggle && (props.open === false || props.tight) ? "py-0.5" : "pt-2.5 pb-1",
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
          <Show when={props.chevron !== false}>
            <Icon
              name="chevron"
              class={cn(
                "size-3 shrink-0 text-muted-foreground/50 transition-transform group-hover/hdr:text-muted-foreground",
                props.open === false && "-rotate-90",
              )}
            />
          </Show>
          {inner()}
        </button>
      </Show>
      <Show when={props.action}>{(a) => a()}</Show>
    </h2>
  );
}
