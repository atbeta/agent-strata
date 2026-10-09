import { createEffect, createSignal, For, on, Show } from "solid-js";
import { realWorkspace, type SessionRow, type StrataEvent } from "./api";
import { t } from "./i18n";
import { Icon } from "./icons";

function projectLabel(path?: string | null): string {
  if (!path) return "";
  if (path === "/" || path === "\\") return t("project.root");
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function eventPreview(e: StrataEvent): string {
  const d = e.data;
  const blocks = (d.content ?? d.output) as unknown;
  if (Array.isArray(blocks))
    return blocks
      .map((b) =>
        typeof b === "object" && b !== null
          ? String((b as { text?: string }).text ?? `[${(b as { type?: string }).type}]`)
          : String(b),
      )
      .join(" ")
      .slice(0, 160);
  if (typeof blocks === "string") return blocks.slice(0, 160);
  if (d.tool) return `${String(d.tool)} ${JSON.stringify(d.input ?? "").slice(0, 80)}`;
  if (d.title) return String(d.title);
  return JSON.stringify(d).slice(0, 160);
}

function shortcutLabel(): string {
  return /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘K" : "Ctrl K";
}

type Hit =
  | { kind: "session"; id: string; title: string; hint: string }
  | { kind: "event"; key: string; sessionId: string; type: string; preview: string; when: string };

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

  const hits = (): Hit[] => {
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
      preview: eventPreview(e),
      when: e.ts.slice(0, 16).replace("T", " "),
    }));
    return [...sessions, ...events];
  };

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
    const list = hits();
    if (e.key === "Escape") {
      e.preventDefault();
      props.onQuery("");
      props.onOpenChange(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (list.length) setCursor((i) => (i + 1) % list.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (list.length) setCursor((i) => (i - 1 + list.length) % list.length);
      return;
    }
    if (e.key === "Enter") {
      const hit = list[cursor()];
      if (!hit) return;
      e.preventDefault();
      go(hit);
    }
  };

  const sessionHits = () =>
    hits().filter((h): h is Extract<Hit, { kind: "session" }> => h.kind === "session");
  const eventHits = () =>
    hits().filter((h): h is Extract<Hit, { kind: "event" }> => h.kind === "event");

  return (
    <>
      <Show when={props.open}>
        <div
          class="fixed inset-0 z-30"
          onMouseDown={() => {
            props.onQuery("");
            props.onOpenChange(false);
          }}
        />
      </Show>
      <div class="relative z-40 px-1.5 pt-2">
        <Show
          when={props.open}
          fallback={
            <button
              type="button"
              class="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              aria-label={t("search.label")}
              onClick={() => props.onOpenChange(true)}
            >
              <Icon name="search" class="size-3.5 shrink-0" />
              <span>{t("search.label")}</span>
              <kbd class="ml-auto font-mono text-2xs text-muted-foreground/80">{shortcutLabel()}</kbd>
            </button>
          }
        >
          <div class="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2">
            <Icon name="search" class="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={input}
              class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder={t("search.placeholder")}
              value={props.query}
              aria-label={t("search.label")}
              onInput={(e) => props.onQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              onMouseDown={(e) => e.stopPropagation()}
            />
            <kbd class="font-mono text-2xs text-muted-foreground">esc</kbd>
          </div>
          <div class="surface-popover absolute top-[calc(100%+4px)] right-1.5 left-1.5 z-40 max-h-80 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground">
              <Show
                when={props.query.trim()}
                fallback={
                  <p class="px-2 py-3 text-xs text-muted-foreground">{t("search.hint")}</p>
                }
              >
                <Show
                  when={hits().length > 0}
                  fallback={
                    <p class="px-2 py-3 text-xs text-muted-foreground">
                      {props.searching ? t("search.searching") : t("search.noMatches")}
                    </p>
                  }
                >
                  <Show when={sessionHits().length > 0}>
                    <p class="px-2 pt-1.5 pb-1 text-2xs font-medium text-muted-foreground">
                      {t("search.results.sessions")}
                    </p>
                    <For each={sessionHits()}>
                      {(hit) => {
                        const index = () => hits().indexOf(hit);
                        return (
                          <button
                            type="button"
                            class={`flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left text-sm ${
                              cursor() === index() ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                            }`}
                            onMouseEnter={() => setCursor(index())}
                            onClick={() => go(hit)}
                          >
                            <span class="min-w-0 flex-1 truncate">{hit.title}</span>
                            <Show when={hit.hint}>
                              <span class="shrink-0 font-mono text-2xs text-muted-foreground">{hit.hint}</span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                  <Show when={eventHits().length > 0}>
                    <p class="px-2 pt-1.5 pb-1 text-2xs font-medium text-muted-foreground">
                      {t("search.results.transcript")}
                    </p>
                    <For each={eventHits()}>
                      {(hit) => {
                        const index = () => hits().indexOf(hit);
                        return (
                          <button
                            type="button"
                            class={`block w-full rounded-sm px-2 py-1.5 text-left ${
                              cursor() === index() ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                            }`}
                            onMouseEnter={() => setCursor(index())}
                            onClick={() => go(hit)}
                          >
                            <span class="flex items-center gap-2 text-2xs">
                              <span class="font-mono text-event-tool">{hit.type}</span>
                              <span class="ml-auto font-mono text-muted-foreground tabular-nums">{hit.when}</span>
                            </span>
                            <span class="mt-0.5 block truncate text-sm">{hit.preview}</span>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </Show>
              </Show>
          </div>
        </Show>
      </div>
    </>
  );
}
