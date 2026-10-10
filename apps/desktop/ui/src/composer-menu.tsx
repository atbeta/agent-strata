import { createEffect, For, Show } from "solid-js";
import { Icon } from "./icons";
import { t } from "./i18n";
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
  kind: "file" | "command";
  items: MenuItem[];
  active: number;
  /** shown instead of rows: why there is nothing yet */
  hint?: string;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div class="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
      <p class="px-3 pb-1 pt-2 text-2xs font-medium text-muted-foreground">
        {props.kind === "file" ? t("composer.menu.files") : t("composer.menu.commands")}
      </p>
      <Show
        when={props.items.length > 0}
        fallback={<p class="px-3 pb-2.5 text-sm text-muted-foreground">{props.hint ?? t("composer.menu.no_match")}</p>}
      >
        <ul role="listbox" class="max-h-64 overflow-y-auto px-1 pb-1">
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
                  role="option"
                  aria-selected={i() === props.active}
                  class={`flex cursor-default items-baseline gap-2 rounded-md px-2 py-1.5 text-sm ${i() === props.active ? "bg-secondary text-foreground" : "text-foreground/90"}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    props.onPick(i());
                  }}
                  onMouseMove={() => props.onHover(i())}
                >
                  <Show when={props.kind === "file"}>
                    <Icon name="files" class="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" />
                  </Show>
                  <span class={`shrink-0 ${props.kind === "command" ? "font-mono text-xs" : "truncate"}`}>{item.label}</span>
                  <Show when={item.detail}>
                    <span class="min-w-0 truncate text-xs text-muted-foreground">{item.detail}</span>
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
                <div class="flex h-12 max-w-48 items-center gap-1.5 rounded-md bg-secondary px-2.5 text-xs">
                  <Icon name="files" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span class="truncate">{a.name}</span>
                </div>
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
