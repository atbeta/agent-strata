import { For, Show } from "solid-js";
import {
  archiveSession,
  backendLabel,
  deleteSession,
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
import { sessionStatus } from "./session-status";
import { explain } from "./errors";
import type { SessionListCtl } from "./use-session-list";
import type { ConnectionsCtl } from "./use-connections";
import { endpointHost, endpointShort, ConnectionsFooter } from "./use-connections";
import type { WorkspaceCtl } from "./use-workspace";
import { WorkspacePicker } from "./use-workspace";
import { SessionListItem } from "./sidebar-row";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { SectionHeader } from "@/components/ui/section-header";
import { MiniTabs } from "@/components/ui/mini-tabs";
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
  onNewSession: () => void;
  onOpenFleet: () => void;
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

  return (
    <aside class="flex w-[300px] shrink-0 flex-col border-r border-border bg-background">
      {/* The old header was a full row whose only content was a plus pushed
          to the right, so the corner under the wordmark was a blank band.
          The plus sits on the search row instead. */}
      <div class="flex items-start">
        <div class="min-w-0 flex-1">
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
        </div>
        <Tip
          class="pt-2 pr-1.5"
          label={props.conns.connected() ? t("action.newSession") : t("action.connectBackend")}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            class="size-8 text-lg leading-none text-muted-foreground"
            aria-label={props.conns.connected() ? t("action.newSession") : t("action.connectBackend")}
            onClick={() => props.onNewSession()}
          >
            +
          </Button>
        </Tip>
      </div>
      <WorkspacePicker
        ws={props.ws}
        sessionCount={list().sessions().length}
        options={() =>
          props.ws.workspaceOptions(
            settled(list().data)?.sessions ?? [],
            list().sessionWorkspace,
          )
        }
        actionErr={list().actionErr()}
      />
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
              <span class="font-mono text-2xs text-muted-foreground/60 tabular-nums">
                {list().sessions().length}
              </span>
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
        <For
          each={list().groups()}
          fallback={
            <p class="px-2 py-8 text-center text-xs text-muted-foreground">
              {list().attentionOnly() && list().sessions().length > 0
                ? t("sidebar.empty.attention")
                : list().data.error
                  ? explain(list().data.error)
                  : settled(list().data)
                    ? t("sidebar.empty.inProject")
                    : t("sidebar.empty.needBackend")}
            </p>
          }
        >
          {(group) => (
            <section class="mb-2">
              <SectionHeader
                label={group.label}
                count={group.rows.length}
                hint={group.hint}
              />
              <For each={group.rows}>
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
                      onDelete={() => list().runAction(id, () => deleteSession(id), true)}
                      pinned={list().pins().includes(id)}
                      onTogglePin={() => list().togglePinned(id)}
                      onCompare={() => props.onStartCompare(id)}
                      onSplitOpen={() => openSessionInSplit(id, "row")}
                      instance={instanceOf(s)}
                    />
                  );
                }}
              </For>
            </section>
          )}
        </For>
      </div>
      <ConnectionsFooter
        conns={props.conns}
        compareReady={props.compareSel.length === 2}
        onCompareOpen={props.onOpenCompare}
      />
    </aside>
  );
}
