import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Button } from "@/components/ui/button";
import { copyImage } from "./clipboard";
import { Icon } from "./icons";
import { t } from "./i18n";
import { fitScale, zoomAt, zoomBounds } from "./image-zoom";

/** The one enlarged image on screen — anything that calls `openImage`. */
const [viewer, setViewer] = createSignal<{ src: string; alt: string } | undefined>();

export function openImage(src: string | undefined, alt = "") {
  if (src) setViewer({ src, alt });
}

/**
 * The enlarged-image overlay: opens fitted to the window, wheel zooms around
 * the pointer, drag pans, double-click swaps fit for real pixels, and the
 * corner copies the picture outright or closes it. `Esc` and a click on the
 * backdrop also close.
 */
export function ImageViewerHost() {
  const [scale, setScale] = createSignal(1);
  const [fit, setFit] = createSignal(1);
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const [copied, setCopied] = createSignal(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let frame: HTMLDivElement | undefined;
  /** A pan in progress; `moved` outlives it long enough for the click after
   *  the pointer-up to tell a pan from a click on the backdrop. */
  let drag: { sx: number; sy: number; px: number; py: number; moved: number } | undefined;
  let moved = 0;

  const close = () => setViewer(undefined);

  /** The frame's centre is the transform origin, so anchors arrive relative
   *  to it rather than to the corner. */
  const anchorAt = (e: { clientX: number; clientY: number }) => {
    const r = frame!.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  const zoomTo = (next: number, anchor: { x: number; y: number }) => {
    setPos(zoomAt(scale(), next, pos(), anchor));
    setScale(next);
  };

  const measure = (img: HTMLImageElement) => {
    if (!frame) return;
    const r = frame.getBoundingClientRect();
    const f = fitScale(img.naturalWidth, img.naturalHeight, r.width, r.height);
    setFit(f);
    setScale(f);
    setPos({ x: 0, y: 0 });
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { min, max } = zoomBounds(fit());
    const next = Math.min(max, Math.max(min, scale() * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (next !== scale()) zoomTo(next, anchorAt(e));
  };

  // A copy that lands late must not flash on the next picture — reopening
  // clears both the feedback and the gesture left over from before.
  createEffect(() => {
    if (!viewer()) return;
    setCopied(false);
    drag = undefined;
    moved = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(copyTimer);
    });
  });

  const copy = async (src: string) => {
    if (!(await copyImage(src))) return;
    setCopied(true);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Show when={viewer()}>
      {(v) => (
        <Portal>
          <div
            ref={(el) => {
              frame = el;
              el.addEventListener("wheel", onWheel, { passive: false });
            }}
            role="dialog"
            aria-modal="true"
            aria-label={t("transcript.image")}
            class="expand-in fixed inset-0 z-[80] flex touch-none items-center justify-center select-none bg-background/85 backdrop-blur-[2px]"
            onClick={(e) => {
              // A pan that ends over the backdrop is still a pan — only an
              // honest click on the dim part asks to leave.
              if (moved > 4) return;
              if (e.target === e.currentTarget) close();
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              moved = 0;
              drag = { sx: pos().x, sy: pos().y, px: e.clientX, py: e.clientY, moved: 0 };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag) return;
              const dx = e.clientX - drag.px;
              const dy = e.clientY - drag.py;
              drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
              if (drag.moved > 2) setPos({ x: drag.sx + dx, y: drag.sy + dy });
            }}
            onPointerUp={() => {
              moved = drag?.moved ?? 0;
              drag = undefined;
            }}
            onPointerCancel={() => {
              moved = 0;
              drag = undefined;
            }}
            onDblClick={(e) => {
              // Fit ↔ real pixels; a picture already at 1:1 jumps twice as
              // far in instead.
              const alt = fit() >= 1 ? 2.5 : 1;
              zoomTo(Math.abs(scale() - alt) < 1e-3 ? fit() : alt, anchorAt(e));
            }}
          >
            <img
              src={v().src}
              alt={v().alt}
              draggable={false}
              class="rounded-md shadow-2xl"
              style={{
                "max-width": "none",
                "max-height": "none",
                transform: `translate(${pos().x}px, ${pos().y}px) scale(${scale()})`,
              }}
              onLoad={(e) => measure(e.currentTarget)}
            />
            {/* pointerdown stops here or the buttons start a pan under the
                press they were meant to take. */}
            <div
              class="absolute right-3 top-3 flex gap-1.5"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Button
                variant="icon"
                size="icon-sm"
                aria-label={t("transcript.image.copy")}
                class="bg-secondary/80 hover:bg-secondary"
                onClick={() => void copy(v().src)}
              >
                <Icon
                  name={copied() ? "check" : "copy"}
                  class={`size-4 ${copied() ? "text-status-active" : ""}`}
                />
              </Button>
              <Button
                variant="icon"
                size="icon-sm"
                aria-label={t("transcript.image.close")}
                class="bg-secondary/80 hover:bg-secondary"
                onClick={close}
              >
                <Icon name="x" class="size-4" />
              </Button>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  );
}
