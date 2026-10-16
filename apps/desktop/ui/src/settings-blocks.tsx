import { For, Show, type JSX } from "solid-js";
import { cn } from "@/lib/utils";

/**
 * The three shapes every settings section is built from. They live here rather
 * than inside settings.tsx because the provider and permission sections sit in the
 * same page and have to agree with it — a section heading that is one size in
 * one place and another size in the next reads as two apps in one window.
 */

/** The name of a group of settings, quieter than any row inside it. */
export function Group(props: { label: string; children: JSX.Element }) {
  return (
    <section class="mt-8">
      <h2 class="text-xs text-muted-foreground">{props.label}</h2>
      <div class="mt-2">{props.children}</div>
    </section>
  );
}

/**
 * One setting and its control. Wide rows put the control in a fixed column so
 * every row ends at the same x; narrow rows stack instead of crushing the label.
 */
export function Row(props: {
  label: string;
  hint?: string;
  /** Control column width. A row whose control is wider than one chip-column
   *  needs more room or the chips wrap and leave an orphan on their own line. */
  controlClass?: string;
  children: JSX.Element;
}) {
  return (
    <div class="flex flex-col gap-3 py-2.5 @min-[560px]/main:flex-row @min-[560px]/main:items-start @min-[560px]/main:justify-between @min-[560px]/main:gap-6">
      <div class="min-w-0 pt-1">
        <div class="text-sm text-foreground">{props.label}</div>
        <Show when={props.hint}>
          <div class="mt-0.5 text-2xs leading-4 text-muted-foreground">{props.hint}</div>
        </Show>
      </div>
      <div class={cn("flex max-w-full shrink-0 justify-end pt-1", props.controlClass ?? "w-60", "@max-[560px]/main:w-full @max-[560px]/main:justify-start")}>
        {props.children}
      </div>
    </div>
  );
}

/**
 * One choice among a few, as a single control. A row of cards gives a setting
 * that changes one value the visual weight of a decision that changes the app.
 */
export function Segmented(props: {
  label: string;
  value: string;
  options: { id: string; label: string; swatch?: JSX.Element }[];
  onChange: (id: string) => void;
}) {
  return (
    <div
      class="inline-flex max-w-full overflow-x-auto rounded-lg border border-border p-0.5"
      role="radiogroup"
      aria-label={props.label}
    >
      {props.options.map((option) => (
        <button
          type="button"
          role="radio"
          aria-checked={props.value === option.id}
          class={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
            props.value === option.id
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          }`}
          onClick={() => props.onChange(option.id)}
        >
          {option.swatch}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A compact choice chip, for the sets too many to sit inside one control. */
export function pill(on: boolean): string {
  return `rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
    on
      ? "border-ring bg-secondary text-foreground"
      : "border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
  }`;
}

/**
 * The pill idiom as a whole — one choice among several, as separate chips
 * rather than one bordered container.
 *
 * `Segmented` covers the two- and three-option case; this covers the wider sets
 * (six font sizes, four leading presets) that would not fit inside one
 * control. It exists because each group was assembling the same radiogroup
 * wiring by hand, so the one row whose options overflowed the control column
 * and wrapped onto a second line was fixed by widening that single row — the
 * next wide set would have wrapped the same way. `wrap` stays on deliberately:
 * a set too wide for its column folds instead of spilling past the edge.
 */
export function PillGroup(props: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <div
      class="flex flex-wrap justify-end gap-1.5"
      role="radiogroup"
      aria-label={props.label}
    >
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === option.id}
            class={pill(props.value === option.id)}
            onClick={() => props.onChange(option.id)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}
