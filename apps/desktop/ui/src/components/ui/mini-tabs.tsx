import { For, onCleanup, Show, splitProps, type JSX } from "solid-js";
import { cn } from "@/lib/utils";
import { handleRovingKey } from "@/roving-key";

type MiniTab = { id: string; label: string; count?: number; title?: string };

/**
 * The compact switcher — two or three words where one of them is on, at panel
 * scale. `Segmented` in settings-blocks is the same idea at settings scale and
 * this is deliberately not a variant of it: that one is a bordered container
 * with room for a swatch, this one has no container and reads as part of the
 * bar it sits in.
 *
 * Three call sites had it: the review source and layout pickers, and the MCP
 * server kind picker. Two of them were missing the
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
  // Keyed on the id, not the option object. Callers rebuild the array whenever
  // a neighbouring count changes — the rail does it on every transcript tick —
  // and `<For>` throws a button away when its object is a new one. The press
  // that was on it never becomes a click, and the selected chip flashes.
  const buttons = new Map<string, HTMLButtonElement>();
  const navigate = (event: KeyboardEvent, id: string) => {
    const options = local.options;
    const index = options.findIndex((option) => option.id === id);
    handleRovingKey(
      event,
      index,
      options,
      local.onChange,
      options.map((option) => buttons.get(option.id)),
    );
  };
  return (
    <div
      class={cn("flex items-center gap-0.5", local.class)}
      role={kind() === "tabs" ? "tablist" : "radiogroup"}
      aria-label={local.label}
      {...rest}
    >
      <For each={local.options.map((option) => option.id)}>
        {(id) => {
          const option = () => local.options.find((item) => item.id === id);
          onCleanup(() => buttons.delete(id));
          return (
            <Show when={option()}>
              {(item) => (
                <button
                  ref={(el) => buttons.set(id, el)}
                  type="button"
                  role={kind() === "tabs" ? "tab" : "radio"}
                  id={kind() === "tabs" && local.panelId ? `${local.panelId}-tab-${id}` : undefined}
                  aria-controls={kind() === "tabs" ? local.panelId : undefined}
                  aria-selected={kind() === "tabs" ? local.value === id : undefined}
                  aria-checked={kind() === "radio" ? local.value === id : undefined}
                  tabIndex={selectedIndex() === local.options.findIndex((item) => item.id === id) ? 0 : -1}
                  class={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    local.value === id
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                  }`}
                  title={item().title}
                  onClick={() => local.onChange(id)}
                  onKeyDown={(e) => navigate(e, id)}
                >
                  {item().label}
                  <Show when={item().count !== undefined && item().count > 0}>
                    <span class="text-muted-foreground"> {item().count}</span>
                  </Show>
                </button>
              )}
            </Show>
          );
        }}
      </For>
      {local.children}
    </div>
  );
}
