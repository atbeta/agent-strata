import { createEffect, For, Show } from "solid-js";
import { t } from "./i18n";
import { shellPlatform } from "./shell";
import { RowButton } from "@/components/ui/row-button";
import { CommandDialog } from "@/components/ui/command-dialog";

export function SessionSwitcher(props: {
  open: boolean;
  rows: { id: string; title: string }[];
  at: number;
  currentId?: string;
  onChoose: (id: string) => void;
  onCancel: () => void;
}) {
  let list: HTMLDivElement | undefined;

  createEffect(() => {
    props.at;
    props.open;
    if (!props.open) return;
    queueMicrotask(() => list?.querySelector(`[data-at="true"]`)?.scrollIntoView({ block: "nearest" }));
  });

  return (
    <CommandDialog open={props.open} label={t("switcher.title")} onClose={props.onCancel} class="w-96">
          <p class="px-3 pt-3 pb-1 text-2xs text-muted-foreground">{t("switcher.title")}</p>
          <div ref={list} class="max-h-80 overflow-y-auto p-1">
            <For each={props.rows}>
              {(row, i) => (
                <RowButton
                  class={`gap-3 hover:bg-accent/60 ${
                    i() === props.at ? "bg-accent text-foreground" : "text-foreground/90"
                  }`}
                  active={i() === props.at}
                  onClick={() => props.onChoose(row.id)}
                >
                  <span class="min-w-0 flex-1 truncate">{row.title}</span>
                  <Show when={row.id === props.currentId}>
                    <span class="shrink-0 text-2xs text-muted-foreground">{t("switcher.current")}</span>
                  </Show>
                </RowButton>
              )}
            </For>
          </div>
          <p class="border-t border-border px-3 py-2 text-2xs text-muted-foreground">
            {t("switcher.hint", { key: shellPlatform() === "macos" ? "⌘" : "Ctrl" })}
          </p>
    </CommandDialog>
  );
}
