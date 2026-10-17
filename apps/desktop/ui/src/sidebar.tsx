import { createEffect, For, Show, createSignal } from "solid-js";
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
import { Icon } from "./icons";
import { Tip } from "./tip";
import { CommandSearch } from "./search";
import { openSessionInSplit } from "./session-chrome";
import { hostsTrafficLights } from "./shell";
import { sessionStatus } from "./session-status";
import { explain } from "./errors";
import type { SessionListCtl, SidebarGroup } from "./use-session-list";
import type { ConnectionsCtl } from "./use-connections";
import { endpointHost, endpointShort, ConnectionsFooter } from "./use-connections";
import type { WorkspaceCtl } from "./use-workspace";
import { SessionListItem } from "./sidebar-row";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { SectionHeader } from "@/components/ui/section-header";
import { MiniTabs } from "@/components/ui/mini-tabs";
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
 * row with its attention lens, the grouped session list, and the connections
 * footer. State lives in the `list`/`ws`/`conns` hooks; this only composes
 * and wires them to rows.
 */
export function Sidebar(props: {
  list: SessionListCtl;
  ws: WorkspaceCtl;
  conns: ConnectionsCtl;
  search: SidebarSearch;
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
  const splitInstances = () => {
    const ids = new Set<string>();
    for (const g of list().groups()) for (const s of g.rows) ids.add(s.connection_id ?? "");
    return ids;
  };

  const instanceOf = (s: SessionRow) => {
    if (!s.connection_id || splitInstances().size < 2) return undefined;
    const c = (settled(props.conns.conns)?.connections ?? []).find((x) => x.id === s.connection_id);
    if (!c) return undefined;
    return {
      short: endpointShort(c.baseUrl),
      tip: `${backendLabel(c.backend)} · ${endpointHost(c.baseUrl)}`,
    };
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

  /** Pinned and attention are lanes; projects are places. The label row and
      its "+" sit between them. */
  const metaGroups = () => list().groups().filter((g) => g.key.startsWith("__"));
  const projectGroups = () => list().groups().filter((g) => !g.key.startsWith("__"));

  const renderGroup = (group: SidebarGroup) => {
    const rows = () => (expanded().has(group.key) ? group.rows : group.rows.slice(0, PAGE));
    return (
      <section
        data-group={group.key}
        class={cn("group/section", collapsed().has(group.key) ? "mb-0" : "mb-2")}
      >
        <SectionHeader
          label={group.label}
          count={group.rows.length}
          hint={group.hint}
          title={group.title}
          icon={group.dir !== undefined ? (collapsed().has(group.key) ? "folder" : "folder-open") : undefined}
          chevron={group.dir === undefined}
          open={!collapsed().has(group.key)}
          onToggle={() => setCollapsed((s) => flip(s, group.key))}
          action={
            group.dir !== undefined ? (
              <Tip label={t("action.newSession")}>
                {/* Revealed on section hover — one "+" per project, always on,
                    would be a rail of pluses down the rail. */}
                <Button
                  variant="quiet"
                  size="icon-2xs"
                  class="size-4 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100"
                  aria-label={t("action.newSession")}
                  onClick={() => props.onNewSession(group.dir)}
                >
                  <Icon name="plus" class="size-2.5" />
                </Button>
              </Tip>
            ) : undefined
          }
        />
        <Show when={!collapsed().has(group.key)}>
          <Show when={group.dir !== undefined && group.rows.length === 0}>
            <p class="px-2 py-1 text-2xs text-muted-foreground">{t("sidebar.group.empty")}</p>
          </Show>
          <For each={rows()}>
            {(s) => {
              const id = s.summary.session_id;
              return (
                <SessionListItem
                  id={id}
                  title={s.title ?? s.summary.title ?? t("common.untitled")}
                  active={props.activeId() === id || props.compareSel.includes(id)}
                  status={sessionStatus(s)}
                  time={relTime(s.summary.last_ts, props.clock())}
                  actions={!props.compareOn}
                  onOpen={() => props.onOpenSession(id)}
                  onRename={(title) => list().runAction(id, () => renameSession(id, title), false)}
                  onArchive={() => list().runAction(id, () => archiveSession(id), true)}
                  pinned={list().pins().includes(id)}
                  onTogglePin={() => list().togglePinned(id)}
                  onCompare={() => props.onStartCompare(id)}
                  onSplitOpen={() => openSessionInSplit(id, "row")}
                  instance={instanceOf(s)}
                />
              );
            }}
          </For>
          <Show when={!expanded().has(group.key) && group.rows.length > PAGE}>
            <RowButton
              class="h-7 items-center px-2 text-2xs text-muted-foreground hover:bg-secondary/70"
              onClick={() => setExpanded((s) => flip(s, group.key))}
            >
              <Icon name="chevron" class="size-2.5 rotate-90 text-muted-foreground/60" />
              {t("sidebar.group.more", { n: group.rows.length - PAGE })}
            </RowButton>
          </Show>
        </Show>
      </section>
    );
  };

  return (
    <aside class="flex w-[300px] shrink-0 flex-col border-r border-border bg-background">
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
      <CommandSearch
        open={props.search.open}
        query={props.search.query}
        sessions={list().library()}
        events={props.search.events}
        searching={props.search.searching}
        onOpenChange={props.search.onOpenChange}
        onQuery={props.search.onQuery}
        onOpenSession={props.search.onOpenSession}
      />
      <Show when={list().actionErr()}>
        <p class="truncate px-3 pb-1.5 font-mono text-2xs text-destructive" title={list().actionErr()}>
          {list().actionErr()}
        </p>
      </Show>
      <div class="border-t border-border px-1.5 pt-1 pb-1">
        <div class="flex items-center gap-1">
          <RowButton
            class={cn(
              "h-8 min-w-0 flex-1 items-center px-2",
              props.fleetActive
                ? "bg-accent text-foreground"
                : "text-foreground/80 hover:bg-secondary/70",
            )}
            aria-current={props.fleetActive ? "page" : undefined}
            onClick={() => props.onOpenFleet()}
          >
            <Icon name="list" class="size-3.5 shrink-0 text-muted-foreground" />
            {/* Label and count travel together, the way SectionHeader sets a
                group's count beside its name. `flex-1` here stranded the number
                at the panel edge, so the one row that sits directly above the
                groups read differently from the groups below it. */}
            <span class="flex items-baseline gap-1.5">
              <span class="truncate">{t("fleet.nav")}</span>
            </span>
          </RowButton>
          {/* The "only what is running" lens. It filters rather than sorts
              because a session that is not moving answers a different
              question than the one this tab asks. */}
          <MiniTabs
            class="shrink-0"
            value={list().attentionOnly() ? "attention" : "all"}
            options={[
              { id: "all", label: t("sidebar.filter.all") },
              { id: "attention", label: t("sidebar.filter.attention"), count: list().attentionRows().length },
            ]}
            onChange={(id) => list().setAttentionOnly(id === "attention")}
            label={t("sidebar.filter.label")}
          />
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
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
        <For each={metaGroups()}>{renderGroup}</For>
        {/* The attention lens collapses the list to one lane — a projects
            label above nothing would just be a dangling header. */}
        <Show when={!list().attentionOnly()}>
        <div class="mb-0.5 flex items-center justify-between px-2 pb-0.5 pt-2.5">
          <span class="text-xs font-medium text-muted-foreground">{t("sidebar.projects")}</span>
          {/* Open a directory that has no sessions yet — the one place a
              project the list does not already know can enter it. */}
          <DropdownMenu
            open={props.ws.dirOpen()}
            onOpenChange={props.ws.setDirOpen}
            gutter={4}
            placement="bottom-end"
          >
            <Tip label={t("sidebar.project.openDirectory")}>
              <DropdownMenuTrigger class="grid size-5 place-items-center rounded text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
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
                    onChange={props.ws.setDirDraft}
                    class="bg-background text-2xs"
                    placeholder="/path/to/project"
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </TextField>
              </form>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Show
          when={projectGroups().length > 0}
          fallback={
            <Show when={metaGroups().length === 0}>
              <EmptyState
                icon={list().data.error ? "alert" : "list"}
                tone={list().data.error ? "danger" : "neutral"}
                class="px-4 py-10"
                title={
                  list().attentionOnly() && list().sessions().length > 0
                    ? t("sidebar.empty.attention")
                    : list().data.error
                      ? explain(list().data.error)
                      : settled(list().data)
                        ? t("sidebar.empty.none")
                        : t("sidebar.empty.needBackend")
                }
                action={
                  settled(list().data) && !list().data.error ? (
                    <Button size="sm" variant="quiet" onClick={() => props.onNewSession()}>
                      {t("action.newSession")}
                    </Button>
                  ) : undefined
                }
              />
            </Show>
          }
        >
          <For each={projectGroups()}>{renderGroup}</For>
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
