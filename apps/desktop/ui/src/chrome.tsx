import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { cn } from "./lib/utils";
import { Button } from "./components/ui/button";
import { formatChord } from "./commands";
import { Icon } from "./icons";
import { inDesktopShell, usesCustomCaption } from "./shell";
import { t } from "./i18n";
import { Tip } from "./tip";

/**
 * A caption control on the frameless Windows shell.
 *
 * These cannot be `Button`: they fill the full height of the caption strip and
 * sit square against the window edge, where the primitive's rounded, padded,
 * fixed-height shape would leave gaps at the top and bottom. What they do share
 * is worth owning here anyway — the class string was copy-pasted three times,
 * and none of the three drew a focus ring, so a keyboard user tabbing across
 * the title bar had no way to see where they were.
 */
function CaptionButton(props: {
  label: string;
  onClick: () => void;
  /** `close` gets the destructive hover; the other two share a quiet one. */
  variant?: "default" | "close";
  class?: string;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      class={cn(
        "grid h-full place-items-center text-muted-foreground transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.variant === "close"
          ? "hover:bg-destructive hover:text-destructive-foreground"
          : "hover:bg-secondary hover:text-foreground",
        props.class,
      )}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

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
        <Tip label={t("window.caption.minimize")} class="h-full">
          <CaptionButton
            class="w-11"
            label={t("window.caption.minimize")}
            onClick={() => run((win) => win.minimize())}
          >
            <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M2 6h8" />
            </svg>
          </CaptionButton>
        </Tip>
        <Tip label={maximized() ? t("window.caption.restore") : t("window.caption.maximize")} class="h-full">
          <CaptionButton
            class="w-11"
            label={maximized() ? t("window.caption.restore") : t("window.caption.maximize")}
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
          </CaptionButton>
        </Tip>
        <Tip label={t("window.caption.close")} class="h-full">
          <CaptionButton
            variant="close"
            class="w-12"
            label={t("window.caption.close")}
            onClick={() => run((win) => win.close())}
          >
            <svg viewBox="0 0 12 12" class="size-3" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M3 3l6 6M9 3 3 9" />
            </svg>
          </CaptionButton>
        </Tip>
      </div>
    </Show>
  );
}

/**
 * The window's own strip, spanning every column — Windows only.
 *
 * The caption gets this row to itself rather than sharing the right edge of
 * one column: a drawer docked at the right would otherwise take the corner
 * away, and the buttons would drift inward. With its own row, no screen
 * header, drawer, or title strip can ever reach the top-right — there is
 * nothing below it to reach.
 *
 * macOS draws nothing here: its overlay traffic lights land in the sidebar's
 * top-left corner, which lets every screen's own header reach the top edge
 * instead of sitting under an empty band.
 *
 * The left end of this row is the window's top-left corner, and it carries
 * the mark and the window's own switches — the same cluster the other shells
 * put beside their traffic lights.
 */
export function WindowCaptionBar(props: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
}) {
  return (
    <Show when={usesCustomCaption()}>
      <div
        class="flex h-9 shrink-0 select-none items-center gap-2 border-b border-border pl-3"
        data-tauri-drag-region={inDesktopShell() ? "" : undefined}
      >
        <AppMark />
        <TopLeftControls
          sidebarOpen={props.sidebarOpen}
          onToggleSidebar={props.onToggleSidebar}
          onOpenPalette={props.onOpenPalette}
        />
        <div class="ml-auto flex h-full self-stretch">
          <CaptionButtons />
        </div>
      </div>
    </Show>
  );
}

/**
 * The window's own switches, in the corner that owns them.
 *
 * They live at the top-left of the window rather than inside the sidebar for
 * one reason: the button that folds the sidebar away cannot live inside the
 * thing it folds. Everything here is a way into the window, and the window
 * is what stays on screen when the sidebar does not.
 *
 * The palette used to be opened from a row in the sidebar, one row below this
 * corner. It is a window-level thing — it lists commands, sessions and the
 * lines inside them — and the row was the only place that said so, with the
 * shortcut written on it. The shortcut is written on the tooltip here
 * instead, and the row is gone: two ways to open the same panel is one too
 * many.
 */
export function TopLeftControls(props: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
  class?: string;
}) {
  const paletteLabel = () => t("window.caption.palette", { shortcut: formatChord({ key: "k" }) });
  const sidebarLabel = () =>
    props.sidebarOpen ? t("window.caption.sidebar.hide") : t("window.caption.sidebar.show");

  return (
    <div class={cn("flex items-center gap-0.5", props.class)}>
      <Tip label={sidebarLabel()}>
        <Button
          type="button"
          variant="icon"
          size="icon-sm"
          aria-label={sidebarLabel()}
          aria-pressed={props.sidebarOpen}
          onClick={props.onToggleSidebar}
        >
          <Icon name="panel-left" class="size-4" />
        </Button>
      </Tip>
      <Tip label={paletteLabel()}>
        <Button
          type="button"
          variant="icon"
          size="icon-sm"
          aria-label={t("palette.title")}
          onClick={props.onOpenPalette}
        >
          <Icon name="search" class="size-4" />
        </Button>
      </Tip>
    </div>
  );
}

/**
 * The mark for the caption bar. Windows has no traffic lights to fill its
 * top-left corner, so it carries the picture instead; macOS keeps that space.
 *
 * The picture is the window icon itself, not a tinted silhouette of it. A mask
 * can only be one colour, and the corner then reads as an empty grey dash
 * rather than the mark on the taskbar.
 *
 * It is the picture alone: the wordmark used to sit beside it, but the title
 * bar of every other window on the machine says what is running, and a second
 * copy of the name in the corner of our own is what made the corner feel
 * loud. The name still says itself where it is asked for — the window title,
 * the About panel, the taskbar entry.
 */
export function AppMark() {
  return (
    <Show when={usesCustomCaption()}>
      <img
        src="/favicon.svg"
        alt=""
        draggable={false}
        class="pointer-events-none size-5 shrink-0"
      />
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
      class={`flex h-9 shrink-0 items-center gap-3 border-b border-border px-5 select-none ${
        props.class ?? ""
      }`}
      data-tauri-drag-region={inDesktopShell() ? "" : undefined}
    >
      {props.children}
    </div>
  );
}

/**
 * A screen that fills the main column: one title row and one scrolling body.
 *
 * Compare, settings and the landing page each used to write their own header —
 * a back link and a title in a DragBar — and the copies drifted apart. One
 * shape here means a new screen inherits the chrome instead of redrawing it.
 *
 * `back` is opt-in on purpose. A screen you reach from the sidebar is a peer
 * of the session list, not something you drilled into, so giving it a "back to
 * the session list" link would imply a depth that is not there. Compare earns
 * one because it really is opened from a pair of sessions.
 */
export function PageShell(props: {
  title: string;
  back?: { href: string; label: string };
  /** On the right of the title row: a count, a filter, a primary action. */
  meta?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div class="flex h-full min-h-0 flex-col">
      <DragBar>
        <Show when={props.back}>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            class="h-auto shrink-0 px-0 py-0 text-sm"
            onClick={() => (location.hash = props.back!.href)}
          >
            {props.back!.label}
          </Button>
        </Show>
        <span class="min-w-0 truncate text-sm font-medium text-foreground">{props.title}</span>
        <Show when={props.meta}>
          <div class="ml-auto flex min-w-0 items-center gap-2">{props.meta}</div>
        </Show>
      </DragBar>
      <div class="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
    </div>
  );
}
