import { createResource, createSignal, For, Show } from "solid-js";
import {
  readSessionDiff,
  readVcsDiff,
  type SessionView,
} from "./api";
import { Icon } from "./icons";
import { num, t, tn } from "./i18n";
import { Tip } from "./tip";
import { DiffBlock } from "./diff";
import { FileBrowser } from "./files";
import { ReviewPane } from "./review";
import { clampRailWidth, readRailWidth, writeRailWidth, RAIL_MAX, RAIL_MIN } from "./rail-width";
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
  /** the reader asked for the rail — collapsed shows only the edge strip */
  open: () => boolean;
  tab: () => SidePanelTab;
  onSelectTab: (tab: SidePanelTab) => void;
  onClose: () => void;
  /** scroll the transcript to a turn index, -1 leaves it alone */
  onJumpToTurn: (turnIndex: number) => void;
  /** drop a review comment into the composer draft */
  onCite: (note: string) => void;
}) {
  /** which file the reader opened in the rail, null for the plain list */
  const [openFile, setOpenFile] = createSignal<string | null>(null);
  const [reviewSource, setReviewSource] = createSignal<"session" | "git">("session");
  const [reviewLayout, setReviewLayout] = createSignal<"unified" | "split">("unified");

  /**
   * The rail's width belongs to the reader, not to the tab.
   *
   * It was `w-72` on one tab and `min(600px, 48vw)` on the rest, so every tab
   * click resized the panel and re-wrapped the transcript beside it. Only the
   * reader moves it now — the drag edge below, or the arrow keys — and the
   * window only ever clamps it.
   */
  const [railWidth, setRailWidth] = createSignal(readRailWidth(window.innerWidth));
  const resizeRail = (px: number, remember: boolean) => {
    const next = clampRailWidth(px, window.innerWidth);
    setRailWidth(next);
    if (remember) writeRailWidth(next);
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

  const reviewKey = () => {
    if (!props.opencode()) return false as const;
    return { id: props.sessionId(), source: reviewSource() };
  };
  const [reviewDiff] = createResource(reviewKey, (key) =>
    key.source === "git" ? readVcsDiff(key.id, "git") : readSessionDiff(key.id),
  );

  // The file browser only exists for the OpenCode backend.
  const effectiveTab = (): SidePanelTab => (props.opencode() ? props.tab() : "changes");

  /**
   * How many files the changes view actually found. The rail header wears it
   * while open; the collapsed edge strip wears the same number while closed,
   * so the rail advertises what it holds before it takes any room.
   */
  const changeCount = () =>
    props.opencode()
      ? (reviewDiff() ?? []).filter((f) => f.file).length
      : (props.view().files_changed.length ?? 0);

  const files = () => props.view().files_changed;
  /** An empty diff reads differently per baseline, so it says which. */
  const emptyNote = () => t(reviewSource() === "git" ? "review.empty.git" : "review.empty");
  // The list of names is worthless at 288px next to a real diff, so the
  // panel borrows room only while a reader is actually reading one.
  const open = () => files().find((f) => f.path === openFile()) ?? null;
  const toggleFile = (path: string) => setOpenFile(openFile() === path ? null : path);

  return (
    <Show when={props.open()}>
      <aside
        class="relative flex shrink-0 flex-col border-l border-border"
        style={{ width: `${railWidth()}px` }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("rail.resize")}
          aria-valuemin={RAIL_MIN}
          aria-valuemax={RAIL_MAX}
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
          class="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 select-none"
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
              value={effectiveTab()}
              onChange={(id) => props.onSelectTab(id as "changes" | "files")}
              options={[
                { id: "changes", label: t("panel.changes"), count: changeCount() },
                { id: "files", label: t("panel.files") },
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
        <Show when={effectiveTab() === "files"}>
          <FileBrowser sessionId={props.sessionId()} />
        </Show>
        <Show when={effectiveTab() === "changes"}>
          <div class="flex min-h-0 flex-1 flex-col">
            <Show when={props.opencode()}>
              <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
              <MiniTabs
                kind="radio"
                label={t("panel.changes")}
                value={reviewSource()}
                onChange={(id) => setReviewSource(id as "session" | "git")}
                options={[
                  { id: "session", label: t("review.session") },
                  { id: "git", label: t("review.git") },
                ]}
                class="shrink-0"
              />
              </div>
            </Show>
            <Show when={props.opencode()}>
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
            <Show when={!props.opencode()}>
              <div class="flex min-h-0 flex-1">
                <div
                  class={`min-h-0 overflow-x-hidden overflow-y-auto px-2 py-3 ${
                    open() ? "w-44 shrink-0 border-r border-border" : "w-full px-3"
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
                              class={`items-baseline gap-2 px-1 py-1 hover:bg-secondary ${
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
                                <span class="rounded bg-secondary px-1.5 py-0.5 text-2xs text-muted-foreground">
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
                                    class="ml-auto shrink-0 rounded px-1.5"
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
      </aside>
    </Show>
  );
}
