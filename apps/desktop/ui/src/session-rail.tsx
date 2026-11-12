import { createMemo, createResource, createSignal, ErrorBoundary, For, onCleanup, Show } from "solid-js";
import {
  readVcsDiff,
  realWorkspace,
  type SessionView,
  type VcsInfo,
} from "./api";
import { BackgroundPanel } from "./background-panel";
import { PluginPanel, isPluginPanelTab, panelForTab, pluginPanelTabs } from "./plugin-panel";
import type { DevProcesses } from "./dev-processes";
import { num, t, tn } from "./i18n";
import { DiffBlock } from "./diff";
import { FileBrowser } from "./files";
import { ReviewPane } from "./review";
import { clampRailWidth, railWidthLimit, readRailWidth, writeRailWidth, RAIL_MIN } from "./rail-width";
import { inDesktopShell } from "./shell";
import type { SidePanelTab } from "./right-pane";
import { Button } from "@/components/ui/button";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { RowButton } from "@/components/ui/row-button";

function fileName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || path;
}

/** How a file changed. The wire values are `add`/`modify`/`delete`; these are labels. */
function changeWord(change: string): string {
  if (change === "add") return t("file.added");
  if (change === "delete") return t("file.deleted");
  return t("file.edited");
}

export function SessionRail(props: {
  sessionId: () => string;
  /** the settled view; the rail only renders once the transcript exists */
  view: () => SessionView;
  opencode: () => boolean;
  /** whether the reader asked for the rail */
  open: () => boolean;
  tab: () => SidePanelTab;
  onSelectTab: (tab: SidePanelTab) => void;
  onClose: () => void;
  /** scroll the transcript to a turn index, -1 leaves it alone */
  onJumpToTurn: (turnIndex: number) => void;
  /** drop a review comment into the composer draft */
  onCite: (note: string) => void;
  /** a transcript path the reader clicked — focus it in the files tab */
  pathFocus?: () => { path: string; n: number } | undefined;
  /** the session's background commands, shared with the composer's pill */
  dev: DevProcesses;
  /** live repo state, read once by the parent for its branch chip */
  vcs: () => VcsInfo | undefined;
}) {
  /** which file the reader opened in the rail, null for the plain list */
  const [openFile, setOpenFile] = createSignal<string | null>(null);
  const [reviewSource, setReviewSource] = createSignal<"session" | "git" | "branch">("session");
  const defaultBranch = () => props.vcs()?.default_branch ?? undefined;
  /** "branch" presumes a default branch exists; absent one it answers as "git". */
  const effectiveSource = () => (reviewSource() === "branch" && !defaultBranch() ? "git" : reviewSource());
  const [reviewLayout, setReviewLayout] = createSignal<"unified" | "split">("unified");

  /**
   * The rail's width belongs to the reader, not to the tab.
   *
   * It was `w-72` on one tab and `min(600px, 48vw)` on the rest, so every tab
   * click resized the panel and re-wrapped the transcript beside it. Only the
   * reader moves it now — the drag edge below, or the arrow keys. The available
   * column only clamps the visible width, leaving the saved preference intact.
   */
  let observer: ResizeObserver | undefined;
  let container: HTMLElement | undefined;
  const [availableWidth, setAvailableWidth] = createSignal(window.innerWidth);
  const [preferredWidth, setPreferredWidth] = createSignal(readRailWidth(window.innerWidth));
  const railWidth = createMemo(() => clampRailWidth(preferredWidth(), availableWidth()));
  const measure = () => setAvailableWidth(container?.clientWidth || window.innerWidth);
  const bindRail = (el: HTMLElement) => {
    container = el.parentElement ?? undefined;
    if (!container) return;
    measure();
    observer?.disconnect();
    observer = new ResizeObserver(measure);
    observer.observe(container);
  };
  window.addEventListener("resize", measure);
  onCleanup(() => {
    observer?.disconnect();
    window.removeEventListener("resize", measure);
  });
  const resizeRail = (px: number, remember: boolean) => {
    setPreferredWidth(px);
    if (remember) writeRailWidth(railWidth());
  };
  const startRailDrag = (e: PointerEvent & { currentTarget: HTMLDivElement }) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const from = e.clientX;
    const was = railWidth();
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => resizeRail(was + (from - ev.clientX), false);
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      writeRailWidth(railWidth());
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  };

  /**
   * "本会话" needs no fetch — its record is the view's own files_changed,
   * which is also what non-OpenCode sessions already drew. OpenCode's
   * /session/diff answered [] unconditionally without a messageID, which is
   * why the tab read empty; only the two repo sources still ask the backend.
   */
  const reviewKey = () => {
    const source = effectiveSource();
    if (!props.opencode() || source === "session") return false as const;
    return { id: props.sessionId(), source };
  };
  const [reviewDiff] = createResource(reviewKey, (key) => readVcsDiff(key.id, key.source));

  // The file browser only exists for the OpenCode backend.
  const effectiveTab = (): SidePanelTab => {
    if (!props.opencode()) return "changes";
    // A panel tab whose plugin was disabled since the reader picked it would
    // otherwise leave the rail blank; fall back to the builtin tab.
    const chosen = props.tab();
    if (chosen.startsWith("plugin:") && !isPluginPanelTab(chosen)) return "changes";
    return chosen;
  };

  /**
   * How many files the visible pane actually found. The rail outlives a
   * session switch and `reviewSource` keeps its last pick, so a non-OpenCode
   * session inherits "git" or "branch" — conditions on the backend, not the
   * stale source, are what keep the session pane and its count reachable.
   */
  const changeCount = () =>
    !props.opencode() || effectiveSource() === "session"
      ? props.view().files_changed.length
      : (reviewDiff() ?? []).filter((f) => f.file).length;

  const files = () => props.view().files_changed;
  /** An empty diff reads differently per baseline, so it says which. */
  const emptyNote = () =>
    effectiveSource() === "branch"
      ? t("review.empty.branch", { branch: defaultBranch() ?? "HEAD" })
      : t("review.empty.git");
  // A selected file borrows room only while it is open; below 560px its list
  // stacks above the diff instead of crushing it into a narrow column.
  const open = () => files().find((f) => f.path === openFile()) ?? null;
  const toggleFile = (path: string) => setOpenFile(openFile() === path ? null : path);

  return (
    <Show when={props.open()}>
      <aside
        ref={bindRail}
        class="relative flex shrink-0 flex-col border-l border-border"
        style={{ width: `${railWidth()}px` }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("rail.resize")}
          aria-valuemin={RAIL_MIN}
          aria-valuemax={railWidthLimit(availableWidth())}
          aria-valuenow={railWidth()}
          tabindex={0}
          class="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none focus-visible:bg-ring/40"
          onPointerDown={startRailDrag}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 48 : 16;
            if (e.key === "ArrowLeft") resizeRail(railWidth() + step, true);
            else if (e.key === "ArrowRight") resizeRail(railWidth() - step, true);
            else return;
            e.preventDefault();
          }}
        />
        <div
          class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 select-none"
          data-tauri-drag-region={inDesktopShell() ? "" : undefined}
        >
          <Show
            when={props.opencode()}
            fallback={
              <span class="min-w-0 flex-1 truncate text-sm font-medium">
                {t("panel.changes")}
                <Show when={changeCount() > 0}>
                  <span class="ml-1 text-2xs font-normal text-muted-foreground">{changeCount()}</span>
                </Show>
              </span>
            }
          >
            <MiniTabs
              kind="tabs"
              label={t("panel.show")}
              panelId="session-rail-panel"
              value={effectiveTab()}
              onChange={(id) => props.onSelectTab(id as SidePanelTab)}
              options={[
                { id: "changes", label: t("panel.changes"), count: changeCount() },
                { id: "files", label: t("panel.files") },
                { id: "background", label: t("panel.background"), count: props.dev.count() },
                // A panel a plugin contributed, appended in the order the
                // plugins were registered. The tab id carries the plugin, so
                // the body does not have to guess which one it is.
                ...pluginPanelTabs().map((tab) => ({ id: tab.id, label: tab.label })),
              ]}
              class="min-w-0 flex-1"
            />
          </Show>
          <Button
            type="button"
            size="icon-sm"
            variant="icon"
            aria-label={t("panel.hide")}
            onClick={props.onClose}
          >
            ×
          </Button>
        </div>
        <div
          id="session-rail-panel"
          role={props.opencode() ? "tabpanel" : undefined}
          aria-labelledby={props.opencode() ? `session-rail-panel-tab-${effectiveTab()}` : undefined}
          class="flex min-h-0 flex-1 flex-col"
        >
        <Show when={effectiveTab() === "files"}>
          <FileBrowser
            sessionId={props.sessionId()}
            workspace={() => realWorkspace(props.view().workspace)}
            focus={props.pathFocus}
          />
        </Show>
        {/* A panel that throws must not take the rail with it: without a
            boundary an error inside one plugin's panel leaves the tabs beside
            it unable to change anything, which reads as the whole rail having
            frozen. The reader gets a message and a retry instead. */}
        <ErrorBoundary
          fallback={(err, reset) => (
            <div class="flex flex-col items-start gap-2 p-3 text-xs text-muted-foreground">
              <p class="text-destructive">{t("panel.plugin.crashed")}</p>
              <p class="max-h-24 overflow-auto break-words font-mono text-2xs">
                {err instanceof Error ? err.message : String(err)}
              </p>
              <Button variant="outline" size="sm" onClick={reset}>
                {t("panel.plugin.retry")}
              </Button>
            </div>
          )}
        >
          <Show when={panelForTab(effectiveTab())}>
            {(panel) => <PluginPanel panel={panel()} sessionId={props.sessionId} />}
          </Show>
        </ErrorBoundary>
        <Show when={effectiveTab() === "background"}>
          <BackgroundPanel
            processes={() => props.dev.processes() ?? []}
            onStop={props.dev.stop}
            onDelete={props.dev.forget}
          />
        </Show>
        <Show when={effectiveTab() === "changes"}>
          <div class="flex min-h-0 flex-1 flex-col">
            <Show when={props.opencode()}>
              <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
              <MiniTabs
                kind="radio"
                label={t("panel.changes")}
                value={effectiveSource()}
                onChange={(id) => setReviewSource(id as "session" | "git" | "branch")}
                options={[
                  { id: "session", label: t("review.session") },
                  { id: "git", label: t("review.git") },
                  ...(defaultBranch()
                    ? [{ id: "branch", label: t("review.branch", { branch: defaultBranch()! }) }]
                    : []),
                ]}
                class="shrink-0"
              />
              </div>
            </Show>
            <Show when={props.opencode() && effectiveSource() !== "session"}>
              <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                <Show
                  when={!reviewDiff.loading && !reviewDiff.error}
                  fallback={
                    <p class={`px-3 py-3 text-xs ${reviewDiff.error ? "text-destructive" : "text-muted-foreground"}`}>
                      {reviewDiff.error
                        ? reviewDiff.error instanceof Error
                          ? reviewDiff.error.message
                          : String(reviewDiff.error)
                        : t("review.loading")}
                    </p>
                  }
                >
                  <Show
                    when={(reviewDiff() ?? []).some((f) => f.file)}
                    fallback={<p class="px-3 py-3 text-xs text-muted-foreground">{emptyNote()}</p>}
                  >
                    <ReviewPane
                      files={reviewDiff() ?? []}
                      layout={reviewLayout()}
                      onLayout={setReviewLayout}
                      onComment={props.onCite}
                    />
                  </Show>
                </Show>
              </div>
            </Show>
            <Show when={!props.opencode() || effectiveSource() === "session"}>
              <div class="@container flex min-h-0 flex-1 flex-col @min-[560px]:flex-row">
                <div
                  class={`min-h-0 overflow-x-hidden overflow-y-auto px-2 py-3 ${
                    open()
                      ? "max-h-[40%] shrink-0 border-b border-border @min-[560px]:max-h-none @min-[560px]:w-44 @min-[560px]:border-b-0 @min-[560px]:border-r"
                      : "w-full px-3"
                  }`}
                >
                  <Show
                    when={files().length > 0}
                    fallback={<p class="px-1 text-xs text-muted-foreground">{t("rail.nothing")}</p>}
                  >
                    <ul class="space-y-0.5">
                      <For each={files()}>
                        {(f) => (
                          <li>
                            <RowButton
                              aria-expanded={openFile() === f.path}
                              onClick={() => toggleFile(f.path)}
                              title={f.path}
                              class={`items-baseline gap-2 px-1 py-1 ${
                                openFile() === f.path ? "bg-secondary" : ""
                              }`}
                            >
                              <span
                                class={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                  f.change === "add"
                                    ? "bg-status-active"
                                    : f.change === "delete"
                                      ? "bg-status-error"
                                      : "bg-status-completed"
                                }`}
                                title={changeWord(f.change)}
                              />
                              <span class="min-w-0 flex-1">
                                <span class="block truncate text-sm">{fileName(f.path)}</span>
                                {/* The word for the change lived here as well as on
                                    the dot. It stays on the dot, where the colour
                                    is, and this line keeps only the one number
                                    that is not already encoded. */}
                                <Show when={f.count > 1}>
                                  <span class="block truncate text-2xs text-muted-foreground">
                                    {tn("file.changes", f.count)}
                                  </span>
                                </Show>
                              </span>
                              {/* ≥ because a change nothing explained leaves its lines uncounted */}
                              <span
                                class="shrink-0 font-mono text-2xs"
                                title={f.unexplained ? t("file.partial") : undefined}
                              >
                                <span class="text-diff-add-fg">
                                  {f.unexplained ? "≥+" : "+"}
                                  {num(f.additions)}
                                </span>{" "}
                                <span class="text-diff-del-fg">−{num(f.deletions)}</span>
                              </span>
                            </RowButton>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
                <Show when={open()}>
                  {(f) => (
                    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                      <div class="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
                        <span class="min-w-0 flex-1 font-mono text-2xs break-all text-muted-foreground">
                          {f().path}
                        </span>
                        <Button
                          type="button"
                          variant="icon"
                          size="xs"
                          class="shrink-0 px-1.5"
                          onClick={() => setOpenFile(null)}
                        >
                          {t("file.close")}
                        </Button>
                      </div>
                      <div class="min-h-0 flex-1 overflow-x-auto overflow-y-auto px-3 py-2">
                        <Show when={f().unexplained}>
                          <p class="mb-2 rounded-md bg-secondary/60 px-2 py-1.5 text-2xs text-muted-foreground">
                            {tn("file.hidden", f().edits.filter((e) => !e.diff).length)}
                          </p>
                        </Show>
                        <For each={f().edits}>
                          {(edit) => (
                            <section class="mb-3 last:mb-0">
                              <div class="sticky left-0 mb-1 flex w-max items-center gap-2 bg-background">
                                <span class="rounded-sm bg-secondary px-1.5 py-0.5 text-2xs text-muted-foreground">
                                  {edit.whole_file ? t("file.whole") : t("file.region")}
                                </span>
                                <span class="font-mono text-2xs">
                                  <span class="text-diff-add-fg">+{num(edit.additions)}</span>{" "}
                                  <span class="text-diff-del-fg">−{num(edit.deletions)}</span>
                                </span>
                                <Show when={edit.turn_index >= 0}>
                                  <Button
                                    type="button"
                                    variant="icon"
                                    size="xs"
                                    class="ml-auto shrink-0 rounded-sm px-1.5"
                                    onClick={() => props.onJumpToTurn(edit.turn_index)}
                                  >
                                    {t("file.jump")}
                                  </Button>
                                </Show>
                              </div>
                              <Show
                                when={edit.diff}
                                fallback={
                                  <p class="rounded-md bg-secondary/60 px-2 py-1.5 text-2xs text-muted-foreground">
                                    {t("file.noDiff")}
                                  </p>
                                }
                              >
                                <DiffBlock patch={edit.diff!} />
                              </Show>
                            </section>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        </Show>
        </div>
      </aside>
    </Show>
  );
}
