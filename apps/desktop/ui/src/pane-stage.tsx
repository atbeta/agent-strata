import { For, Show, createContext, createSignal, useContext, type JSX } from "solid-js";
import { Icon, type Name } from "./icons";
import { t } from "./i18n";
import { displayTitle } from "./session-title";
import { Tip } from "./tip";
import { folderLabel } from "./api";
import { sessionStatus, showsMark } from "./session-status";
import { paneStatus } from "./pane-activity";
import { ToggleIcon } from "./header-toggle";
import { toggleClasses } from "./toggle-state";
import { SessionStatusMark } from "@/components/ui/session-status";
import { ShellMark } from "./shell-mark";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { EmptyState } from "@/components/ui/empty-state";
import { TextFieldInput } from "@/components/ui/text-field";
import {
  pickPaneSessions,
  pickerLabel,
  pickerTruncated,
} from "./pane-session-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  detectPreset,
  listLeaves,
  RATIO_DEFAULT,
  RATIO_MAX,
  RATIO_MIN,
  type LayoutPreset,
  type PaneLeaf,
  type PaneNode,
  type PaneSplit,
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
  shell?: { command: string; detail: string };
};

/**
 * The button names the feature; the menu items name the presets.
 *
 * One pane showed a divided rectangle, which is a drawing of the thing rather
 * than a name for it — and it was wrong for the commonest state, which is one
 * pane and nothing divided. The trigger is the layout feature itself, so it
 * wears the library's `layout`: a narrow column beside a wide one, which is
 * the shape these panes actually take.
 */
function presetIcon(preset: LayoutPreset | "custom"): Name {
  if (preset === "cols-2") return "split-row";
  if (preset === "rows-2") return "split-col";
  if (preset === "grid-4" || preset === "custom") return "grid";
  return "layout";
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
          variant="icon"
          size="icon-sm"
          class={isMultiplex() ? toggleClasses(true) : undefined}
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

/**
 * The query is module state, not per-header state, on purpose: one search at a
 * time. Four panes each keeping their own would mean typing in one and being
 * unsure whether the pane you are about to click still has the old filter on
 * it. It resets when a picker closes, so it is never a filter you did not ask
 * for and forgot about.
 */
const [pickerQuery, setPickerQuery] = createSignal("");

const PICKER_LIMIT = 30;

function usePickerRows(sessions: () => readonly SessionRowSummary[]) {
  const untitled = () => t("session.untitled");
  return () => pickPaneSessions(sessions(), pickerQuery(), PICKER_LIMIT, untitled());
}

/**
 * A text field at the top of the menu.
 *
 * Kobalte's menu owns the arrow keys, Home and End, which is what we want —
 * they should keep moving the highlighted item while you type. Everything else,
 * including Backspace and Space, is left alone, because an input that eats its
 * own keystrokes is worse than one that is not in a menu at all.
 */
function SessionPickerSearch(props: { sessions: readonly SessionRowSummary[] }) {
  const rows = usePickerRows(() => props.sessions);
  const truncated = () =>
    pickerTruncated(props.sessions, pickerQuery(), PICKER_LIMIT, t("session.untitled"));

  return (
    <div
      class="shrink-0 border-b border-border p-1.5"
      // Any click landing on the field is a click to type, not a click that
      // selects the item under the pointer or closes the menu.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <TextFieldInput
        type="search"
        size="sm"
        value={pickerQuery()}
        placeholder={t("pane.search_session")}
        aria-label={t("pane.search_session")}
        class="h-7"
        onInput={(e) => setPickerQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          // Only the keys the menu is meant to own. Enter closes and picks the
          // highlighted row, which the menu already does for us.
          if (e.key === "Escape") {
            setPickerQuery("");
            return;
          }
          e.stopPropagation();
        }}
      />
      <Show when={truncated()}>
        <p class="px-1 pt-1.5 text-2xs text-muted-foreground">
          {t("pane.more_sessions")}
        </p>
      </Show>
      <Show when={pickerQuery().trim() && rows().length === 0}>
        <p class="px-1 pt-1.5 text-2xs text-muted-foreground">
          {t("pane.no_session_match")}
        </p>
      </Show>
    </div>
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
  const rows = usePickerRows(() => props.sessions);
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
    return displayTitle(r?.title || r?.summary.title) ?? t("session.untitled");
  };
  const wsName = () => {
    const r = row();
    return folderLabel(r?.workspace ?? r?.summary.workspace);
  };

  return (
    <div
      class={`@container flex h-7 shrink-0 items-center justify-between gap-1.5 border-b border-border px-2.5 select-none transition-colors ${
        props.focused
          ? "bg-secondary/80 text-foreground"
          : "bg-transparent text-muted-foreground hover:bg-secondary/40"
      }`}
      onPointerDown={() => props.onFocus()}
    >
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <Show when={status() && showsMark(status()!)}>
          <SessionStatusMark status={status()!} class="shrink-0 self-center" />
        </Show>
        <DropdownMenu placement="bottom-start">
          <DropdownMenuTrigger
            class={`flex min-w-0 max-w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left text-xs hover:bg-secondary ${
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
          <DropdownMenuContent class="flex max-h-72 min-w-56 flex-col overflow-hidden">
            <SessionPickerSearch sessions={props.sessions} />
            <div class="min-h-0 flex-1 overflow-y-auto">
              <For each={rows()}>
                {(s) => {
                  const sid = s.summary.session_id;
                  const st = sessionStatus(s);
                  const label = displayTitle(pickerLabel(s, t("session.untitled"))) ?? t("session.untitled");
                  return (
                    <DropdownMenuItem onSelect={() => props.onSelectSession(sid)}>
                      <Show when={showsMark(st)} fallback={<span class="size-1.5 shrink-0" />}>
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
              <Show when={rows().length === 0}>
                <p class="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t("pane.no_session_match")}
                </p>
              </Show>
            </div>
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
                      <Show when={showsMark(st)} fallback={<span class="size-1.5 shrink-0" />}>
                        <SessionStatusMark status={st} class="shrink-0" />
                      </Show>
                      <span class="truncate font-medium text-foreground">
                        {displayTitle(s.title || s.summary.title) ?? t("session.untitled")}
                      </span>
                      <Show when={s.shell}>
                        {(shell) => <ShellMark command={shell().command} detail={shell().detail} />}
                      </Show>
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
  splitId: string;
  dir: SplitDir;
  ratio: number;
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
      // The gutter sits inside the parent's box but belongs to neither pane, so
      // the drag is measured across the two panes alone and offset by half the
      // gutter — the boundary is at the gutter's centre. Measuring against the
      // parent as a whole would let the grab point drift by half a gutter, which
      // is invisible at four pixels and annoying at ten.
      const gutter = props.dir === "row" ? handle.offsetWidth : handle.offsetHeight;
      const span = (props.dir === "row" ? rect.width : rect.height) - gutter;
      if (span <= 0) return;
      const at =
        (props.dir === "row" ? ev.clientX - rect.left : ev.clientY - rect.top) -
        gutter / 2;
      props.onResize(at / span);
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
      data-split-id={props.splitId}
      aria-orientation={props.dir === "row" ? "vertical" : "horizontal"}
      aria-label={t("pane.resize")}
      aria-valuemin={RATIO_MIN * 100}
      aria-valuemax={RATIO_MAX * 100}
      aria-valuenow={Math.round(props.ratio * 100)}
      tabIndex={0}
      onPointerDown={startDrag}
      onKeyDown={(event) => {
        const forward = props.dir === "row" ? event.key === "ArrowRight" : event.key === "ArrowDown";
        const backward = props.dir === "row" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
        if (!forward && !backward) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.1 : 0.02;
        const id = props.splitId;
        props.onResize(props.ratio + (forward ? step : -step));
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`[data-split-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
        });
      }}
      onDblClick={() => props.onResize(RATIO_DEFAULT)}
      class={
        props.dir === "row"
          ? "group relative z-10 flex w-2.5 shrink-0 cursor-col-resize items-stretch justify-center select-none focus-visible:outline-none focus-visible:bg-ring/30 group-data-[zoomed]/stage:hidden"
          : "group relative z-10 flex h-2.5 shrink-0 cursor-row-resize items-center justify-center select-none focus-visible:outline-none focus-visible:bg-ring/30 group-data-[zoomed]/stage:hidden"
      }
    >
      {/* The gutter is the separator, not the line. It used to be four pixels
          wide with a one-pixel 7%-white rule down the middle — on a background
          the panes share with the app, so the rule was the only thing on screen
          saying a second pane existed, and at 7% white it did not say it
          convincingly. Ten pixels of the app's own background between two
          bordered rectangles is countable at a glance without a single extra
          pixel of ink. The line now only appears under the cursor, where it is
          the one thing that should be drawn. */}
      <div
        class={
          props.dir === "row"
            ? "h-full w-px bg-border opacity-0 transition-opacity group-hover:opacity-100 group-hover:w-0.5 group-hover:bg-primary/60 group-active:opacity-100 group-active:w-0.5 group-active:bg-primary"
            : "h-px w-full bg-border opacity-0 transition-opacity group-hover:opacity-100 group-hover:h-0.5 group-hover:bg-primary/60 group-active:opacity-100 group-active:h-0.5 group-active:bg-primary"
        }
      />
    </div>
  );
}

/**
 * Callbacks the tree reads. A fresh object on every workspace change would
 * remount the tree, which is the jump this split exists to avoid, so the
 * object is created once and every field reads the live props.
 */
type StageApi = {
  workspace: () => PaneWorkspaceState;
  sessions: () => readonly SessionRowSummary[];
  renderTranscript: (sessionId: string, paneId: string) => JSX.Element;
  onFocusPane: (paneId: string, sessionId: string | null) => void;
  onSelectPaneSession: (paneId: string, sessionId: string) => void;
  onSplitPane: (paneId: string, dir: SplitDir) => void;
  onClosePane: (paneId: string) => void;
  onToggleZoom: (paneId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
};

const StageApiContext = createContext<StageApi>();

function useStage(): StageApi {
  const api = useContext(StageApiContext);
  if (!api) throw new Error("pane tree rendered outside PaneStage");
  return api;
}

/**
 * One transcript for the life of this session in this pane.
 *
 * The slot is keyed on the session, so giving the pane a different
 * conversation mounts a new column. Focus does not: the same component stays
 * on screen and only its `active` prop changes.
 */
function TranscriptMount(props: { sessionId: string; paneId: string }) {
  const stage = useStage();
  return stage.renderTranscript(props.sessionId, props.paneId);
}

function PaneLeafView(props: { leaf: PaneLeaf }) {
  const stage = useStage();
  const focused = () => stage.workspace().focusedPaneId === props.leaf.id;
  // Zoom is this leaf covering the stage, not a second copy of it. The tree
  // stays mounted either way: the other panes are only hidden, so leaving zoom
  // does not build their transcripts again, and this one never has two.
  const zoomed = () => stage.workspace().zoomedPaneId === props.leaf.id;
  const covered = () => {
    const id = stage.workspace().zoomedPaneId;
    return id !== null && id !== props.leaf.id;
  };
  const openIds = () => {
    const set = new Set<string>();
    for (const leaf of listLeaves(stage.workspace().root)) {
      if (leaf.sessionId) set.add(leaf.sessionId);
    }
    return set;
  };
  return (
    <section
      data-pane-id={props.leaf.id}
      aria-current={focused() ? "true" : undefined}
      class={
        covered()
          ? "hidden"
          : `flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background ${
              zoomed() ? "absolute inset-0 z-20" : "relative flex-1"
            }`
      }
      onPointerDown={() => {
        if (!focused()) stage.onFocusPane(props.leaf.id, props.leaf.sessionId);
      }}
    >
      <PaneHeader
        leaf={props.leaf}
        focused={focused()}
        zoomed={zoomed()}
        sessions={stage.sessions()}
        onFocus={() => stage.onFocusPane(props.leaf.id, props.leaf.sessionId)}
        onSelectSession={(sid) => stage.onSelectPaneSession(props.leaf.id, sid)}
        onSplit={(dir) => stage.onSplitPane(props.leaf.id, dir)}
        onToggleZoom={() => stage.onToggleZoom(props.leaf.id)}
        onClose={() => stage.onClosePane(props.leaf.id)}
      />
      <Show
        when={props.leaf.sessionId}
        keyed
        fallback={
          <EmptyPanePicker
            sessions={stage.sessions()}
            openSessionIds={openIds()}
            onSelect={(sid) => stage.onSelectPaneSession(props.leaf.id, sid)}
          />
        }
      >
        {(sid) => <TranscriptMount sessionId={sid} paneId={props.leaf.id} />}
      </Show>
    </section>
  );
}

function PaneSplitView(props: { node: PaneSplit }) {
  const stage = useStage();
  const split = () => props.node;
  return (
    <div class={`flex min-h-0 min-w-0 flex-1 ${split().dir === "row" ? "flex-row" : "flex-col"}`}>
      <div
        class="flex min-h-0 min-w-0 flex-col overflow-hidden group-data-[zoomed]/stage:overflow-visible"
        style={{ flex: `${split().ratio} 1 0%` }}
      >
        <PaneBranch node={split().a} />
      </div>
      <SplitDivider
        splitId={split().id}
        dir={split().dir}
        ratio={split().ratio}
        onResize={(ratio) => stage.onResizeSplit(split().id, ratio)}
      />
      <div
        class="flex min-h-0 min-w-0 flex-col overflow-hidden group-data-[zoomed]/stage:overflow-visible"
        style={{ flex: `${1 - split().ratio} 1 0%` }}
      >
        <PaneBranch node={split().b} />
      </div>
    </div>
  );
}

/**
 * A node of the tree, as a component rather than a function called while rendering.
 *
 * A `Show` fallback that *called* a render function built a new element tree on
 * every workspace change — focus, a drag, a session landing in a slot — and the
 * previous transcripts were thrown away. That is the jump, and it is why a pane
 * left alone for a while loaded from scratch when you came back: its view had
 * been evicted and its DOM was gone. Props update in place. The transcript
 * mounts when the session does, and stays while focus moves around it.
 */
function PaneBranch(props: { node: PaneNode }) {
  const leaf = () => (props.node.kind === "leaf" ? props.node : undefined);
  return (
    <Show when={leaf()} fallback={<PaneSplitView node={props.node as PaneSplit} />}>
      {(item) => <PaneLeafView leaf={item()} />}
    </Show>
  );
}

export function PaneStage(props: {
  workspace: PaneWorkspaceState;
  sessions: readonly SessionRowSummary[];
  /** Single mode: the route's transcript, with no pane around it. */
  renderFocusedTranscript: () => JSX.Element;
  /** Multiplex: one transcript per pane, mounted for as long as that session stays there. */
  renderTranscript: (sessionId: string, paneId: string) => JSX.Element;
  onFocusPane: (paneId: string, sessionId: string | null) => void;
  onSelectPaneSession: (paneId: string, sessionId: string) => void;
  onSplitPane: (paneId: string, dir: SplitDir) => void;
  onClosePane: (paneId: string) => void;
  onToggleZoom: (paneId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
}) {
  const api: StageApi = {
    workspace: () => props.workspace,
    sessions: () => props.sessions,
    renderTranscript: (sessionId, paneId) => props.renderTranscript(sessionId, paneId),
    onFocusPane: (paneId, sessionId) => props.onFocusPane(paneId, sessionId),
    onSelectPaneSession: (paneId, sessionId) => props.onSelectPaneSession(paneId, sessionId),
    onSplitPane: (paneId, dir) => props.onSplitPane(paneId, dir),
    onClosePane: (paneId) => props.onClosePane(paneId),
    onToggleZoom: (paneId) => props.onToggleZoom(paneId),
    onResizeSplit: (splitId, ratio) => props.onResizeSplit(splitId, ratio),
  };
  return (
    <StageApiContext.Provider value={api}>
      <Show when={props.workspace.mode === "multiplex"} fallback={props.renderFocusedTranscript()}>
        <div class="flex min-h-[30vh] min-w-0 flex-1 flex-col overflow-hidden p-2.5">
          {/* The gutter between panes had no counterpart at the outside edge, so
              the outermost panes were welded to the window while the inner ones
              had a channel between them. The same 2.5 padding all round puts the
              group of panes on one field, which is also what lets the corners be
              rounded: there is now background visible outside the corner for the
              radius to be cut against.
              Zoom does not mount a second leaf on top of this one. The zoomed
              pane is the same section, taken out of the split and stretched
              over this box; the others stay mounted and hidden. */}
          <div
            class="group/stage relative flex min-h-0 min-w-0 flex-1 flex-col"
            data-zoomed={props.workspace.zoomedPaneId ? "" : undefined}
          >
            <PaneBranch node={props.workspace.root} />
          </div>
        </div>
      </Show>
    </StageApiContext.Provider>
  );
}
