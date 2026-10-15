import { createEffect, For, Show } from "solid-js";
import { t } from "./i18n";
import { shellPlatform } from "./shell";
import { RowButton } from "@/components/ui/row-button";

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
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center bg-background/50 pt-[15vh]"
        onMouseDown={props.onCancel}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("switcher.title")}
          class="w-96 max-w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
          onMouseDown={(e) => e.stopPropagation()}
        >
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
        </div>
      </div>
    </Show>
  );
}
