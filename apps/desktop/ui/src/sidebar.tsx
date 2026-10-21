import { createEffect, createMemo, For, onCleanup, Show, createSignal } from "solid-js";
import {
  archiveSession,
  backendLabel,
  renameSession,
  type SessionRow,
  type StrataEvent,
} from "./api";
import { settled } from "./resource";
import { relTime } from "./fleet";
import { t } from "./i18n";
import { displayTitle } from "./session-title";
import { Icon } from "./icons";
import { Tip } from "./tip";
import { openSessionInSplit } from "./session-chrome";
import { hostsTrafficLights, inDesktopShell } from "./shell";
import { sessionStatus } from "./session-status";
import { explain } from "./errors";
import { formatChord } from "./commands";
import type { SessionListCtl, SidebarGroup } from "./use-session-list";
import { ProjectLensMenu } from "./project-lens";
import type { ConnectionsCtl } from "./use-connections";
import { endpointHost, endpointShort, ConnectionsFooter } from "./use-connections";
import { sidebarEmptyKind } from "./connection-status";
import type { WorkspaceCtl } from "./use-workspace";
import { SessionListItem } from "./sidebar-row";
import { ArchivedSection } from "./archived-section";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { SectionHeader } from "@/components/ui/section-header";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TextField, TextFieldInput, TextFieldLabel } from "@/components/ui/text-field";
import { cn } from "./lib/utils";

/** The search field's wiring lives in App; the sidebar only draws it. */
export type SidebarSearch = {
  open: boolean;
  query: string;
  events: StrataEvent[] | undefined;
  searching: boolean;
  onOpenChange: (open: boolean) => void;
  onQuery: (q: string) => void;
  onOpenSession: (id: string) => void;
};

/**
 * The whole left rail: search + new session, the project picker, the fleet
 * row, the grouped session list, and the connections
 * footer. State lives in the `list`/`ws`/`conns` hooks; this only composes
 * and wires them to rows.
 */
export function Sidebar(props: {
  list: SessionListCtl;
  ws: WorkspaceCtl;
  conns: ConnectionsCtl;
  onOpenSearch: () => void;
  fleetActive: boolean;
  compareOn: boolean;
  compareSel: string[];
  onStartCompare: (id?: string) => void;
  onCancelCompare: () => void;
  onOpenCompare: () => void;
  activeId: () => string | undefined;
  clock: () => number;
  onOpenSession: (id: string) => void;
  onNewSession: (dir?: string) => void;
  onOpenFleet: () => void;
  /** Set briefly to aim the list at a project group — uncollapse it and
      scroll it into view, then cleared. The overview's project rows use it. */
  focusDir?: () => string | undefined;
  clearFocusDir?: () => void;
}) {
  const list = () => props.list;

  /**
   * The connection ids the sidebar's sessions are actually spread across.
   *
   * A session carries a `backend`, but that names the kind and never the
   * server, so nothing on the row says which instance produced it. Naming it
   * is only worth the row width when the list is genuinely split: two
   * OpenCodes over one agent's session store hold the same sessions, and which
   * of them owns a given one is arbitrary, so the badge would repeat a single
   * answer down the whole list. A session no connected backend owns counts as
   * its own bucket, because that is the other case where the rows are not
   * interchangeable.
   */
  const splitInstances = createMemo(() => {
    const ids = new Set<string>();
    for (const g of list().groups()) for (const s of g.rows) ids.add(s.connection_id ?? "");
    return ids;
  });

  /**
   * Whether the `port` badge on a row is worth showing, held still for a beat.
   *
   * A sync briefly leaves some rows without their connection id and fills it in
   * on the next pass. Reading that directly made the badge appear and disappear
   * down the whole list — a flicker with no meaning behind it. The split has to
   * stay true for long enough to be a state rather than a frame.
   */
  const [splitSettled, setSplitSettled] = createSignal(false);
  createEffect(() => {
    const multiple = props.conns.phase() === "connected" && splitInstances().size >= 2;
    const timer = setTimeout(() => setSplitSettled(multiple), 600);
    onCleanup(() => clearTimeout(timer));
  });

  // The last badge a row had. A sync briefly drops `connection_id` from some
  // rows; without this the badge under that row vanished for a frame even
  // though the session had not moved.
  const lastInstance = new Map<string, { short: string; tip: string }>();
  const instanceOf = (s: SessionRow) => {
    if (!splitSettled()) return undefined;
    const c = s.connection_id
      ? (settled(props.conns.conns)?.connections ?? []).find((x) => x.id === s.connection_id)
      : undefined;
    if (!c) return lastInstance.get(s.summary.session_id);
    const badge = {
      short: endpointShort(c.baseUrl),
      tip: `${backendLabel(c.backend)} · ${endpointHost(c.baseUrl)}`,
    };
    lastInstance.set(s.summary.session_id, badge);
    return badge;
  };

  /**
   * Per-group visibility. `collapsed` hides a group entirely behind its
   * header; `expanded` opens a long one past the first page of rows. Both are
   * keyed by group key so a poll that rebuilds the groups keeps the reader's
   * folds. Neither is persisted — they answer "what am I looking at right
   * now", and a fold that survives restarts would hide sessions the reader
   * forgot they tucked away.
   */
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const flip = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  /** Rows offered before a long group asks for the rest. */
  const PAGE = 10;

  createEffect(() => {
    const dir = props.focusDir?.();
    if (!dir) return;
    setCollapsed((s) => {
      if (!s.has(dir)) return s;
      const next = new Set(s);
      next.delete(dir);
      return next;
    });
    props.clearFocusDir?.();
    // After the uncollapse settles, not before — the group may not be in the
    // DOM on the frame the effect runs.
    requestAnimationFrame(() => {
      document.querySelector(`[data-group="${CSS.escape(dir)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  });

  /** Pinned and waiting are lanes; projects and days are places. The label
      row and its "+" sit between them. */
  const metaGroups = () => list().groups().filter((g) => g.key.startsWith("__"));
  const sectionGroups = () => list().groups().filter((g) => !g.key.startsWith("__"));
  /**
   * Sections and rows are rendered by key, not by object. `holdRows` keeps a
   * row's object only while its value is unchanged, and a running session
   * changes on every event: by object, its row — and its whole section, whose
   * rows array no longer matched — was torn down several times a second. That
   * read as flicker, and a press that went down on one node and came up on its
   * replacement never became a click, so a busy session could not be opened.
   */
  const metaKeys = () => metaGroups().map((g) => g.key);
  const sectionKeys = () => sectionGroups().map((g) => g.key);
  const groupsByKey = createMemo(() => new Map(list().groups().map((g) => [g.key, g])));

  /** What the section is called: the places, or the days they are cut by. */
  const sectionLabel = () =>
    list().lens().groupBy === "day" ? t("sidebar.recent") : t("sidebar.projects");

  const renderGroup = (key: string) => {
    // The last known shape outlives the key by the frame `<For>` takes to
    // dispose a section that just left.
    const group = createMemo<SidebarGroup>((prev) => groupsByKey().get(key) ?? prev!);
    const byId = createMemo(() => new Map(group().rows.map((s) => [s.summary.session_id, s])));
    const rowIds = () =>
      (expanded().has(key) ? group().rows : group().rows.slice(0, PAGE)).map(
        (s) => s.summary.session_id,
      );
    return (
      <section
        data-group={key}
        class={cn("group/section", collapsed().has(key) ? "mb-0" : "mb-2")}
      >
        <SectionHeader
          label={group().label}
          count={group().rows.length > 0 || group().dir === undefined ? group().rows.length : undefined}
          hint={group().hint}
          title={group().title}
          icon={group().dir !== undefined ? (collapsed().has(key) ? "folder" : "folder-open") : undefined}
          chevron={group().dir === undefined}
          open={!collapsed().has(key)}
          onToggle={() => setCollapsed((s) => flip(s, key))}
          action={
            group().dir !== undefined ? (
              <Tip label={t("action.newSession")}>
                {/* Revealed on section hover — one "+" per project, always on,
                    would be a rail of pluses down the rail. An empty project
                    keeps it visible, one step quieter, since a run of empty
                    projects would otherwise be that rail again. */}
                <Button
                  variant="quiet"
                  size="icon-2xs"
                  class={cn(
                    "size-4 shrink-0 transition-opacity hover:text-foreground focus-visible:opacity-100",
                    group().rows.length === 0
                      ? "text-muted-foreground/35 group-hover/section:text-muted-foreground"
                      : "text-muted-foreground/60 opacity-0 group-hover/section:opacity-100",
                  )}
                  aria-label={t("action.newSession")}
                  onClick={() => props.onNewSession(group().dir)}
                >
                  <Icon name="plus" class="size-2.5" />
                </Button>
              </Tip>
            ) : undefined
          }
        />
        <Show when={!collapsed().has(key)}>
          <For each={rowIds()}>
            {(id) => {
              const s = createMemo<SessionRow>((prev) => byId().get(id) ?? prev!);
              return (
                <SessionListItem
                  id={id}
                  title={displayTitle(s().title ?? s().summary.title) ?? t("common.untitled")}
                  active={props.activeId() === id || props.compareSel.includes(id)}
                  status={sessionStatus(s())}
                  time={relTime(s().summary.last_ts, props.clock())}
                  actions={!props.compareOn}
                  onOpen={() => props.onOpenSession(id)}
                  onRename={(title) => list().runAction(id, () => renameSession(id, title), false)}
                  onArchive={() => list().runAction(id, () => archiveSession(id), true)}
                  pinned={list().pins().includes(id)}
                  onTogglePin={() => list().togglePinned(id)}
                  onCompare={() => props.onStartCompare(id)}
                  onSplitOpen={() => openSessionInSplit(id, "row")}
                  instance={instanceOf(s())}
                />
              );
            }}
          </For>
          <Show when={!expanded().has(key) && group().rows.length > PAGE}>
            <RowButton
              class="h-7 items-center px-2 text-2xs text-muted-foreground hover:bg-accent/70"
              onClick={() => setExpanded((s) => flip(s, key))}
            >
              <Icon name="chevron" class="size-2.5 rotate-90 text-muted-foreground/60" />
              {t("sidebar.group.more", { n: group().rows.length - PAGE })}
            </RowButton>
          </Show>
        </Show>
      </section>
    );
  };

  return (
    <aside class="flex w-[300px] shrink-0 flex-col border-r border-border bg-sidebar">
      {/* macOS hides its title bar and paints the traffic lights over the
          webview's top-left — this corner of the sidebar is where they land,
          so the column gives them the 32px they sit in and the spot doubles
          as drag space. Every other platform's shell keeps its own chrome
          and the column starts at the window edge. */}
      <Show when={hostsTrafficLights()}>
        <div class="h-8 shrink-0 select-none" data-tauri-drag-region="" />
      </Show>
      {/* The old header was a full row whose only content was a plus pushed
          to the right, so the corner under the wordmark was a blank band.
          New sessions now start from a project group's "+", which also says
          where the session will live — the search row keeps the width. */}
      {/* One panel now, so this row opens it. It stays because the shortcut is
          written on it and nowhere else — removing the row to reach for the
          keyboard would take away how anyone finds the thing that finds
          everything else. */}
      {/* Search and the overview are the two places the rail goes that are
          not a session, so they sit together as one block with one style.
          A rule between them made the overview a section of one row. */}
      <nav class="flex flex-col gap-px px-1.5 pt-2 pb-1">
        <RowButton
          class="h-8 items-center px-2 text-foreground/80 hover:bg-accent/70"
          aria-label={t("palette.title")}
          onClick={props.onOpenSearch}
        >
          <Icon name="search" class="size-3.5 shrink-0 text-muted-foreground" />
          <span>{t("search.label")}</span>
          {/* Spelled by the same function as the command panel, so the row and
              the panel it opens never disagree about what the keys are. */}
          <kbd class="ml-auto font-sans text-2xs text-muted-foreground/80">
            {formatChord({ key: "k" })}
          </kbd>
        </RowButton>
        <RowButton
          class={cn(
            "h-8 items-center px-2",
            props.fleetActive
              ? "bg-accent text-foreground"
              : "text-foreground/80 hover:bg-accent/70",
          )}
          aria-current={props.fleetActive ? "page" : undefined}
          onClick={() => props.onOpenFleet()}
        >
          <Icon name="list" class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="truncate">{t("fleet.nav")}</span>
        </RowButton>
      </nav>
      <Show when={list().actionErr()}>
        <p class="truncate px-3 pb-1.5 font-mono text-2xs text-destructive" title={list().actionErr()}>
          {list().actionErr()}
        </p>
      </Show>
      <div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4 pt-1 [mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent)]">
        <ArchivedSection list={props.list} now={props.clock} onOpen={props.onOpenSession} />
        {/* Compare is a mode of the list and it says so at the top of the
            list. The hint used to live inside the connect panel, so entering
            compare mode from anywhere else showed nothing at all: the rows
            simply stopped opening, with no sign of what had changed. */}
        <Show when={props.compareOn}>
          <div class="mb-1.5 flex items-center gap-2 rounded-md bg-secondary/40 px-2 py-1.5">
            <Icon name="columns" class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 text-2xs text-muted-foreground">
              {props.compareSel.length < 2
                ? t("sidebar.compare.pick", { n: 2 - props.compareSel.length })
                : t("sidebar.compare.openTip")}
            </span>
            <Button
              type="button"
              variant="quiet"
              size="xs"
              class="shrink-0"
              onClick={() => props.onCancelCompare()}
            >
              {t("sidebar.compare.cancel")}
            </Button>
          </div>
        </Show>
        <For each={metaKeys()}>{renderGroup}</For>
        <div class="mb-0.5 flex items-center justify-between px-2 pb-0.5 pt-2.5">
          <span class="text-xs font-medium text-muted-foreground">{sectionLabel()}</span>
          <div class="flex items-center gap-0.5">
            {/* The lens on this section, and the directory that adds to it.
                Both are about which projects are here, so they sit together. */}
            <ProjectLensMenu list={props.list} />
            {/* Open a directory that has no sessions yet — the one place a
              project the list does not already know can enter it. In the
              desktop shell the button goes straight to the native picker; a
              browser tab can't reach it, so it falls back to a typed path. */}
            <Show
              when={inDesktopShell()}
              fallback={
                <DropdownMenu
                  open={props.ws.dirOpen()}
                  onOpenChange={props.ws.setDirOpen}
                  gutter={4}
                  placement="bottom-end"
                >
                  <Tip label={t("sidebar.project.openDirectory")}>
                    <DropdownMenuTrigger class="grid size-5 place-items-center rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                      <Icon name="folder-plus" class="size-3.5" />
                    </DropdownMenuTrigger>
                  </Tip>
                  <DropdownMenuContent class="w-[276px]">
                    <form
                      class="px-2 py-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        props.ws.addDir(props.ws.dirDraft());
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <TextField>
                        <TextFieldLabel class="text-2xs font-medium text-muted-foreground">
                          {t("sidebar.project.openDirectory")}
                        </TextFieldLabel>
                        <TextFieldInput
                          size="sm"
                          mono
                          value={props.ws.dirDraft()}
                          onInput={(e) => props.ws.setDirDraft(e.currentTarget.value)}
                          class="bg-background text-2xs"
                          placeholder="/path/to/project"
                          onKeyDown={(e) => e.stopPropagation()}
                        />
                      </TextField>
                    </form>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            >
              <Tip label={t("sidebar.project.openDirectory")}>
                <Button
                  variant="icon"
                  size="icon-2xs"
                  class="text-muted-foreground/60"
                  onClick={() => void props.ws.pickDir()}
                >
                  <Icon name="folder-plus" class="size-3.5" />
                </Button>
              </Tip>
            </Show>
          </div>
        </div>
        <Show
          when={sectionGroups().length > 0}
          fallback={
            <Show
              when={list().lensActive()}
              fallback={
                <Show when={metaGroups().length === 0}>
                  {(() => {
                    const kind = sidebarEmptyKind({
                      phase: props.conns.phase(),
                      listSettled: settled(list().data) !== undefined,
                      listError: Boolean(list().data.error),
                    });
                    if (kind === "hidden") return null;
                    const danger = kind === "listError" || kind === "failed" || kind === "unreachable";
                    const title =
                      kind === "listError"
                        ? explain(list().data.error)
                        : kind === "connecting"
                          ? t("sidebar.backend.connecting")
                          : kind === "failed"
                            ? t("sidebar.backend.failed")
                            : kind === "missing"
                              ? t("sidebar.backend.missing")
                              : kind === "unreachable"
                                ? t("error.serviceUnreachable")
                                : kind === "needBackend"
                                  ? t("sidebar.empty.needBackend")
                                  : t("sidebar.empty.none");
                    return (
                      <EmptyState
                        icon={danger ? "alert" : kind === "connecting" ? "plug" : "list"}
                        tone={danger ? "danger" : "neutral"}
                        class="px-4 py-10"
                        title={title}
                        action={
                          kind === "none" ? (
                            <Button size="sm" variant="quiet" onClick={() => props.onNewSession()}>
                              {t("action.newSession")}
                            </Button>
                          ) : undefined
                        }
                      />
                    );
                  })()}
                </Show>
              }
            >
              {/* The projects are there; the lens is what is not letting them
                  through. Saying "no sessions" here would be a lie about the
                  list, so the sentence names the lens and offers the way out.
                  With lanes above it, the sentence stays quiet — the lanes
                  are the list, and this is only a note under them. */}
              <EmptyState
                icon={metaGroups().length > 0 ? undefined : "sliders"}
                layout={metaGroups().length > 0 ? "inline" : "panel"}
                tone="neutral"
                class={metaGroups().length > 0 ? "px-2 py-3" : "px-4 py-10"}
                title={
                  list().lens().groupBy === "day"
                    ? t("sidebar.recent.empty")
                    : t("sidebar.project.filter.noMatch")
                }
                action={
                  <Button size="sm" variant="quiet" onClick={() => list().clearLens()}>
                    {t("sidebar.project.filter.reset")}
                  </Button>
                }
              />
            </Show>
          }
        >
          <For each={sectionKeys()}>{renderGroup}</For>
          <Show when={list().more()}>
            <div class="px-2 pb-2 pt-1">
              <Button
                size="xs"
                variant="quiet"
                class="w-full justify-center"
                onClick={() => list().loadMore()}
              >
                {t("sidebar.more")}
              </Button>
            </div>
          </Show>
        </Show>
      </div>
      <ConnectionsFooter
        conns={props.conns}
        compareReady={props.compareSel.length === 2}
        onCompareOpen={props.onOpenCompare}
      />
    </aside>
  );
}
