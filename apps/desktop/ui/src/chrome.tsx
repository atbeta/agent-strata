import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { inDesktopShell, usesCustomCaption } from "./shell";

type WindowHandle = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
};

let windowPromise: Promise<WindowHandle> | undefined;

/** Width the drawn caption reserves: 44px + 44px + 48px. */
const CAPTION_W = 136;

function desktopWindow(): Promise<WindowHandle> {
  windowPromise ??= import("@tauri-apps/api/window").then((mod) => mod.getCurrentWindow());
  return windowPromise;
}

/** Minimize, maximize, and close. Only the frameless Windows shell draws these. */
export function CaptionButtons() {
  const [maximized, setMaximized] = createSignal(false);

  onMount(() => {
    if (!usesCustomCaption()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void desktopWindow().then(async (win) => {
      if (cancelled) return;
      setMaximized(await win.isMaximized());
      stop = await win.onResized(() => {
        void win.isMaximized().then(setMaximized);
      });
    });
    onCleanup(() => {
      cancelled = true;
      stop?.();
    });
  });

  const run = (fn: (win: WindowHandle) => Promise<void>) => {
    void desktopWindow().then(fn);
  };

  return (
    <Show when={usesCustomCaption()}>
      <div class="flex h-full shrink-0">
        <button
          type="button"
          class="grid h-full w-11 place-items-center text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => run((win) => win.minimize())}
        >
          <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M2 6h8" />
          </svg>
        </button>
        <button
          type="button"
          class="grid h-full w-11 place-items-center text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label={maximized() ? "Restore" : "Maximize"}
          title={maximized() ? "Restore" : "Maximize"}
          onClick={() => run((win) => win.toggleMaximize())}
        >
          <Show
            when={maximized()}
            fallback={
              <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.2">
                <rect x="2" y="2" width="8" height="8" />
              </svg>
            }
          >
            <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M4 2.5h5.5V8" />
              <rect x="2" y="4" width="6" height="6" />
            </svg>
          </Show>
        </button>
        <button
          type="button"
          class="grid h-full w-12 place-items-center text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          aria-label="Close"
          title="Close"
          onClick={() => run((win) => win.close())}
        >
          <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M3 3l6 6M9 3 3 9" />
          </svg>
        </button>
      </div>
    </Show>
  );
}

/**
 * The caption corner, pinned to the window's top-right.
 *
 * It belongs to the app root rather than to a column: the files drawer sits at
 * the right edge, so a caption living in the middle column would slide left the
 * moment the drawer opened. Title strips reserve the same width with
 * {@link CaptionGutter} so nothing ever renders underneath it.
 */
export function CaptionOverlay() {
  return (
    <Show when={usesCustomCaption()}>
      <div class="absolute right-0 top-0 z-50 flex h-11 shrink-0">
        <CaptionButtons />
      </div>
    </Show>
  );
}

/** Reserves the caption corner inside a title strip, as a sibling not a padding. */
export function CaptionGutter() {
  return (
    <Show when={usesCustomCaption()}>
      <div class="h-full shrink-0" style={{ width: `${CAPTION_W}px` }} />
    </Show>
  );
}

/**
 * Product mark for the title strip. Windows has no traffic lights to fill its
 * top-left corner, so it carries the wordmark instead; macOS keeps that space.
 */
export function AppMark() {
  return (
    <Show when={usesCustomCaption()}>
      <span class="flex shrink-0 items-center gap-2">
        <svg
          viewBox="0 0 16 16"
          class="size-4 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        >
          <path d="M2 4h12" />
          <path d="M2 8h8" />
          <path d="M2 12h4" />
        </svg>
        <span class="text-[13px] font-medium">Agent Strata</span>
      </span>
    </Show>
  );
}

/** The 44px strip that moves the window. Every screen keeps one across the top. */
export function DragBar(props: { class?: string; children?: JSX.Element }) {
  return (
    <div
      class={`flex h-11 shrink-0 items-center gap-3 border-b border-border select-none ${
        usesCustomCaption() ? "pl-5" : "px-5"
      } ${props.class ?? ""}`}
      data-tauri-drag-region={inDesktopShell() ? "" : undefined}
    >
      {props.children}
      <div class="ml-auto flex h-full">
        <CaptionGutter />
      </div>
    </div>
  );
}
