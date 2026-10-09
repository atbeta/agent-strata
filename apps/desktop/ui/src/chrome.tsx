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
        <CaptionButtons />
      </div>
    </div>
  );
}
