import { For, Show, splitProps, type JSX } from "solid-js";
import { cn } from "@/lib/utils";

type MiniTab = { id: string; label: string; count?: number };

/**
 * The compact switcher — two or three words where one of them is on, at panel
 * scale. `Segmented` in settings-blocks is the same idea at settings scale and
 * this is deliberately not a variant of it: that one is a bordered container
 * with room for a swatch, this one has no container and reads as part of the
 * bar it sits in.
 *
 * Three call sites had it: the changes/files tab strip, the review source
 * picker, the MCP server kind picker. Two of them were missing the
 * `hover:text-foreground` the third had, and none of them drew a focus ring,
 * so tabbing between the three gave an invisible cursor.
 *
 * `kind` exists because the two contracts are genuinely different rather than
 * accidentally so. `tabs` reveals a panel that stays mounted, so it answers
 * `aria-selected` against a `tablist`. `radio` picks one value out of a set
 * that never shows all of it at once, so it answers `aria-checked` inside a
 * `radiogroup`. They look the same on screen; the wiring differs.
 */
export function MiniTabs(raw: {
  value: string;
  options: MiniTab[];
  onChange: (id: string) => void;
  kind?: "tabs" | "radio";
  /** Required for `kind="radio"` — a radiogroup with no name announces nothing. */
  label?: string;
  class?: string;
  children?: JSX.Element;
}) {
  const [local, rest] = splitProps(raw, ["value", "options", "onChange", "kind", "label", "class", "children"]);
  const kind = () => local.kind ?? "radio";
  return (
    <div
      class={cn("flex items-center gap-0.5", local.class)}
      role={kind() === "tabs" ? "tablist" : "radiogroup"}
      aria-label={kind() === "radio" ? local.label : undefined}
      {...rest}
    >
      <For each={local.options}>
        {(option) => (
          <button
            type="button"
            role={kind() === "tabs" ? "tab" : "radio"}
            aria-selected={kind() === "tabs" ? local.value === option.id : undefined}
            aria-checked={kind() === "radio" ? local.value === option.id : undefined}
            class={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              local.value === option.id
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            }`}
            onClick={() => local.onChange(option.id)}
          >
            {option.label}
            <Show when={option.count !== undefined && option.count > 0}>
              <span class="text-muted-foreground"> {option.count}</span>
            </Show>
          </button>
        )}
      </For>
      {local.children}
    </div>
  );
}
