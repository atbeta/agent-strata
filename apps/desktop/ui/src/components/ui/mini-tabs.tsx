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
  /** A radio group is named by this; tabs can also use it. */
  label?: string;
  /** The panel controlled by `kind="tabs"`. */
  panelId?: string;
  class?: string;
  children?: JSX.Element;
}) {
  const [local, rest] = splitProps(raw, ["value", "options", "onChange", "kind", "label", "panelId", "class", "children"]);
  const kind = () => local.kind ?? "radio";
  const selectedIndex = () => Math.max(0, local.options.findIndex((option) => option.id === local.value));
  const items: HTMLButtonElement[] = [];
  const navigate = (e: KeyboardEvent, index: number) => {
    let next: number | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % local.options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (index - 1 + local.options.length) % local.options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = local.options.length - 1;
    if (next === undefined) return;
    e.preventDefault();
    local.onChange(local.options[next]!.id);
    items[next]?.focus();
  };
  return (
    <div
      class={cn("flex items-center gap-0.5", local.class)}
      role={kind() === "tabs" ? "tablist" : "radiogroup"}
      aria-label={local.label}
      {...rest}
    >
      <For each={local.options}>
        {(option, index) => (
          <button
            ref={(el) => (items[index()] = el)}
            type="button"
            role={kind() === "tabs" ? "tab" : "radio"}
            id={kind() === "tabs" && local.panelId ? `${local.panelId}-tab-${option.id}` : undefined}
            aria-controls={kind() === "tabs" ? local.panelId : undefined}
            aria-selected={kind() === "tabs" ? local.value === option.id : undefined}
            aria-checked={kind() === "radio" ? local.value === option.id : undefined}
            tabIndex={selectedIndex() === index() ? 0 : -1}
            class={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              local.value === option.id
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            }`}
            onClick={() => local.onChange(option.id)}
            onKeyDown={(e) => navigate(e, index())}
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
