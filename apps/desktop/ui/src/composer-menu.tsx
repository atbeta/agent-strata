import { createEffect, For, Show } from "solid-js";
import { Icon } from "./icons";
import { t } from "./i18n";
import { Tip } from "./tip";
import { fmtBytes } from "./bytes";
import type { Attachment } from "./composer-input";

export interface MenuItem {
  key: string;
  /** what is inserted after `@` or `/` */
  value: string;
  label: string;
  detail?: string;
  badge?: string;
}

/** Suggestions above the composer. Focus stays in the textarea; rows are picked with the mouse or the keys it forwards. */
export function ComposerMenu(props: {
  /** the listbox's id; rows are `${id}-${index}` */
  id: string;
  kind: "file" | "command";
  items: MenuItem[];
  active: number;
  /** shown instead of rows: why there is nothing yet */
  hint?: string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const title = () => (props.kind === "file" ? t("composer.menu.files") : t("composer.menu.commands"));
  return (
    <div
      class="surface-popover absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground"
      // a press anywhere in the menu, scrollbar included, must not take focus from the textarea
      onMouseDown={(e) => e.preventDefault()}
    >
      <p class="px-2 py-1 text-2xs font-medium text-muted-foreground">{title()}</p>
      <Show
        when={props.items.length > 0}
        fallback={<p class="px-2 pb-1.5 text-sm text-muted-foreground">{props.hint ?? t("composer.menu.no_match")}</p>}
      >
        <ul id={props.id} role="listbox" aria-label={title()} class="max-h-64 overflow-y-auto">
          <For each={props.items}>
            {(item, i) => {
              let row: HTMLLIElement | undefined;
              // keep the active row visible while arrowing through a long list
              createEffect(() => {
                if (i() === props.active) row?.scrollIntoView({ block: "nearest" });
              });
              return (
                <li
                  ref={row}
                  id={`${props.id}-${i()}`}
                  role="option"
                  aria-selected={i() === props.active}
                  class={`flex cursor-default items-baseline gap-2 rounded-md px-2 py-1.5 text-sm ${i() === props.active ? "bg-accent text-accent-foreground" : "hover:bg-secondary"}`}
                  onMouseDown={() => props.onPick(i())}
                  onMouseMove={() => props.onHover(i())}
                >
                  <Show when={props.kind === "file"}>
                    <Icon name="files" class="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
                  </Show>
                  <span class={`shrink-0 ${props.kind === "command" ? "font-mono text-xs" : "truncate"}`}>{item.label}</span>
                  <Show when={item.detail}>
                    <span
                      class={`min-w-0 truncate text-muted-foreground ${props.kind === "file" ? "font-mono text-2xs" : "text-xs"}`}
                    >
                      {item.detail}
                    </span>
                  </Show>
                  <Show when={item.badge}>
                    <span class="ml-auto shrink-0 rounded bg-secondary px-1.5 text-2xs text-muted-foreground">{item.badge}</span>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}

export function AttachmentStrip(props: { items: Attachment[]; onRemove: (id: string) => void }) {
  return (
    <div class="flex flex-wrap gap-2 px-3 pt-3">
      <For each={props.items}>
        {(a) => (
          <div class="group relative">
            <Show
              when={a.mime.startsWith("image/")}
              fallback={
                // A file has no thumbnail, so the chip is the whole of what the
                // reader sees: the name truncated to fit, and a tooltip for
                // everything truncation took — full name, type and size. Without
                // it a long name is unrecoverable and two attachments can look
                // identical.
                <Tip
                  label={`${a.name}\n${a.mime}${a.size === undefined ? "" : ` · ${fmtBytes(a.size)}`}`}
                >
                  <div class="flex h-12 min-w-40 max-w-64 items-center gap-1.5 rounded-md bg-secondary px-2.5">
                    <Icon name="files" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-xs leading-tight">{a.name}</span>
                      <span class="block truncate text-2xs leading-tight text-muted-foreground">
                        {a.mime}
                        <Show when={a.size !== undefined}> · {fmtBytes(a.size!)}</Show>
                      </span>
                    </span>
                  </div>
                </Tip>
              }
            >
              <img src={a.url} alt={a.name} class="h-12 w-12 rounded-md border border-border object-cover" />
            </Show>
            <button
              type="button"
              class="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-foreground text-2xs leading-none text-background opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
              aria-label={t("composer.attach.remove", { name: a.name })}
              onClick={() => props.onRemove(a.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
