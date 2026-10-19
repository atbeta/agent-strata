import { createSignal } from "solid-js";
import {
  CONTENT_W_DEFAULT,
  CONTENT_W_MAX,
  CONTENT_W_MIN,
  writeContentWidth,
} from "./content-width";
import { contentW, setContentWidth } from "./session-chrome";
import { t } from "./i18n";

export function LoadingTranscript() {
  return (
    <div class="mx-auto w-full space-y-4 px-5 py-8" style={{ "max-width": `calc(${contentW()}px + 2.5rem)` }}>
      <div class="ml-auto h-10 w-2/3 motion-safe:animate-pulse rounded-xl bg-secondary/80" />
      <div class="h-4 w-5/6 motion-safe:animate-pulse rounded bg-secondary/50" />
      <div class="h-4 w-2/3 motion-safe:animate-pulse rounded bg-secondary/40" />
    </div>
  );
}

/**
 * The reading column's own resize handles: an invisible strip on each edge of
 * the column that answers hover with a short segment of line under the
 * pointer, gradient-faded at both ends — the edge says it can move only
 * where the pointer asks, never as a standing border. The column is centered,
 * so dragging either side resizes symmetrically — the width is twice the
 * pointer's distance from the middle of the stage. Double-click resets.
 */
export function ContentSashes() {
  const [dragging, setDragging] = createSignal(false);
  const [gripY, setGripY] = createSignal(0);
  const start = (e: PointerEvent & { currentTarget: HTMLDivElement }) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const host = handle.parentElement;
    if (!host) return;
    const center = host.getBoundingClientRect().left + host.clientWidth / 2;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => setContentWidth(2 * Math.abs(ev.clientX - center), false);
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      setDragging(false);
      writeContentWidth(contentW());
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  };
  const onKey = (side: "left" | "right") => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    const grow =
      side === "left" ? e.key === "ArrowLeft" : e.key === "ArrowRight";
    const shrink =
      side === "left" ? e.key === "ArrowRight" : e.key === "ArrowLeft";
    if (!grow && !shrink) return;
    e.preventDefault();
    setContentWidth(contentW() + (grow ? step : -step));
  };
  // The strip straddles the column edge, half in the margin and half over the
  // column; `max()` keeps it on the pane's own border when the pane has no
  // margin to spare.
  const edge = () => `max(0px, calc(50% - ${contentW() / 2 + 8}px))`;
  const grip = (side: "left" | "right") => (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("content.resize")}
      aria-valuemin={CONTENT_W_MIN}
      aria-valuemax={CONTENT_W_MAX}
      aria-valuenow={contentW()}
      tabindex={0}
      class="group absolute inset-y-0 z-10 w-4 cursor-ew-resize outline-none"
      style={side === "left" ? { left: edge() } : { right: edge() }}
      onPointerDown={start}
      onPointerMove={(e) => setGripY(e.offsetY)}
      onDblClick={() => setContentWidth(CONTENT_W_DEFAULT)}
      onKeyDown={onKey(side)}
    >
      {/* 64px of edge under the pointer, its ends masked away — a hairline that
          exists only where it is being looked at. */}
      <div
        class={`pointer-events-none absolute left-1/2 h-16 w-0.5 -translate-x-1/2 rounded-full bg-muted-foreground/70 transition-opacity ${
          dragging() ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }`}
        style={{
          top: `clamp(0px, ${gripY() - 32}px, calc(100% - 64px))`,
          "mask-image":
            "linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)",
        }}
      />
    </div>
  );
  return (
    <>
      {grip("left")}
      {grip("right")}
    </>
  );
}
