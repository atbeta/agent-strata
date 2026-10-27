import { createEffect, createMemo, For, onCleanup, Show, createSignal } from "solid-js";
import {
  archiveSession,
  backendLabel,
  renameSession,
  type SessionRow,
  type StrataEvent,
} from "./api";
import { settled } from "./resource";
import { fleetStatus, relTime } from "./fleet";
import { t } from "./i18n";
import { displayTitle } from "./session-title";
import { Icon, type Name as IconName } from "./icons";
import { Tip } from "./tip";
import { openSessionInSplit } from "./session-chrome";
import { hostsTrafficLights, inDesktopShell, usesCustomCaption } from "./shell";
import { sessionStatus } from "./session-status";
import { explain } from "./errors";
import { TopLeftControls } from "./chrome";
import type { SessionListCtl, SidebarGroup } from "./use-session-list";
import { ProjectLensMenu } from "./project-lens";
import type { StatusLens } from "./project-view";
import { needsProjectView } from "./project-view";
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
 * A count of the sessions that want something from the reader.
 *
 * The number comes from the whole list, not from what the list is showing: a
 * filter that happens to be on must not be able to make the answer to "is
 * anything waiting for me" read as zero. The row is that filter — it cuts the
 * list by status, and pressing it again lets the list go back to everything.
 *
 * A row with nothing behind it stays on screen and goes quiet. A count that
 * comes and goes is not a place; a count that says zero is an answer.
 */
function StatusRow(props: {
  label: string;
  count: number;
  icon: IconName;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <RowButton
      class={cn(
        "h-8 items-center gap-2 px-2",
        props.active
          ? "bg-accent text-foreground hover:bg-accent"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        props.count === 0 && !props.active ? "opacity-60" : "",
      )}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      <Icon name={props.icon} class="size-3.5 shrink-0" />
      <span class="truncate">{props.label}</span>
      <span class="ml-auto shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/70">
        {props.count}
      </span>
    </RowButton>
  );
}

/**
 * The whole left rail: the window's own views, the project picker, the fleet
 * row, the grouped session list, and the connections
 * footer. State lives in the `list`/`ws`/`conns` hooks; this only composes
 * and wires them to rows.
 */
export function Sidebar(props: {
  list: SessionListCtl;
  ws: WorkspaceCtl;
  conns: ConnectionsCtl;
  /** The window's own switches, drawn in the corner that owns them. */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
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
   * The counts the window's own views answer with.
   *
   * Taken from the whole library rather than from the filtered list: these
   * numbers say what is happening in the fleet, and a filter must not be able
   * to change the answer to that.
   */
  const counts = createMemo(() => fleetStatus(list().sessions()));
  const waitingCount = () => counts().waiting.length;
  const runningCount = () => counts().running.length;

  /** The status cut the list by; pressing the row again takes it off. */
  const toggleStatus = (status: StatusLens) => () => {
    const lens = list().lens();
    list().setStatus(lens.status === status ? "all" : status);
  };

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

  /**
   * A directory is a place, so opening one brings the places back into view.
   *
   * The date view cuts the list by when each session last ran: it has no group
   * for a folder and no per-project "+" to start work from, so a directory
   * added there had nowhere to appear and the button read as doing nothing.
   * Done once here rather than at each call site, so the typed path and the
   * native picker cannot drift apart.
   */
  const afterOpeningDirectory = () => {
    if (needsProjectView(list().lens())) list().setGroupBy("project");
  };

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
                  shell={s().shell}
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
      {/* The window's top-left corner. macOS hides its title bar and paints
          the traffic lights over the webview's top-left, so this band keeps
          their space clear and puts the window's switches beside them; on the
          shells that draw no caption of their own the band is where those
          switches live. Windows draws its own caption strip above this column
          and keeps them there. */}
      <Show when={!usesCustomCaption()}>
        <div
          class={cn(
            "flex h-9 shrink-0 items-center gap-0.5 select-none",
            hostsTrafficLights() ? "pl-[76px]" : "pl-2",
          )}
          data-tauri-drag-region={inDesktopShell() ? "" : undefined}
        >
          <TopLeftControls
            sidebarOpen={props.sidebarOpen}
            onToggleSidebar={props.onToggleSidebar}
            onOpenPalette={props.onOpenPalette}
          />
        </div>
      </Show>
      {/* The window's own views.
          They sit above the list because they are about the list: the overview
          is the fleet page, and the two counts answer what the list itself
          cannot — whether something is waiting on a person, and what is still
          working. A rule closes the block, so the views read as a block and the
          sessions below read as another thing. */}
      <nav class="flex flex-col gap-px border-b border-border px-1.5 pt-2 pb-1.5">
        <div class="flex items-center gap-1">
          <RowButton
            class={cn(
              "h-8 min-w-0 flex-1 items-center px-2",
              props.fleetActive
                ? "bg-accent text-foreground hover:bg-accent"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            aria-current={props.fleetActive ? "page" : undefined}
            onClick={() => props.onOpenFleet()}
          >
            <Icon name="list" class="size-3.5 shrink-0" />
            <span class="truncate">{t("fleet.nav")}</span>
          </RowButton>
          {/* A new session belongs to wherever the reader is standing, and the
              reader is standing in the list. This is the one place that says so
              without asking which project first. */}
          <Tip label={t("action.newSession")}>
            <Button
              type="button"
              variant="icon"
              size="icon-sm"
              aria-label={t("action.newSession")}
              onClick={() => props.onNewSession()}
            >
              <Icon name="plus" class="size-4" />
            </Button>
          </Tip>
        </div>
        <StatusRow
          label={t("sidebar.status.waiting")}
          count={waitingCount()}
          icon="alert"
          active={list().lens().status === "waiting"}
          onClick={toggleStatus("waiting")}
        />
        <StatusRow
          label={t("sidebar.status.running")}
          count={runningCount()}
          icon="activity"
          active={list().lens().status === "busy"}
          onClick={toggleStatus("busy")}
        />
      </nav>
      <Show when={list().actionErr()}>
        <p class="truncate px-3 pb-1.5 font-mono text-2xs text-destructive" title={list().actionErr()}>
          {list().actionErr()}
        </p>
      </Show>
      <div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-4 pt-1 [mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent)]">
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
        {/* The label of the list below, and the two tools that decide what the
            list shows. They stay in sight: a control that hides until it is
            hunted for is a control the reader has to find, and a filter that
            is already on has nothing to announce. They are quiet instead —
            muted icons beside a muted label read as a caption, where a filled
            pair of buttons would read as a toolbar. */}
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
                        // Only a directory that was actually taken changes what
                        // the list is showing; an empty draft adds nothing.
                        if (props.ws.addDir(props.ws.dirDraft())) afterOpeningDirectory();
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
                  onClick={() => {
                    void props.ws.pickDir().then((dir) => {
                      // A cancelled picker resolves with nothing; switching the
                      // view for it would be the button acting on a no-op.
                      if (dir !== undefined) afterOpeningDirectory();
                    });
                  }}
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
      {/* The archive has a fixed place at the foot of the rail. Inside the
          list it sank below every project and every session the reader had,
          and the only way back to it was to scroll to the very end. A place
          you have to look for is not a place. */}
      <ArchivedSection list={props.list} now={props.clock} onOpen={props.onOpenSession} />
      <ConnectionsFooter
        conns={props.conns}
        compareReady={props.compareSel.length === 2}
        onCompareOpen={props.onOpenCompare}
      />
    </aside>
  );
}
