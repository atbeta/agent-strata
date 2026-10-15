import { Show, splitProps, type JSX } from "solid-js";
import { cn } from "@/lib/utils";
import { Icon } from "@/icons";

/**
 * A bordered card that picks one thing — an option in a pending question, the
 * OpenCode launch mode in settings.
 *
 * It reads as a small set of sentences you choose between, so it carries a
 * border and two lines of text where a `Button` carries one line and a fill.
 * The two call sites had it independently: settings drew `rounded-lg` with no
 * focus ring, the question card drew `rounded-md` with one, and the question
 * card gave no assistive technology any way to know an option was picked.
 *
 * `mode` is the honest part. Settings picks a single value out of a pair, so
 * it belongs in a `radiogroup`. A question may allow several answers, and a
 * radio would lie about that — there the card answers `aria-pressed`, the
 * contract for a toggle that turns something on.
 */
export function ChoiceCard(raw: {
  selected: boolean;
  onSelect: () => void;
  /** "radio" for one-of-N, "press" for a toggle that may be on alongside others. */
  mode?: "radio" | "press";
  /** Draws the check in the corner. Off in settings, where the border already says it. */
  check?: boolean;
  class?: string;
  children: JSX.Element;
}) {
  const [local, rest] = splitProps(raw, ["selected", "onSelect", "mode", "check", "class", "children"]);
  return (
    <button
      type="button"
      role={local.mode === "radio" ? "radio" : undefined}
      aria-checked={local.mode === "radio" ? local.selected : undefined}
      aria-pressed={local.mode === "press" ? local.selected : undefined}
      class={cn(
        "flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        local.selected ? "border-ring bg-secondary" : "border-border hover:bg-secondary/50",
        local.class,
      )}
      onClick={local.onSelect}
      {...rest}
    >
      <span class="min-w-0 flex-1">{local.children}</span>
      <Show when={local.check && local.selected}>
        <Icon name="check" class="mt-0.5 size-3.5 shrink-0 text-foreground" />
      </Show>
    </button>
  );
}
