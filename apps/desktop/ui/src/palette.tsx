import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import {
  actionable,
  actionableIndexAt,
  buildPanelHits,
  type PanelHit,
} from "./command-panel-hits";
import { commandGroup, commandList, formatChord, GROUP_ORDER } from "./commands";
import { t } from "./i18n";
import { RowButton } from "@/components/ui/row-button";
import { CommandDialog } from "@/components/ui/command-dialog";
import { TextFieldInput } from "@/components/ui/text-field";

const GROUP_LABEL: Record<string, () => string> = {
  app: () => t("palette.group.app"),
  session: () => t("palette.group.session"),
  pane: () => t("palette.group.pane"),
  sessions: () => t("palette.group.sessions"),
  transcript: () => t("palette.group.transcript"),
  command: () => t("palette.group.command"),
};

type SessionHit = Extract<PanelHit, { kind: "session" }>;
type TranscriptHit = Extract<PanelHit, { kind: "event" }>;

/**
 * A session or a command: one line, a title, and whatever else it wears.
 *
 * Two components rather than one with a `kind` test inside, because the row is
 * a union of three and Solid's `<Show>` narrows only to "not this one". The
 * discriminant has to reach the member access somewhere, and here is where.
 */
function TitledRow(props: {
  row: Extract<PanelHit, { kind: "command" }> | SessionHit;
}) {
  return (
    <>
      <span class="min-w-0 flex-1 truncate">
        {props.row.kind === "command" ? props.row.cmd.title() : props.row.title}
      </span>
      <Show when={props.row.kind === "session" && props.row.hint}>
        {(hint) => (
          <span class="shrink-0 font-mono text-2xs text-muted-foreground">{hint()}</span>
        )}
      </Show>
      <Show when={props.row.kind === "command" ? props.row.cmd.chord : undefined}>
        {(chord) => (
          <kbd class="shrink-0 font-sans text-2xs text-muted-foreground">
            {formatChord(chord())}
          </kbd>
        )}
      </Show>
    </>
  );
}

/**
 * A line inside a conversation.
 *
 * Two lines, because this is the reason the panel is wide: what the line said,
 * not where to look for it. The mark is a neutral wash rather than accent,
 * which DESIGN.md keeps for primary actions.
 */
function TranscriptRow(props: { hit: TranscriptHit }) {
  return (
    <span class="block w-full text-left">
      <span class="flex items-center gap-2 text-2xs">
        <span class="font-mono text-event-tool">{props.hit.type}</span>
        <span class="ml-auto font-mono text-muted-foreground tabular-nums">
          {props.hit.when}
        </span>
      </span>
      <span class="mt-0.5 line-clamp-2 text-sm leading-snug">
        {props.hit.preview.lead}
        <Show when={props.hit.preview.match}>
          {(m) => (
            <mark class="rounded-sm bg-foreground/15 px-0.5 text-foreground">{m()}</mark>
          )}
        </Show>
        {props.hit.preview.rest}
      </span>
    </span>
  );
}

function PaletteItem(props: {
  row: Exclude<PanelHit, { kind: "heading" }>;
  selected: boolean;
  onSelect: () => void;
  onChoose: () => void;
}) {
  return (
    <RowButton
      class={`gap-3 hover:bg-accent/60 ${
        props.selected ? "bg-accent text-foreground" : "text-foreground/90"
      }`}
      active={props.selected}
      onMouseEnter={props.onSelect}
      onClick={props.onChoose}
    >
      <Show
        when={props.row.kind === "event" ? props.row : undefined}
        fallback={<TitledRow row={props.row as Extract<PanelHit, { kind: "command" }> | SessionHit} />}
      >
        {(hit) => <TranscriptRow hit={hit()} />}
      </Show>
    </RowButton>
  );
}

/**
 * The one place you look things up.
 *
 * It was two. `Ctrl K` searched sessions and transcript; `Ctrl Shift P` listed
 * commands. Both were a centred dialog with an input and a list, and both could
 * find a session — so half the time you opened the one you did not mean, and
 * the other half you did not know the other existed.
 *
 * Now a word goes in and all three answer: the commands, the sessions, and the
 * lines inside them. Which kind you land on is the panel's problem, not
 * something to guess before typing.
 */
export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  /**
   * Lifted to whoever owns the service call.
   *
   * Transcript search is not a filter over what the panel already holds: it is
   * `/events?text=…` against the whole store, and only the owner of that
   * resource knows when the answer is in. Held here instead, it became a query
   * nobody ever set — the panel went on searching titles while the full-text
   * request it should have been making never fired.
   */
  query: string;
  onQuery: (query: string) => void;
  sessions: { id: string; title: string; workspace?: string | null; summary?: { title?: string | null; workspace?: string | null } }[];
  events?: readonly { id: string; session_id: string; type: string; ts: string; data: Record<string, unknown> }[];
  searching?: boolean;
  onOpenSession: (id: string) => void;
  /** transcript hits carry the query that found them; the session opens its search */
  onOpenHit?: (sessionId: string, query: string) => void;
}) {
  const [at, setAt] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;

  const query = () => props.query;

  const hits = createMemo(() =>
    buildPanelHits({
      query: query(),
      commands: commandList(),
      sessions: props.sessions as never,
      events: props.events as never,
      label: (g) => GROUP_LABEL[g]?.() ?? g,
      commandGroupLabel: (id) => commandGroupLabel(id),
    }),
  );

  const choose = (row: PanelHit | undefined) => {
    if (!row || row.kind === "heading") return;
    // `onClose` resets the owner's query, so the hit's query is read first.
    const q = query();
    props.onClose();
    if (row.kind === "command") row.cmd.run();
    else if (row.kind === "session") props.onOpenSession(row.id);
    else props.onOpenHit?.(row.sessionId, q);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const all = actionable(hits());
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

  createEffect(() => {
    if (!props.open) return;
    props.onQuery("");
    setAt(0);
    queueMicrotask(() => input?.focus());
  });

  return (
    <CommandDialog open={props.open} label={t("palette.title")} onClose={props.onClose}>
      <TextFieldInput
        ref={input}
        bare
        class="h-11 px-3"
        placeholder={t("palette.placeholder")}
        aria-label={t("palette.title")}
        value={query()}
        onInput={(e) => {
          props.onQuery(e.currentTarget.value);
          setAt(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div ref={list} class="max-h-80 overflow-y-auto border-t border-border p-1">
        <Show
          when={hits().length > 0}
          fallback={
            <p class="px-2 py-6 text-center text-sm text-muted-foreground">
              {props.searching ? t("search.searching") : t("palette.empty")}
            </p>
          }
        >
          <For each={hits()}>
            {(row, i) => (
              <Switch>
                <Match when={row.kind === "heading" && row}>
                  {(h) => (
                    <p
                      class={`px-2 pb-1 text-2xs font-medium text-muted-foreground ${
                        i() === 0 ? "pt-1.5" : "pt-3"
                      }`}
                    >
                      {h().label}
                    </p>
                  )}
                </Match>
                <Match when={row.kind !== "heading" && row}>
                  {(r) => (
                    <PaletteItem
                      row={r()}
                      selected={actionableIndexAt(hits(), i()) === at()}
                      onSelect={() => setAt(actionableIndexAt(hits(), i()))}
                      onChoose={() => choose(r())}
                    />
                  )}
                </Match>
              </Switch>
            )}
          </For>
        </Show>
      </div>
    </CommandDialog>
  );
}

/** The subgroup a command's id names: `app.`, `session.`, `pane.`, or neither. */
function commandGroupLabel(id: string): string {
  return (commandGroup({ id, title: () => "", run: () => {} }) as string | undefined) ?? "command";
}
