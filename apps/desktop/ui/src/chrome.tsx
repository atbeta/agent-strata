import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { inDesktopShell, drawsOwnTopStrip, usesCustomCaption } from "./shell";

type WindowHandle = {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
};

let windowPromise: Promise<WindowHandle> | undefined;

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
 * The window's own 44px strip, spanning every column.
 *
 * The caption gets this row to itself rather than sharing the right edge of
 * one column: a drawer docked at the right would otherwise take the corner
 * away, and the buttons would drift inward. With its own row, no screen
 * header, drawer, or title strip can ever reach the top-right — there is
 * nothing below it to reach.
 */
export function WindowCaptionBar() {
  return (
    <Show when={drawsOwnTopStrip()}>
      <div
        class={`flex h-11 shrink-0 items-center gap-3 border-b border-border select-none ${
          usesCustomCaption() ? "pl-5" : "pl-[76px]"
        }`}
        data-tauri-drag-region={inDesktopShell() ? "" : undefined}
      >
        <AppMark />
        <div class="ml-auto flex h-full self-stretch">
          <CaptionButtons />
        </div>
      </div>
    </Show>
  );
}

/**
 * Product mark for the caption bar. Windows has no traffic lights to fill its
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
        <span class="text-sm font-medium">Agent Strata</span>
      </span>
    </Show>
  );
}

/**
 * A screen's own header row, below the window caption bar.
 *
 * It used to carry the caption and the pl-5 that went with it. The caption
 * has a row of its own now, so this is just a bordered row of content that
 * still doubles as a drag handle.
 */
export function DragBar(props: { class?: string; children?: JSX.Element }) {
  return (
    <div
      class={`flex h-11 shrink-0 items-center gap-3 border-b border-border px-5 select-none ${
        props.class ?? ""
      }`}
      data-tauri-drag-region={inDesktopShell() ? "" : undefined}
    >
      {props.children}
    </div>
  );
}
