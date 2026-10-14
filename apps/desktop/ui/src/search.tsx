import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { realWorkspace, type SessionRow, type StrataEvent } from "./api";
import { t } from "./i18n";
import { Icon } from "./icons";
import { eventText, previewWindow, type PreviewWindow } from "./search-format";

function projectLabel(path?: string | null): string {
  if (!path) return "";
  if (path === "/" || path === "\\") return t("project.root");
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function shortcutLabel(): string {
  return /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘K" : "Ctrl K";
}

type Hit =
  | { kind: "session"; id: string; title: string; hint: string }
  | { kind: "event"; key: string; sessionId: string; type: string; preview: PreviewWindow; when: string };

export function CommandSearch(props: {
  open: boolean;
  query: string;
  sessions: SessionRow[];
  events: StrataEvent[] | undefined;
  searching: boolean;
  onOpenChange: (open: boolean) => void;
  onQuery: (query: string) => void;
  onOpenSession: (id: string) => void;
}) {
  const [cursor, setCursor] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let listBox: HTMLDivElement | undefined;

  /**
   * One list, built once per change, so every reader of it sees the same
   * objects.
   *
   * It used to be a plain function called four times per render, rebuilding
   * every Hit each time — which quietly broke the two halves of this list that
   * have to agree: the row's `hits().indexOf(hit)` looked itself up in a fresh
   * array of fresh objects and so always came back -1. No row ever lit up for
   * the keyboard, and moving the pointer over one set the cursor to -1, after
   * which Enter read `list[-1]`, found nothing, and did nothing.
   */
  const hits = createMemo((): Hit[] => {
    const q = props.query.trim().toLowerCase();
    if (!q) return [];
    const sessions: Hit[] = props.sessions
      .filter((s) => {
        const title = (s.title ?? s.summary.title ?? s.summary.session_id).toLowerCase();
        const ws = (realWorkspace(s.workspace ?? s.summary.workspace) ?? "").toLowerCase();
        return title.includes(q) || ws.includes(q);
      })
      .slice(0, 8)
      .map((s) => ({
        kind: "session" as const,
        id: s.summary.session_id,
        title: s.title ?? s.summary.title ?? t("common.untitled"),
        hint: projectLabel(realWorkspace(s.workspace ?? s.summary.workspace)),
      }));
    const events: Hit[] = (props.events ?? []).slice(0, 12).map((e) => ({
      kind: "event" as const,
      key: e.id,
      sessionId: e.session_id,
      type: e.type,
      preview: previewWindow(eventText(e), q),
      when: e.ts.slice(0, 16).replace("T", " "),
    }));
    return [...sessions, ...events];
  });

  createEffect(
    on(
      () => props.query,
      () => setCursor(0),
    ),
  );

  createEffect(() => {
    if (!props.open) return;
    queueMicrotask(() => input?.focus());
  });

  const go = (hit: Hit) => {
    props.onOpenSession(hit.kind === "session" ? hit.id : hit.sessionId);
    props.onQuery("");
    props.onOpenChange(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const all = hits();
    if (e.key === "Escape") {
      e.preventDefault();
      props.onQuery("");
      props.onOpenChange(false);
      return;
    }
    if (e.key === "ArrowDown" && all.length) {
      e.preventDefault();
      setCursor((i) => (i + 1) % all.length);
    } else if (e.key === "ArrowUp" && all.length) {
      e.preventDefault();
      setCursor((i) => (i - 1 + all.length) % all.length);
    } else if (e.key === "Enter") {
      const hit = all[cursor()];
      if (!hit) return;
      e.preventDefault();
      go(hit);
      return;
    }
    // The list is taller than the box, so the keyboard has to bring the row it
    // is on into view — the pointer never needed to, being handed the row it
    // was already pointing at.
    queueMicrotask(() =>
      listBox?.querySelector('[data-at="true"]')?.scrollIntoView({ block: "nearest" }),
    );
  };

  const sessionHits = createMemo(() =>
    hits().filter((h): h is Extract<Hit, { kind: "session" }> => h.kind === "session"),
  );
  const eventHits = createMemo(() =>
    hits().filter((h): h is Extract<Hit, { kind: "event" }> => h.kind === "event"),
  );

  return (
    <>
      {/* The row stays put in both states. It is the only place the shortcut is
          written down, so removing it to open the search would take away how
          anyone finds it — and it would shove every project below it up by one
          row while the overlay was up. */}
      <div class="px-1.5 pt-2">
        <button
          type="button"
          class={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors ${
            props.open
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground"
          }`}
          aria-label={t("search.label")}
          onClick={() => props.onOpenChange(true)}
        >
          <Icon name="search" class="size-3.5 shrink-0" />
          <span>{t("search.label")}</span>
          <kbd class="ml-auto font-mono text-2xs text-muted-foreground/80">{shortcutLabel()}</kbd>
        </button>
      </div>

      {/* Centred because it was never a dropdown. It already dimmed the whole
          window, swallowed Esc and click-away, and captured the arrow keys —
          the results just happened to be painted into a 300px sidebar, where a
          160-character transcript line survived about twenty characters of it.
          The chrome is the command palette's, deliberately: two overlays that
          behave identically should look identical. */}
      <Show when={props.open}>
        <div
          class="fixed inset-0 z-50 flex items-start justify-center bg-background/50 pt-[15vh]"
          onMouseDown={() => {
            props.onQuery("");
            props.onOpenChange(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("search.label")}
            class="w-[32rem] max-w-[calc(100%-2rem)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              ref={input}
              class="h-11 w-full bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder={t("search.placeholder")}
              aria-label={t("search.label")}
              value={props.query}
              onInput={(e) => props.onQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <div ref={listBox} class="max-h-80 overflow-y-auto border-t border-border p-1">
              <Show
                when={props.query.trim()}
                fallback={<p class="px-2 py-6 text-sm text-muted-foreground">{t("search.hint")}</p>}
              >
                <Show
                  when={hits().length > 0}
                  fallback={
                    <p class="px-2 py-6 text-sm text-muted-foreground">
                      {props.searching ? t("search.searching") : t("search.noMatches")}
                    </p>
                  }
                >
                  <Show when={sessionHits().length > 0}>
                    <p class="px-2 pt-2 pb-1 text-2xs font-medium text-muted-foreground">
                      {t("search.results.sessions")}
                    </p>
                    <For each={sessionHits()}>
                      {(hit) => {
                        const index = () => hits().indexOf(hit);
                        return (
                          <button
                            type="button"
                            data-at={cursor() === index() ? "true" : "false"}
                            class={`flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left text-sm ${
                              cursor() === index()
                                ? "bg-accent text-accent-foreground"
                                : "hover:bg-accent/60"
                            }`}
                            onMouseEnter={() => setCursor(index())}
                            onClick={() => go(hit)}
                          >
                            <span class="min-w-0 flex-1 truncate">{hit.title}</span>
                            <Show when={hit.hint}>
                              <span class="shrink-0 font-mono text-2xs text-muted-foreground">
                                {hit.hint}
                              </span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                  <Show when={eventHits().length > 0}>
                    <p class="px-2 pt-2 pb-1 text-2xs font-medium text-muted-foreground">
                      {t("search.results.transcript")}
                    </p>
                    <For each={eventHits()}>
                      {(hit) => {
                        const index = () => hits().indexOf(hit);
                        return (
                          <button
                            type="button"
                            data-at={cursor() === index() ? "true" : "false"}
                            class={`block w-full rounded-md px-2 py-1.5 text-left ${
                              cursor() === index()
                                ? "bg-accent text-accent-foreground"
                                : "hover:bg-accent/60"
                            }`}
                            onMouseEnter={() => setCursor(index())}
                            onClick={() => go(hit)}
                          >
                            <span class="flex items-center gap-2 text-2xs">
                              <span class="font-mono text-event-tool">{hit.type}</span>
                              <span class="ml-auto font-mono text-muted-foreground tabular-nums">
                                {hit.when}
                              </span>
                            </span>
                            {/* Two lines, because this is the reason the panel is
                                wide: what the line said, not where to look for
                                it — which is also why the window opens on the
                                match. The mark is a neutral wash rather than
                                accent, which DESIGN.md keeps for primary
                                actions. */}
                            <span class="mt-0.5 line-clamp-2 text-sm leading-snug">
                              {hit.preview.lead}
                              <Show when={hit.preview.match}>
                                <mark class="rounded-sm bg-foreground/15 px-0.5 text-foreground">
                                  {hit.preview.match}
                                </mark>
                              </Show>
                              {hit.preview.rest}
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </>
  );
}
