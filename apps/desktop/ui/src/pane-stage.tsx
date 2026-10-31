import { For, Show, createSignal, type JSX } from "solid-js";
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
        <Show when={status() && showsMark(status()!)}>
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
      aria-orientation={props.dir === "row" ? "vertical" : "horizontal"}
      aria-label={t("pane.resize")}
      onPointerDown={startDrag}
      onDblClick={() => props.onResize(RATIO_DEFAULT)}
      class={
        props.dir === "row"
          ? "group relative z-10 flex w-2.5 shrink-0 cursor-col-resize items-stretch justify-center select-none"
          : "group relative z-10 flex h-2.5 shrink-0 cursor-row-resize items-center justify-center select-none"
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

export function PaneStage(props: {
  workspace: PaneWorkspaceState;
  sessions: readonly SessionRowSummary[];
  /**
   * The session `renderFocusedTranscript` currently renders — the one the route
   * is on. Focus and this are two different clocks: focusing a pane lands this
   * frame, the hash behind it lands the next.
   */
  transcriptSessionId: string;
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
        class={`relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border transition-colors ${
          // Focus is stated by the whole rectangle, not by a mark inside it. The
          // rail it replaces was twenty pixels of accent beside a title, on a
          // band twenty-eight tall — an invitation to go and inspect the header
          // of a pane that is half a screen. The frame is the signal instead: an
          // edge the length of the pane, over a surface stepped once across all
          // of it. Twenty pixels versus a thousand is the whole difference
          // between a mark and a region.
          //
          // The unfocused state used to be `bg-background/60`, which over a
          // `bg-background` parent composites to exactly `bg-background`. The
          // panes were not subtle, they were identical.
          //
          // The border is always present and only its colour moves, so a pane
          // does not shift a pixel every time it takes focus.
          //
          // The unfocused border used to be transparent, which made a pane
          // boundary you could only find by looking for the one hairline
          // between two identical surfaces. It is `border-border` now: the same
          // 8%-white rule the rest of the app uses for every edge it needs to
          // state. Unfocused reads as a rectangle, focused reads as the same
          // rectangle outlined in accent — so the count is legible whether or
          // not you care which one has focus.
          //
          // `rounded-md` because a pane is now an object sitting on a field
          // rather than a region cut out of the window: with the padding outside
          // it there is background for a radius to be cut against, and the
          // rounded corner is what tells the eye this is a card rather than a
          // seam. `overflow-hidden` above already clips the header's own
          // square corner to it.
          isFocused() ? "border-primary/45 bg-secondary/45" : "border-border bg-background"
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
              // Focus alone was not enough to be told to swap renderers. The
              // focused transcript is bound to the session on the route, and the
              // route is a hash: `focusPane` lands this frame, `hashchange` lands
              // the next one. In that gap the pane you had just clicked rendered
              // the transcript of the pane you had just left — the other
              // conversation flashing through, then correcting itself.
              //
              // So it waits for the session it is actually bound to. Until the
              // route catches up this pane keeps its own peer transcript, which
              // is its own session anyway: what is on screen is right at every
              // frame, and the swap is between two renderings of one
              // conversation rather than a detour through another.
              when={isFocused() && sid() === props.transcriptSessionId}
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
      <div class="flex min-h-[30vh] min-w-0 flex-1 flex-col overflow-hidden p-2.5">
        {/* The gutter between panes had no counterpart at the outside edge, so
            the outermost panes were welded to the window while the inner ones
            had a channel between them. The same 2.5 padding all round puts the
            group of panes on one field, which is also what lets the corners be
            rounded: there is now background visible outside the corner for the
            radius to be cut against. */}
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
