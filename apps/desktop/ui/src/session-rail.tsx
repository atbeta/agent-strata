import { createEffect, createMemo, createResource, createSignal, ErrorBoundary, on, onCleanup, Show } from "solid-js";
import {
  readVcsDiff,
  realWorkspace,
  type SessionView,
  type VcsInfo,
} from "./api";
import { BackgroundPanel } from "./background-panel";
import { PluginPanel, isPluginPanelTab, panelForTab, pluginPanelTabs } from "./plugin-panel";
import { pluginsLoaded, pluginsReadFailed } from "./plugin-registry";
import type { DevProcesses } from "./dev-processes";
import type { SchedulesController } from "./use-schedules";
import { t } from "./i18n";
import { FileBrowser } from "./files";
import { ReviewPane } from "./review";
import { clampRailWidth, railWidthLimit, readRailWidth, writeRailWidth, RAIL_MIN } from "./rail-width";
import { inDesktopShell } from "./shell";
import type { SidePanelTab } from "./right-pane";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon, type Name } from "./icons";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { RailLauncher, type RailLauncherItem } from "./rail-launcher";
import { SessionChangesPanel } from "./session-changes-panel";

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
  /** schedules shared with the composer, whether or not this rail is open */
  schedules: SchedulesController;
  /** live repo state, read once by the parent for its branch chip */
  vcs: () => VcsInfo | undefined;
}) {
  const [launcherOpen, setLauncherOpen] = createSignal(false);
  const [openFile, setOpenFile] = createSignal<string | null>(null);
  const [reviewSource, setReviewSource] = createSignal<"session" | "git" | "branch">("session");
  const defaultBranch = () => props.vcs()?.default_branch ?? undefined;
  /** "branch" presumes a default branch exists; absent one it answers as "git". */
  const effectiveSource = () => (reviewSource() === "branch" && !defaultBranch() ? "git" : reviewSource());
  const [reviewLayout, setReviewLayout] = createSignal<"unified" | "split">("unified");

  /**
   * The rail's width belongs to the reader, not to the panel.
   *
   * Only the reader moves it — the drag edge below, or the arrow keys. The
   * available column clamps the visible width without replacing the saved one.
   */
  let observer: ResizeObserver | undefined;
  let container: HTMLElement | undefined;
  let railEl: HTMLElement | undefined;
  const [availableWidth, setAvailableWidth] = createSignal(window.innerWidth);
  const [preferredWidth, setPreferredWidth] = createSignal(readRailWidth(window.innerWidth));
  const railWidth = createMemo(() => clampRailWidth(preferredWidth(), availableWidth()));
  const measure = () => setAvailableWidth(container?.clientWidth || window.innerWidth);
  const bindRail = (el: HTMLElement) => {
    railEl = el;
    queueMicrotask(() => {
      if (railEl !== el) return;
      container = el.parentElement ?? undefined;
      if (!container) return;
      measure();
      observer?.disconnect();
      observer = new ResizeObserver(measure);
      observer.observe(container);
    });
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

  /** Only repo sources need a backend read; session changes live in the view. */
  const reviewKey = () => {
    const source = effectiveSource();
    if (!props.opencode() || source === "session") return false as const;
    return { id: props.sessionId(), source };
  };
  const [reviewDiff, { refetch: refetchReview }] = createResource(reviewKey, (key) => readVcsDiff(key.id, key.source));

  const effectiveTab = (): SidePanelTab => {
    if (!props.opencode()) return "changes";
    const chosen = props.tab();
    if (
      chosen.startsWith("plugin:") &&
      !isPluginPanelTab(chosen) &&
      (pluginsLoaded() || pluginsReadFailed())
    ) {
      return "changes";
    }
    return chosen;
  };

  const changeCount = () =>
    !props.opencode() || effectiveSource() === "session"
      ? props.view().files_changed.length
      : (reviewDiff() ?? []).filter((file) => file.file).length;
  const files = () => props.view().files_changed;
  const emptyNote = () =>
    effectiveSource() === "branch"
      ? t("review.empty.branch", { branch: defaultBranch() ?? "HEAD" })
      : t("review.empty.git");

  const builtinItems = createMemo<RailLauncherItem[]>(() => [
    { id: "changes", label: t("panel.changes"), icon: "branch", count: changeCount() },
    { id: "files", label: t("panel.files"), icon: "files" },
    { id: "background", label: t("panel.background"), icon: "terminal", running: props.dev.count() },
  ]);
  const pluginItems = createMemo<RailLauncherItem[]>(() =>
    pluginPanelTabs().map((tab) => ({
      id: tab.id,
      label: tab.label,
      icon: (tab.panel.icon ?? "plug") as Name,
    })),
  );
  const currentItem = () => [...builtinItems(), ...pluginItems()].find((item) => item.id === effectiveTab());
  const currentTitle = () => currentItem()?.label ?? t("panel.changes");
  const currentIcon = () => currentItem()?.icon ?? "branch";
  const currentCount = () => {
    if (effectiveTab() === "changes") return changeCount();
    if (effectiveTab() === "background") return props.dev.count();
    return undefined;
  };
  const panelOptions = createMemo(() =>
    [...builtinItems(), ...pluginItems()].map((item) => ({
      id: item.id,
      label: item.label,
      count: item.count ?? item.running,
    })),
  );
  const selectPanel = (id: string) => {
    props.onSelectTab(id);
    setLauncherOpen(false);
  };
  createEffect(on(props.tab, () => setLauncherOpen(false)));
  createEffect(on(props.sessionId, () => {
    setLauncherOpen(false);
    setOpenFile(null);
  }));
  createEffect(on(props.open, (open) => {
    if (open) setLauncherOpen(false);
  }));

  // The exit animation needs the aside to outlive the close: `present` holds
  // the mount for the fade while the chrome state already answers as closed.
  const [present, setPresent] = createSignal(props.open());
  const [leaving, setLeaving] = createSignal(false);
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (props.open()) {
      if (exitTimer !== undefined) clearTimeout(exitTimer);
      exitTimer = undefined;
      setLeaving(false);
      setPresent(true);
    } else if (present()) {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setPresent(false);
        return;
      }
      setLeaving(true);
      exitTimer = setTimeout(() => {
        exitTimer = undefined;
        setPresent(false);
        setLeaving(false);
      }, 130);
    }
  });
  onCleanup(() => {
    if (exitTimer !== undefined) clearTimeout(exitTimer);
  });

  return (
    <Show when={present()}>
      <aside
        ref={bindRail}
        class={`relative flex shrink-0 flex-col border-l border-border ${leaving() ? "rail-out" : "rail-in"}`}
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
          class="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2 select-none"
          data-tauri-drag-region={inDesktopShell() ? "" : undefined}
        >
          <Show when={props.opencode()}>
            <Button
              type="button"
              size="icon-sm"
              variant="icon"
              aria-label={launcherOpen() ? t("panel.back") : t("panel.switch")}
              onClick={() => setLauncherOpen(!launcherOpen())}
            >
              <Icon name={launcherOpen() ? "arrow-left" : "grid"} />
            </Button>
          </Show>
          <div class="flex min-w-0 flex-1 items-center gap-2 px-1">
            <Show when={!launcherOpen() || !props.opencode()} fallback={<span class="text-sm font-medium">{t("panel.launcher")}</span>}>
              <Icon name={currentIcon()} class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 truncate text-sm font-medium">{currentTitle()}</span>
              <Show when={(currentCount() ?? 0) > 0}>
                <span class="shrink-0 text-2xs font-normal text-muted-foreground tabular-nums">{currentCount()}</span>
              </Show>
            </Show>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="icon"
            aria-label={t("panel.hide")}
            onClick={props.onClose}
          >
            <Icon name="x" />
          </Button>
        </div>
        <Show when={props.opencode() && !launcherOpen()}>
          <div class="flex shrink-0 border-b border-border px-2 py-1">
            <MiniTabs
              kind="tabs"
              label={t("panel.switch")}
              panelId="session-rail-panel"
              value={effectiveTab()}
              onChange={selectPanel}
              options={panelOptions()}
              class="min-w-0 flex-1 overflow-x-auto"
            />
          </div>
        </Show>
        <Show
          when={!launcherOpen() || !props.opencode()}
          fallback={<RailLauncher builtin={builtinItems()} plugins={pluginItems()} onSelect={selectPanel} />}
        >
          <div
            id="session-rail-panel"
            role={props.opencode() ? "tabpanel" : "region"}
            aria-label={currentTitle()}
            class="flex min-h-0 flex-1 flex-col"
          >
            <Show when={props.sessionId()} keyed>
              <Show when={effectiveTab() === "files"}>
                <FileBrowser
                  sessionId={props.sessionId()}
                  workspace={() => realWorkspace(props.view().workspace)}
                  focus={props.pathFocus}
                />
              </Show>
              <Show when={effectiveTab().startsWith("plugin:") && !pluginsLoaded() && !pluginsReadFailed()}>
                <EmptyState icon="plug" class="flex-1" title={t("panel.plugin.waiting")} />
              </Show>
              <ErrorBoundary
                fallback={(err, reset) => (
                  <EmptyState
                    icon="alert"
                    tone="danger"
                    class="flex-1"
                    title={t("panel.plugin.crashed")}
                    description={err instanceof Error ? err.message : String(err)}
                    action={<Button variant="outline" size="sm" onClick={reset}>{t("panel.plugin.retry")}</Button>}
                  />
                )}
              >
                <Show when={panelForTab(effectiveTab())}>
                  {(panel) => (
                    <PluginPanel panel={panel()} sessionId={props.sessionId} schedules={props.schedules} />
                  )}
                </Show>
              </ErrorBoundary>
              <Show when={effectiveTab() === "background"}>
                <BackgroundPanel
                  processes={props.dev.processes}
                  onStop={props.dev.stop}
                  onDelete={props.dev.forget}
                  onRetry={() => void props.dev.refetch()}
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
                        class="min-w-0 flex-1 overflow-x-auto"
                      />
                      <Show when={effectiveSource() !== "session"}>
                        <MiniTabs
                          kind="radio"
                          label={t("review.layout")}
                          value={reviewLayout()}
                          onChange={(id) => setReviewLayout(id as "unified" | "split")}
                          options={[
                            { id: "unified", label: t("review.unified") },
                            { id: "split", label: t("review.split") },
                          ]}
                          class="ml-2 shrink-0"
                        />
                      </Show>
                    </div>
                  </Show>
                  <Show when={props.opencode() && effectiveSource() !== "session"}>
                    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                      <Show
                        when={!reviewDiff.loading && !reviewDiff.error}
                        fallback={
                          <Show
                            when={reviewDiff.error}
                            fallback={<EmptyState icon="branch" class="flex-1" title={t("review.loading")} />}
                          >
                            <EmptyState
                              icon="alert"
                              tone="danger"
                              class="flex-1"
                              title={t("review.failed")}
                              description={reviewDiff.error instanceof Error ? reviewDiff.error.message : String(reviewDiff.error)}
                              action={<Button variant="outline" size="sm" onClick={() => void refetchReview()}>{t("panel.plugin.retry")}</Button>}
                            />
                          </Show>
                        }
                      >
                        <Show
                          when={(reviewDiff() ?? []).some((file) => file.file)}
                          fallback={<EmptyState icon="branch" class="flex-1" title={emptyNote()} />}
                        >
                          <ReviewPane files={reviewDiff() ?? []} layout={reviewLayout()} onComment={props.onCite} />
                        </Show>
                      </Show>
                    </div>
                  </Show>
                  <Show when={!props.opencode() || effectiveSource() === "session"}>
                    <SessionChangesPanel
                      files={files}
                      openFile={openFile}
                      onOpenFile={setOpenFile}
                      onJumpToTurn={props.onJumpToTurn}
                    />
                  </Show>
                </div>
              </Show>
            </Show>
          </div>
        </Show>
      </aside>
    </Show>
  );
}
