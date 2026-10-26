import { For, Show, type JSX } from "solid-js";
import { cn } from "@/lib/utils";

/**
 * The three shapes every settings section is built from. They live here rather
 * than inside settings.tsx because the provider and permission sections sit in the
 * same page and have to agree with it — a section heading that is one size in
 * one place and another size in the next reads as two apps in one window.
 */

/** The name of a group of settings, quieter than any row inside it. */
export function Group(props: {
  label: string;
  /** One quiet line under the label — what the group is for. */
  hint?: string;
  /** The right end of the label line — a count or a small action. */
  aside?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <section class="mt-8">
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="text-2xs font-medium text-muted-foreground">{props.label}</h2>
        {props.aside}
      </div>
      <Show when={props.hint}>
        <p class="mt-1 text-2xs leading-4 text-muted-foreground">{props.hint}</p>
      </Show>
      <div class="mt-2">{props.children}</div>
    </section>
  );
}

/**
 * The bordered surface a group's Rows sit in. It pads horizontally and rules
 * a hairline between children; a card that holds list rows instead of Rows
 * passes `class="px-0"` and lets its rows pad themselves.
 */
export function Card(props: { children: JSX.Element; class?: string }) {
  return (
    <div
      class={cn(
        "divide-y divide-border rounded-lg border border-border bg-card px-4",
        props.class,
      )}
    >
      {props.children}
    </div>
  );
}

/**
 * One setting and its control. Wide rows put the control in a fixed column so
 * every row ends at the same x; narrow rows stack instead of crushing the label.
 */
export function Row(props: {
  label: string;
  hint?: string;
  /** Extra line under the hint — the result or error belonging to this row. */
  note?: JSX.Element;
  /** Control column width. A row whose control is wider than one chip-column
   *  needs more room or the chips wrap and leave an orphan on their own line. */
  controlClass?: string;
  children: JSX.Element;
}) {
  return (
    <div class="flex flex-col gap-3 py-3 @min-[560px]/main:flex-row @min-[560px]/main:items-start @min-[560px]/main:justify-between @min-[560px]/main:gap-6">
      <div class="min-w-0 pt-1">
        <div class="text-sm font-medium text-foreground">{props.label}</div>
        <Show when={props.hint}>
          <div class="mt-0.5 text-2xs leading-4 text-muted-foreground">{props.hint}</div>
        </Show>
        {props.note}
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
      class="inline-flex max-w-full overflow-x-auto rounded-md border border-border p-0.5"
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
  // One look for one-pick controls: the fill says selected, no ring — the
  // same surface Segmented uses, so a pill set and a segmented row read as
  // the same control drawn two ways.
  return `rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
    on
      ? "border-transparent bg-secondary text-foreground"
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
