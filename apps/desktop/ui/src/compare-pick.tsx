import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Dialog as DialogPrimitive } from "@kobalte/core/dialog";
import { type SessionRow } from "./api";
import { compareSessionDetail, compareSessionTitle } from "./compare-summary";
import { t } from "./i18n";
import { shellPlatform } from "./shell";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TextFieldInput } from "@/components/ui/text-field";

/**
 * Pick the other session and leave. The comparison used to be a mode of the
 * whole list — row clicks stopped opening sessions, and the way forward sat
 * in the connection strip — which is a lot of machinery for a side view.
 */
export function ComparePick(props: {
  /** Set while the dialog is open; the session the comparison already has. */
  anchorId: string | undefined;
  sessions: SessionRow[];
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = createSignal("");
  createEffect(on(() => props.anchorId, () => setQuery("")));

  const anchor = createMemo(() =>
    props.sessions.find((s) => s.summary.session_id === props.anchorId),
  );
  const others = createMemo(() =>
    props.sessions
      .filter((s) => s.summary.session_id !== props.anchorId)
      .slice()
      .sort((a, b) => b.summary.last_ts.localeCompare(a.summary.last_ts)),
  );
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    const rows = others();
    if (!q) return rows;
    return rows.filter((s) => {
      const id = s.summary.session_id;
      return (
        compareSessionTitle(s, id).toLowerCase().includes(q) ||
        compareSessionDetail(s).toLowerCase().includes(q)
      );
    });
  });

  return (
    <DialogPrimitive
      open={props.anchorId !== undefined}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          class={cn(
            "fade-in fixed inset-0 z-[60] flex items-center justify-center bg-background/60 px-4",
            shellPlatform() !== "windows" && "backdrop-blur-[2px]",
          )}
        >
          <DialogPrimitive.Content
            aria-label={t("compare.pick.title", {
              name: compareSessionTitle(anchor(), props.anchorId ?? ""),
            })}
            class="dialog-pop surface-dialog flex max-h-[min(32rem,calc(100vh-4rem))] w-[24rem] max-w-full flex-col rounded-xl bg-popover p-4 text-popover-foreground"
          >
            <DialogPrimitive.Title class="text-sm font-semibold text-foreground">
              {t("compare.pick.title", {
                name: compareSessionTitle(anchor(), props.anchorId ?? ""),
              })}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description class="mt-1.5 text-xs leading-5 text-muted-foreground">
              {t("compare.pick.hint")}
            </DialogPrimitive.Description>
            <Show when={others().length > 8}>
              <TextFieldInput
                type="search"
                size="sm"
                class="mt-3"
                placeholder={t("compare.pick.filter")}
                aria-label={t("compare.pick.filter")}
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </Show>
            <div class="mt-3 min-h-0 flex-1 overflow-y-auto">
              <Show
                when={shown().length > 0}
                fallback={
                  <p class="px-2 py-6 text-center text-xs text-muted-foreground">
                    {t(others().length === 0 ? "compare.pick.empty" : "compare.pick.noMatch")}
                  </p>
                }
              >
                <ul class="flex flex-col">
                  <For each={shown()}>
                    {(row) => (
                      <li>
                        <button
                          type="button"
                          class="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-secondary"
                          onClick={() => props.onPick(row.summary.session_id)}
                        >
                          <span class="truncate text-sm text-foreground">
                            {compareSessionTitle(row, row.summary.session_id)}
                          </span>
                          <span class="truncate text-2xs text-muted-foreground">
                            {compareSessionDetail(row)}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
            <div class="mt-3 flex justify-end">
              <Button type="button" size="sm" variant="outline" onClick={() => props.onClose()}>
                {t("compare.pick.cancel")}
              </Button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Overlay>
      </DialogPrimitive.Portal>
    </DialogPrimitive>
  );
}
