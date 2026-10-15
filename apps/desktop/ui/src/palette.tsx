import { createEffect, createSignal, For, Show } from "solid-js";
import { commandList, formatChord, type AppCommand } from "./commands";
import { t } from "./i18n";
import { RowButton } from "@/components/ui/row-button";

type PaletteRow =
  | { kind: "command"; cmd: AppCommand }
  | { kind: "session"; id: string; title: string };

export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  sessions: { id: string; title: string }[];
  onOpenSession: (id: string) => void;
}) {
  const [query, setQuery] = createSignal("");
  const [at, setAt] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;

  const rows = (): PaletteRow[] => {
    const needle = query().trim().toLowerCase();
    const commands: PaletteRow[] = commandList()
      .filter((cmd) => !needle || cmd.title().toLowerCase().includes(needle))
      .map((cmd) => ({ kind: "command", cmd }));
    const sessions: PaletteRow[] = needle
      ? props.sessions
          .filter((session) => session.title.toLowerCase().includes(needle))
          .map((session) => ({ kind: "session", id: session.id, title: session.title }))
      : [];
    return [...commands, ...sessions];
  };

  createEffect(() => {
    if (!props.open) return;
    setQuery("");
    setAt(0);
    queueMicrotask(() => input?.focus());
  });

  const choose = (row: PaletteRow | undefined) => {
    if (!row) return;
    props.onClose();
    if (row.kind === "command") row.cmd.run();
    else props.onOpenSession(row.id);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const all = rows();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAt((i) => (all.length === 0 ? 0 : (i + 1) % all.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAt((i) => (all.length === 0 ? 0 : (i - 1 + all.length) % all.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(all[at()]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    }
    queueMicrotask(() => list?.querySelector(`[data-at="true"]`)?.scrollIntoView({ block: "nearest" }));
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center bg-background/50 pt-[15vh]"
        onMouseDown={props.onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("palette.title")}
          class="w-[32rem] max-w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            ref={input}
            class="h-11 w-full bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            placeholder={t("palette.placeholder")}
            aria-label={t("palette.title")}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setAt(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div ref={list} class="max-h-80 overflow-y-auto border-t border-border p-1">
            <Show
              when={rows().length > 0}
              fallback={<p class="px-2 py-6 text-center text-sm text-muted-foreground">{t("palette.empty")}</p>}
            >
              <For each={rows()}>
                {(row, i) => (
                  <>
                    <Show when={row.kind === "session" && rows()[i() - 1]?.kind !== "session"}>
                      <p class="px-2 pt-2 pb-1 text-2xs text-muted-foreground">{t("palette.sessions")}</p>
                    </Show>
                    <RowButton
                      class={`gap-3 hover:bg-accent/60 ${
                        i() === at() ? "bg-accent text-foreground" : "text-foreground/90"
                      }`}
                      active={i() === at()}
                      onMouseEnter={() => setAt(i())}
                      onClick={() => choose(row)}
                    >
                      <span class="min-w-0 flex-1 truncate">{row.kind === "command" ? row.cmd.title() : row.title}</span>
                      <Show when={row.kind === "command" ? row.cmd.chord : undefined}>
                        {(chord) => (
                          <kbd class="shrink-0 font-mono text-2xs text-muted-foreground">{formatChord(chord())}</kbd>
                        )}
                      </Show>
                    </RowButton>
                  </>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
