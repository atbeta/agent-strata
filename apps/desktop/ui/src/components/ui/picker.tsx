import { For, Show, createMemo, createSignal } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuPrimitive,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { cn } from "@/lib/utils";
import { Tip } from "@/tip";

export interface PickerOption {
  value: string;
  label: string;
  /** Items sharing a group are listed under one heading, in first-seen order. */
  group?: string;
}

export interface PickerProps {
  /** Accessible name; also the tooltip. */
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  /** Rendered on the trigger when `value` is empty. */
  placeholder?: string;
  /** Shown above the list, disabled, so the current pick is always visible. */
  emptyOption?: string;
  capitalize?: boolean;
  class?: string;
}

/**
 * A styled replacement for a native <select>.
 *
 * The browser's own control ignores the theme — a grey Windows chrome in a
 * quiet app — and cannot express the grouped model list or a checkmark on the
 * current pick. This drives the same Kobalte menu the rest of the app uses.
 */
export function Picker(props: PickerProps) {
  const [open, setOpen] = createSignal(false);

  const groups = createMemo(() => {
    const out: { name: string; items: PickerOption[] }[] = [];
    const byName = new Map<string, PickerOption[]>();
    for (const opt of props.options) {
      const name = opt.group ?? "";
      let bucket = byName.get(name);
      if (!bucket) {
        bucket = [];
        byName.set(name, bucket);
        out.push({ name, items: bucket });
      }
      bucket.push(opt);
    }
    return out;
  });

  const current = () => props.options.find((o) => o.value === props.value);
  const triggerText = () => current()?.label ?? props.placeholder ?? props.value;

  const pick = (value: string) => {
    props.onChange(value);
    setOpen(false);
  };

  return (
    <DropdownMenu open={open()} onOpenChange={setOpen} gutter={6}>
      <Tip label={props.label}>
        <DropdownMenuTrigger
          class={cn(
            "flex h-7 max-w-52 items-center gap-1 truncate rounded-md bg-transparent px-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
            props.capitalize && "capitalize",
            props.class,
          )}
          aria-label={props.label}
        >
          <span class="truncate">{triggerText()}</span>
          <svg
            viewBox="0 0 12 12"
            class="size-3 shrink-0 opacity-60"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 4.75 6 7.75l3-3" />
          </svg>
        </DropdownMenuTrigger>
      </Tip>

      <DropdownMenuContent class="max-h-80 max-w-64 overflow-y-auto">
        <Show when={props.emptyOption}>
          <DropdownMenuItem
            disabled={props.value === ""}
            onSelect={() => pick("")}
            class="capitalize"
          >
            {props.emptyOption}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </Show>

        <For each={groups()}>
          {(group) => (
            <DropdownMenuPrimitive.Group>
              <Show when={group.name !== ""}>
                <DropdownMenuGroupLabel>{group.name}</DropdownMenuGroupLabel>
              </Show>
              <For each={group.items}>
                {(opt) => (
                  <DropdownMenuItem
                    onSelect={() => pick(opt.value)}
                    class={cn(
                      "justify-between gap-4",
                      props.capitalize && "capitalize",
                      opt.value === props.value && "text-foreground",
                    )}
                  >
                    <span class="truncate font-mono text-xs">{opt.label}</span>
                    <Show when={opt.value === props.value}>
                      <svg
                        viewBox="0 0 12 12"
                        class="size-3 shrink-0 text-foreground"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M2.5 6.2 5 8.6l4.5-5" />
                      </svg>
                    </Show>
                  </DropdownMenuItem>
                )}
              </For>
            </DropdownMenuPrimitive.Group>
          )}
        </For>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}