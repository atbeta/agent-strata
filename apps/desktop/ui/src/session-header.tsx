import { Show, type JSX } from "solid-js";
import { downloadExport, fmtUsd, folderLabel, realWorkspace, type SessionView } from "./api";
import { Icon } from "./icons";
import { t } from "./i18n";
import { displayTitle } from "./session-title";
import { inDesktopShell, shellPlatform } from "./shell";
import { Tip } from "./tip";
import { ToggleIcon } from "./header-toggle";
import { toggleClasses } from "./toggle-state";
import { LayoutSwitcher, type SessionRowSummary } from "./pane-stage";
import type { LayoutPreset, PaneWorkspaceState, SplitDir } from "./pane-tree";
import type { useSessionSearch } from "./session-search";
import { McpAttentionMark, type useMcpTools } from "./session-tools";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Ctrl on a PC, ⌘ on a Mac. The tooltip used to say "Ctrl+F" on every platform. */
function findKey(): string {
  return shellPlatform() === "macos" ? "⌘F" : "Ctrl+F";
}

/**
 * A header panel toggle: icon button, quiet at rest, filled while its panel is
 * open.
 *
 * Five of these sit in one row — search, terminal, files, replay, tools — and
 * each had the same class string written out again with the selected state
 * interpolated, so adding a sixth meant copying a ternary. None of them drew a
 * focus ring either, which left tabbing across the header moving an invisible
 * cursor past five controls.
 *
 * `expanded` and `pressed` are separate because the search button answers
 * `aria-expanded` (it reveals a field) while the rest answer `aria-pressed`
 * (they toggle a surface that stays in the layout).
 */
function PanelToggle(props: {
  label: string;
  on: boolean;
  expanded?: boolean;
  pressed?: boolean;
  /** the colour an open toggle's icon takes, when open means more than "a panel is showing" */
  tone?: string;
  /** the trigger counts as inside its own panel, so dismissing must name it */
  bindRef?: (el: HTMLButtonElement | undefined) => void;
  onClick: () => void;
  children: JSX.Element;
}) {
  return (
    <Button
      ref={props.bindRef}
      type="button"
      size="icon-sm"
      variant="icon"
      class={toggleClasses(props.on)}
      aria-label={props.label}
      aria-expanded={props.expanded}
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      <ToggleIcon on={props.on} tone={props.tone}>
        {props.children}
      </ToggleIcon>
    </Button>
  );
}

type Bind = (el: HTMLButtonElement | undefined) => void;

/**
 * The loaded session's header row: where the reader is, and the session's own
 * controls.
 *
 * The state behind every toggle stays with the session. The anchored panels
 * dismiss against their triggers, so each trigger is handed back through a
 * `bind*` callback rather than kept here.
 */
export function SessionHeader(props: {
  view: SessionView;
  sessions: SessionRowSummary[];
  branch: string | undefined;
  opencode: boolean;
  search: ReturnType<typeof useSessionSearch>;
  tools: ReturnType<typeof useMcpTools>;
  terminalOn: boolean;
  onToggleTerminal: () => void;
  traceOn: boolean;
  onToggleTrace: () => void;
  panelVisible: boolean;
  onTogglePanel: () => void;
  workspace: PaneWorkspaceState;
  onPreset: (preset: LayoutPreset) => void;
  onSplit: (dir: SplitDir) => void;
  onToggleZoom: () => void;
  onError: (message: string) => void;
  bindSearchTrigger: Bind;
  bindToolsTrigger: Bind;
  bindMoreTrigger: Bind;
  bindPanelTrigger: Bind;
}) {
  const exportSession = () =>
    void downloadExport(props.view.session_id).catch((err) =>
      props.onError(err instanceof Error ? err.message : t("err.network")),
    );

  return (
    <header
      class="@container flex h-9 shrink-0 items-center gap-2 border-b border-border px-4 select-none"
      data-tauri-drag-region={inDesktopShell() ? "" : undefined}
    >
      <div class="flex min-w-0 flex-1 items-baseline gap-2">
        <Show when={props.view.parent_session_id}>
          {(parentId) => {
            const parent = () => props.sessions.find((s) => s.summary.session_id === parentId());
            return (
              <>
                <Button
                  type="button"
                  variant="quiet"
                  size="sm"
                  class="h-auto max-w-48 shrink-0 px-0 py-0 text-sm"
                  onClick={() => {
                    location.hash = `/session/${encodeURIComponent(parentId())}`;
                  }}
                >
                  {/* The ellipsis belongs on the label: the button
                      centres what it holds, so a long parent name
                      was cut at both ends rather than at the end. */}
                  <span class="min-w-0 truncate">{parent()?.title || t("session.child.back")}</span>
                </Button>
                {/* The parent is a link back and the h1 is where we
                    are — without a mark between them the two titles
                    read as one run-on name. */}
                <Icon
                  name="chevron-right"
                  class="size-3 shrink-0 self-center text-faint-foreground"
                />
              </>
            );
          }}
        </Show>
        {/* Identity first. `flex-1` on a zero basis takes the free space, and the
            min-width floor means the title gives up its width last.
            The chips beside it stop being offered any width at all
            below 440px — a truncated chip renders one glyph and then
            reads as corruption, and both are on screen elsewhere (the
            branch in the session-details popover, the workspace in
            the sidebar). Before this the title reached 0px at the
            window's 960px minimum and the session you were reading
            had no name on screen. */}
        <h1
          class="min-w-24 flex-1 truncate text-sm font-medium"
          title={displayTitle(props.view.title) ?? t("session.untitled")}
        >
          {displayTitle(props.view.title) ?? t("session.untitled")}
        </h1>
        <Show when={realWorkspace(props.view.workspace)}>
          {(ws) => (
            <span
              class="max-w-40 shrink-0 truncate font-mono text-2xs text-muted-foreground @max-[440px]:hidden"
              title={ws()}
            >
              {folderLabel(ws())}
            </span>
          )}
        </Show>
        <Show when={props.branch}>
          {(branch) => (
            <Tip
              label={t("header.branch.tip", { branch: branch() })}
              class="@max-[440px]:hidden"
            >
              <span class="flex max-w-32 shrink-0 items-baseline gap-1 font-mono text-2xs text-muted-foreground">
                <Icon name="branch" class="h-3 w-3 shrink-0 self-center" />
                <span class="truncate">{branch()}</span>
              </span>
            </Tip>
          )}
        </Show>
        <Show when={props.view.totals.cost_usd > 0}>
          <Tip
            label={t("header.cost.tip", { amount: fmtUsd(props.view.totals.cost_usd) })}
            class="@max-[440px]:hidden"
          >
            <span class="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
              {fmtUsd(props.view.totals.cost_usd)}
            </span>
          </Tip>
        </Show>
      </div>
      <span class="flex shrink-0 items-center gap-0.5">
        <Tip label={t("session.search.tip", { shortcut: findKey() })}>
          <PanelToggle
            label={t("session.search.label")}
            on={props.search.searchOpen()}
            expanded={props.search.searchOpen()}
            onClick={() => (props.search.searchOpen() ? props.search.closeSearch() : props.search.openSearch())}
            bindRef={props.bindSearchTrigger}
          >
            <Icon name="search" />
          </PanelToggle>
        </Tip>
        <span class="flex items-center gap-0.5 @max-[719px]:hidden">
          <Show when={props.opencode}>
            <Tip label={props.terminalOn ? t("terminal.hide") : t("terminal.show")}>
              <PanelToggle
                label={props.terminalOn ? t("terminal.hide") : t("terminal.show")}
                on={props.terminalOn}
                pressed={props.terminalOn}
                onClick={props.onToggleTerminal}
              >
                <Icon name="terminal" />
              </PanelToggle>
            </Tip>
          </Show>
          <Tip label={props.traceOn ? t("trace.live") : t("trace.replay")}>
            <PanelToggle
              label={props.traceOn ? t("trace.live") : t("trace.replay")}
              on={props.traceOn}
              pressed={props.traceOn}
              onClick={props.onToggleTrace}
            >
              <Icon name="replay" />
            </PanelToggle>
          </Tip>
          <Show when={props.opencode}>
            <Tip label={t("header.tools")}>
              <PanelToggle
                label={t("header.tools")}
                on={props.tools.toolsOpen()}
                pressed={props.tools.toolsOpen()}
                onClick={props.tools.toggleTools}
                bindRef={props.bindToolsTrigger}
              >
                <span class="relative inline-flex">
                  <Icon name="plug" />
                  <McpAttentionMark tone={props.tools.attention()} />
                </span>
              </PanelToggle>
            </Tip>
          </Show>
          <span class="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
        </span>
        <LayoutSwitcher
          workspace={props.workspace}
          onPreset={props.onPreset}
          onSplit={props.onSplit}
          onToggleZoom={props.onToggleZoom}
        />
        <span class="@max-[719px]:hidden">
          <Tip label={t("header.export")}>
            <Button
              type="button"
              variant="icon"
              size="icon-sm"
              aria-label={t("header.export")}
              onClick={exportSession}
            >
              <Icon name="export" />
            </Button>
          </Tip>
        </span>
        <DropdownMenu placement="bottom-end">
          <DropdownMenuTrigger
            ref={(el: HTMLButtonElement) => props.bindMoreTrigger(el)}
            class={`relative h-7 w-7 rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground @min-[720px]:hidden ${toggleClasses(props.terminalOn || props.traceOn || props.tools.toolsOpen())}`}
            aria-label={t("header.more")}
          >
            <Icon name="more" class="size-4" />
            <McpAttentionMark tone={props.tools.attention()} />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="min-w-48">
            <Show when={props.opencode}>
              <DropdownMenuItem onSelect={props.onToggleTerminal}>
                <Icon name="terminal" class="size-3.5 text-muted-foreground" />
                <span class="flex-1">{props.terminalOn ? t("terminal.hide") : t("terminal.show")}</span>
                <Show when={props.terminalOn}><Icon name="check" class="size-3.5" /></Show>
              </DropdownMenuItem>
            </Show>
            <DropdownMenuItem onSelect={props.onToggleTrace}>
              <Icon name="replay" class="size-3.5 text-muted-foreground" />
              <span class="flex-1">{props.traceOn ? t("trace.live") : t("trace.replay")}</span>
              <Show when={props.traceOn}><Icon name="check" class="size-3.5" /></Show>
            </DropdownMenuItem>
            <Show when={props.opencode}>
              <DropdownMenuItem onSelect={props.tools.toggleTools}>
                <span class="relative inline-flex">
                  <Icon name="plug" class="size-3.5 text-muted-foreground" />
                  <McpAttentionMark tone={props.tools.attention()} />
                </span>
                <span class="flex-1">{t("header.tools")}</span>
                <Show when={props.tools.toolsOpen()}><Icon name="check" class="size-3.5" /></Show>
              </DropdownMenuItem>
            </Show>
            <DropdownMenuItem onSelect={exportSession}>
              <Icon name="export" class="size-3.5 text-muted-foreground" />
              <span class="flex-1">{t("header.export")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tip label={t(props.panelVisible ? "panel.hide" : "panel.show")}>
          <PanelToggle
            label={t(props.panelVisible ? "panel.hide" : "panel.show")}
            on={props.panelVisible}
            pressed={props.panelVisible}
            bindRef={props.bindPanelTrigger}
            onClick={props.onTogglePanel}
          >
            <Icon name="panel-right" />
          </PanelToggle>
        </Tip>
      </span>
    </header>
  );
}
