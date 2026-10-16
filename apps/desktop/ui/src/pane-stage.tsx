import { For, Show, type JSX } from "solid-js";
import { Icon, type Name } from "./icons";
import { t } from "./i18n";
import { Tip } from "./tip";
import { realWorkspace } from "./api";
import { sessionStatus, showsDot } from "./session-status";
import { paneStatus } from "./pane-activity";
import { ToggleIcon } from "./header-toggle";
import { toggleClasses } from "./toggle-state";
import { SessionStatusMark } from "@/components/ui/session-status";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  detectPreset,
  findLeaf,
  listLeaves,
  RATIO_DEFAULT,
  type LayoutPreset,
  type PaneLeaf,
  type PaneNode,
  type PaneWorkspaceState,
  type SplitDir,
} from "./pane-tree";

export type SessionRowSummary = {
  summary: { session_id: string; title?: string | null; workspace?: string | null };
  title?: string | null;
  workspace?: string | null;
  parent?: string | null;
  status: string;
  busy?: boolean;
  needs_input?: boolean;
};

function presetIcon(preset: LayoutPreset | "custom"): Name {
  if (preset === "cols-2") return "split-row";
  if (preset === "rows-2") return "split-col";
  if (preset === "grid-4" || preset === "custom") return "grid";
  return "split-row";
}

function folderLabel(ws: string | null | undefined): string | undefined {
  const real = realWorkspace(ws ?? undefined);
  if (!real) return undefined;
  return real === "/" || real === "\\" ? t("path.root") : real.split(/[/\\]/).filter(Boolean).at(-1);
}

/**
 * Header control for switching between single-window mode, preset grids
 * (1x2, 2x1, 2x2), and free pane splits.
 */
export function LayoutSwitcher(props: {
  workspace: PaneWorkspaceState;
  onPreset: (preset: LayoutPreset) => void;
  onSplit: (dir: SplitDir) => void;
  onToggleZoom: () => void;
}) {
  const currentPreset = () => detectPreset(props.workspace);
  const isMultiplex = () => props.workspace.mode === "multiplex";
  const zoomed = () => props.workspace.zoomedPaneId !== null;
  const leafCount = () => listLeaves(props.workspace.root).length;

  return (
    <DropdownMenu placement="bottom-end">
      <Tip label={t("pane.layout")}>
        <DropdownMenuTrigger
          class={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-secondary ${
            isMultiplex() ? toggleClasses(true) : "text-muted-foreground hover:text-foreground"
          }`}
          aria-label={t("pane.layout")}
        >
          <ToggleIcon on={isMultiplex()}>
            <Icon name={presetIcon(currentPreset())} />
          </ToggleIcon>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent class="min-w-52">
        <DropdownMenuItem onSelect={() => props.onPreset("single")}>
          <Icon name="single-pane" class="size-3.5 text-muted-foreground" />
          <span class="flex-1">{t("pane.mode.single")}</span>
          <Show when={currentPreset() === "single"}>
            <Icon name="check" class="size-3.5 text-foreground" />
          </Show>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => props.onPreset("cols-2")}>
          <Icon name="split-row" class="size-3.5 text-muted-foreground" />
          <span class="flex-1">{t("pane.mode.cols2")}</span>
          <Show when={currentPreset() === "cols-2"}>
            <Icon name="check" class="size-3.5 text-foreground" />
          </Show>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => props.onPreset("rows-2")}>
          <Icon name="split-col" class="size-3.5 text-muted-foreground" />
          <span class="flex-1">{t("pane.mode.rows2")}</span>
          <Show when={currentPreset() === "rows-2"}>
            <Icon name="check" class="size-3.5 text-foreground" />
          </Show>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => props.onPreset("grid-4")}>
          <Icon name="grid" class="size-3.5 text-muted-foreground" />
          <span class="flex-1">{t("pane.mode.grid4")}</span>
          <Show when={currentPreset() === "grid-4"}>
            <Icon name="check" class="size-3.5 text-foreground" />
          </Show>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => props.onSplit("row")}>
          <Icon name="split-row" class="size-3.5 text-muted-foreground" />
          <span class="flex-1">{t("pane.split.right")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => props.onSplit("col")}>
          <Icon name="split-col" class="size-3.5 text-muted-foreground" />
          <span class="flex-1">{t("pane.split.down")}</span>
        </DropdownMenuItem>
        <Show when={isMultiplex() && leafCount() > 1}>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={props.onToggleZoom}>
            <Icon name={zoomed() ? "minimize" : "maximize"} class="size-3.5 text-muted-foreground" />
            <span class="flex-1">{zoomed() ? t("pane.zoom.out") : t("pane.zoom.in")}</span>
          </DropdownMenuItem>
        </Show>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PaneHeader(props: {
  leaf: PaneLeaf;
  focused: boolean;
  zoomed: boolean;
  sessions: readonly SessionRowSummary[];
  onFocus: () => void;
  onSelectSession: (sessionId: string) => void;
  onSplit: (dir: SplitDir) => void;
  onToggleZoom: () => void;
  onClose: () => void;
}) {
  const row = () => props.sessions.find((s) => s.summary.session_id === props.leaf.sessionId);
  // OR-ed with whatever the pane showing this session last read from its own
  // view, so the dot is not held hostage to the session list's refetch latency.
  const status = () => {
    const id = props.leaf.sessionId;
    return id ? paneStatus(id, row()) : undefined;
  };
  const title = () => {
    if (!props.leaf.sessionId) return t("pane.empty.title");
    const r = row();
    return r?.title || r?.summary.title || t("session.untitled");
  };
  const wsName = () => {
    const r = row();
    return folderLabel(r?.workspace ?? r?.summary.workspace);
  };

  return (
    <div
      class={`@container flex h-7 shrink-0 items-center justify-between gap-1.5 border-b border-border px-2.5 select-none transition-colors ${
        // Focus used to be `bg-secondary/60` against `bg-background/70`, which
        // is 13% grey at 60% strength over 6.5% — about a four-point lightness
        // step on the least contrast-sensitive channel available, on a band
        // seven pixels tall. At full strength it is a six-and-a-half-point
        // step, which is a surface you can see without hunting for it.
        props.focused
          ? "bg-secondary text-foreground"
          : "bg-transparent text-muted-foreground hover:bg-secondary/40"
      }`}
      onPointerDown={() => props.onFocus()}
    >
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          class={`w-0.5 shrink-0 rounded-full transition-colors ${
            // Full header height, so the rail reads as an edge of the pane
            // rather than a tick floating beside the title.
            props.focused ? "h-5 bg-primary" : "h-5 bg-transparent"
          }`}
        />
        <Show when={status() && showsDot(status()!)}>
          <SessionStatusMark status={status()!} class="shrink-0 self-center" />
        </Show>
        <DropdownMenu placement="bottom-start">
          <DropdownMenuTrigger
            class={`flex min-w-0 max-w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-secondary ${
              // Weight, not colour: the one focus channel that survives both
              // themes and greyscale, and the one that survives a reader who
              // cannot separate 6.5% from 13% at a glance.
              props.focused ? "font-semibold" : "font-medium"
            }`}
            aria-label={t("pane.switch_session")}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span class="truncate">{title()}</span>
            <Icon name="chevron" class="size-2.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="max-h-72 min-w-56 overflow-y-auto">
            <For each={props.sessions.slice(0, 30)}>
              {(s) => {
                const sid = s.summary.session_id;
                const st = sessionStatus(s);
                const label = s.title || s.summary.title || t("session.untitled");
                return (
                  <DropdownMenuItem onSelect={() => props.onSelectSession(sid)}>
                    <Show when={showsDot(st)} fallback={<span class="size-1.5 shrink-0" />}>
                      <SessionStatusMark status={st} class="shrink-0" />
                    </Show>
                    <span class="min-w-0 flex-1 truncate text-xs">{label}</span>
                    <Show when={sid === props.leaf.sessionId}>
                      <Icon name="check" class="size-3.5 shrink-0 text-foreground" />
                    </Show>
                  </DropdownMenuItem>
                );
              }}
            </For>
          </DropdownMenuContent>
        </DropdownMenu>
        <Show when={wsName()}>
          {(ws) => (
            <span class="max-w-28 shrink-0 truncate font-mono text-2xs text-muted-foreground @max-[320px]:hidden">
              {ws()}
            </span>
          )}
        </Show>
      </div>

      <div
        class="flex shrink-0 items-center gap-0.5"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Tip label={t("pane.split.right")}>
          <Button
            type="button"
            size="icon-2xs"
            variant="icon"
            aria-label={t("pane.split.right")}
            onClick={() => props.onSplit("row")}
          >
            <Icon name="split-row" class="size-3" />
          </Button>
        </Tip>
        <Tip label={t("pane.split.down")}>
          <Button
            type="button"
            size="icon-2xs"
            variant="icon"
            aria-label={t("pane.split.down")}
            onClick={() => props.onSplit("col")}
          >
            <Icon name="split-col" class="size-3" />
          </Button>
        </Tip>
        <Tip label={props.zoomed ? t("pane.zoom.out") : t("pane.zoom.in")}>
          <Button
            type="button"
            size="icon-2xs"
            variant="icon"
            class={toggleClasses(props.zoomed)}
            aria-label={props.zoomed ? t("pane.zoom.out") : t("pane.zoom.in")}
            onClick={() => props.onToggleZoom()}
          >
            <ToggleIcon on={props.zoomed}>
              <Icon name={props.zoomed ? "minimize" : "maximize"} class="size-3" />
            </ToggleIcon>
          </Button>
        </Tip>
        <Tip label={t("pane.close")}>
          <Button
            type="button"
            size="icon-2xs"
            variant="icon"
            aria-label={t("pane.close")}
            onClick={() => props.onClose()}
          >
            <Icon name="x" class="size-3" />
          </Button>
        </Tip>
      </div>
    </div>
  );
}

function EmptyPanePicker(props: {
  sessions: readonly SessionRowSummary[];
  openSessionIds: ReadonlySet<string>;
  onSelect: (sessionId: string) => void;
}) {
  const candidates = () =>
    [...props.sessions].sort((a, b) => {
      const aOpen = props.openSessionIds.has(a.summary.session_id) ? 1 : 0;
      const bOpen = props.openSessionIds.has(b.summary.session_id) ? 1 : 0;
      return aOpen - bOpen;
    });

  return (
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-6">
      <div class="w-full max-w-sm space-y-3">
        <EmptyState
          icon="columns"
          title={t("pane.empty.title")}
          description={t("pane.empty.hint")}
        />
        <Show when={candidates().length > 0}>
          <div class="max-h-56 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border bg-card/50 p-1">
            <For each={candidates().slice(0, 12)}>
              {(s) => {
                const sid = s.summary.session_id;
                const st = sessionStatus(s);
                const ws = folderLabel(s.workspace ?? s.summary.workspace);
                return (
                  <RowButton
                    class="flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs"
                    onClick={() => props.onSelect(sid)}
                  >
                    <span class="flex min-w-0 flex-1 items-center gap-2">
                      <Show when={showsDot(st)} fallback={<span class="size-1.5 shrink-0" />}>
                        <SessionStatusMark status={st} class="shrink-0" />
                      </Show>
                      <span class="truncate font-medium text-foreground">
                        {s.title || s.summary.title || t("session.untitled")}
                      </span>
                    </span>
                    <Show when={ws}>
                      <span class="max-w-24 shrink-0 truncate font-mono text-2xs text-muted-foreground">
                        {ws}
                      </span>
                    </Show>
                  </RowButton>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

/**
 * Resizable split divider between two child nodes.
 */
function SplitDivider(props: {
  dir: SplitDir;
  onResize: (ratio: number) => void;
}) {
  let containerEl: HTMLDivElement | undefined;

  const startDrag = (e: PointerEvent & { currentTarget: HTMLDivElement }) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const parent = handle.parentElement;
    if (!parent) return;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      if (props.dir === "row") {
        if (rect.width <= 0) return;
        props.onResize((ev.clientX - rect.left) / rect.width);
      } else {
        if (rect.height <= 0) return;
        props.onResize((ev.clientY - rect.top) / rect.height);
      }
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  };

  return (
    <div
      ref={containerEl}
      role="separator"
      aria-orientation={props.dir === "row" ? "vertical" : "horizontal"}
      aria-label={t("pane.resize")}
      onPointerDown={startDrag}
      onDblClick={() => props.onResize(RATIO_DEFAULT)}
      class={
        props.dir === "row"
          ? "group relative z-10 flex w-1 shrink-0 cursor-col-resize items-stretch justify-center select-none"
          : "group relative z-10 flex h-1 shrink-0 cursor-row-resize items-center justify-center select-none"
      }
    >
      <div
        class={
          props.dir === "row"
            ? "h-full w-px bg-border transition-colors group-hover:w-0.5 group-hover:bg-primary/60 group-active:w-0.5 group-active:bg-primary"
            : "h-px w-full bg-border transition-colors group-hover:h-0.5 group-hover:bg-primary/60 group-active:h-0.5 group-active:bg-primary"
        }
      />
    </div>
  );
}

export function PaneStage(props: {
  workspace: PaneWorkspaceState;
  sessions: readonly SessionRowSummary[];
  renderFocusedTranscript: () => JSX.Element;
  renderPeerTranscript: (sessionId: string, paneId: string) => JSX.Element;
  onFocusPane: (paneId: string, sessionId: string | null) => void;
  onSelectPaneSession: (paneId: string, sessionId: string) => void;
  onSplitPane: (paneId: string, dir: SplitDir) => void;
  onClosePane: (paneId: string) => void;
  onToggleZoom: (paneId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
}) {
  const openIds = () => {
    const set = new Set<string>();
    for (const leaf of listLeaves(props.workspace.root)) {
      if (leaf.sessionId) set.add(leaf.sessionId);
    }
    return set;
  };

  const renderLeaf = (leaf: PaneLeaf, zoomed: boolean): JSX.Element => {
    const isFocused = () => props.workspace.focusedPaneId === leaf.id;
    return (
      <section
        data-pane-id={leaf.id}
        aria-current={isFocused() ? "true" : undefined}
        class={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
          isFocused() ? "bg-background" : "bg-background/60"
        }`}
        onPointerDown={() => {
          if (!isFocused()) props.onFocusPane(leaf.id, leaf.sessionId);
        }}
      >
        <PaneHeader
          leaf={leaf}
          focused={isFocused()}
          zoomed={zoomed}
          sessions={props.sessions}
          onFocus={() => props.onFocusPane(leaf.id, leaf.sessionId)}
          onSelectSession={(sid) => props.onSelectPaneSession(leaf.id, sid)}
          onSplit={(dir) => props.onSplitPane(leaf.id, dir)}
          onToggleZoom={() => props.onToggleZoom(leaf.id)}
          onClose={() => props.onClosePane(leaf.id)}
        />
        <Show
          when={leaf.sessionId}
          fallback={
            <EmptyPanePicker
              sessions={props.sessions}
              openSessionIds={openIds()}
              onSelect={(sid) => props.onSelectPaneSession(leaf.id, sid)}
            />
          }
        >
          {(sid) => (
            <Show
              when={isFocused()}
              fallback={props.renderPeerTranscript(sid(), leaf.id)}
            >
              {props.renderFocusedTranscript()}
            </Show>
          )}
        </Show>
      </section>
    );
  };

  const renderNode = (node: PaneNode): JSX.Element => {
    if (node.kind === "leaf") {
      return renderLeaf(node, false);
    }
    return (
      <div
        class={`flex min-h-0 min-w-0 flex-1 ${
          node.dir === "row" ? "flex-row" : "flex-col"
        }`}
      >
        <div
          class="flex min-h-0 min-w-0 flex-col overflow-hidden"
          style={{ flex: `${node.ratio} 1 0%` }}
        >
          {renderNode(node.a)}
        </div>
        <SplitDivider
          dir={node.dir}
          onResize={(ratio) => props.onResizeSplit(node.id, ratio)}
        />
        <div
          class="flex min-h-0 min-w-0 flex-col overflow-hidden"
          style={{ flex: `${1 - node.ratio} 1 0%` }}
        >
          {renderNode(node.b)}
        </div>
      </div>
    );
  };

  const zoomedLeaf = () =>
    props.workspace.zoomedPaneId
      ? findLeaf(props.workspace.root, props.workspace.zoomedPaneId)
      : undefined;

  return (
    <Show
      when={props.workspace.mode === "multiplex"}
      fallback={props.renderFocusedTranscript()}
    >
      <div class="flex min-h-[30vh] min-w-0 flex-1 flex-col overflow-hidden">
        <Show
          when={zoomedLeaf()}
          fallback={renderNode(props.workspace.root)}
        >
          {(leaf) => renderLeaf(leaf(), true)}
        </Show>
      </div>
    </Show>
  );
}
