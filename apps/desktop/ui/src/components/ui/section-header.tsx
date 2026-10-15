import { Show } from "solid-js";
import { cn } from "@/lib/utils";

/**
 * A sidebar group header: a label, how many rows it holds, and an optional
 * right-aligned hint (a path, in mono).
 *
 * The count used to sit in `ml-auto`, which pushed it flush to the panel edge
 * whenever there was no hint — the common case, since most groups are plain
 * date buckets. "更早" and its count "8" ended up 250px apart with nothing
 * between them, so the number read as unrelated chrome rather than as part of
 * the heading. The count now follows the label directly; only the hint takes
 * the far side.
 */
export function SectionHeader(props: {
  label: string;
  count?: number;
  hint?: string;
  class?: string;
}) {
  return (
    <h2
      class={cn("flex items-baseline gap-1.5 px-2 pt-3 pb-1", props.class)}
      title={props.hint}
    >
      <span class="shrink-0 truncate text-2xs font-medium text-muted-foreground">
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
    </h2>
  );
}
