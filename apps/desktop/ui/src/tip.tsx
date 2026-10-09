import { createRenderEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";

const PAD = 8;
/** Keep this far from the top so a tooltip never lands under the caption row. */
const TOP_GAP = 46;
/** Longest tooltip we will render before wrapping. */
const MAX_W = 448;

/**
 * Instant hover label. Fixed so a scrolling sidebar does not clip it.
 *
 * Position is measured, not estimated: the tooltip renders at a provisional
 * anchor and a render effect corrects it against its own box before paint.
 * Clamping to half its own width — rather than to the trigger's centre — is
 * what keeps a label on the last button of a row from running off the side, and
 * wrapping long paths is what keeps it from running off the other one.
 *
 * The bubble is pinned to `width: max-content` so that measurement is stable.
 * A fixed-position box with `width: auto` shrink-to-fits against
 * `containing block - left`, so moving it to stop an overflow silently resizes
 * it: the box measured on the provisional anchor is not the box that ends up on
 * screen, and the clamp misses by however much the two differ.
 *
 * Visibility is driven from the document rather than from `mouseleave` on the
 * wrapper. Caption buttons and header controls sit inside app-region: drag
 * strips, and those swallow the leave event — a tooltip opened over the
 * caption bar would then stay pinned for the rest of the session. Watching
 * pointer moves instead also means a tooltip cannot outlive the element it
 * describes if the list under it re-renders.
 */
export function Tip(props: {
  label: string;
  class?: string;
  children: JSX.Element;
}) {
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  const [pos, setPos] = createSignal<{ x: number; y: number; below: boolean } | null>(null);
  // A signal, not a plain ref: the effect below can only measure a bubble that
  // already exists, so it has to re-run once `Show` has mounted it.
  const [bubble, setBubble] = createSignal<HTMLSpanElement>();
  let wrap: HTMLSpanElement | undefined;

  const hide = () => setAnchor(null);

  const place = (el: HTMLElement) => {
    // Prefer the wrapper's own box, but fall through to the child when the
    // wrapper has collapsed — an absolutely positioned trigger inside `Tip` has
    // no flow box of its own, and its centre is the only anchor that is right.
    const r = el.getBoundingClientRect();
    setAnchor(r.width || r.height ? r : (el.firstElementChild?.getBoundingClientRect() ?? r));
  };

  const put = (r: DOMRect, el: HTMLSpanElement) => {
    // Read the bubble's own box, not the trigger's: the two differ exactly where
    // it matters, which is a long label against a short control.
    const b = el.getBoundingClientRect();
    // Not laid out yet. Placing against a zero-width box would centre the label
    // on the trigger with no idea how wide it is about to become, which is how a
    // long preview ends up hanging off the right edge.
    if (!b.width) return;
    const below = r.top < TOP_GAP + b.height;
    const half = b.width / 2;
    const x = Math.min(window.innerWidth - half - PAD, Math.max(half + PAD, r.left + r.width / 2));
    const y = below ? r.bottom + 6 : r.top - 6;
    // Keep the identity when nothing moved, so re-running this cannot loop.
    setPos((p) => (p && p.x === x && p.y === y && p.below === below ? p : { x, y, below }));
  };

  // A render effect, not a plain effect: this has to correct the position before
  // the browser paints, or the tooltip visibly jumps from its provisional spot.
  createRenderEffect(() => {
    const r = anchor();
    const el = bubble();
    if (!r || !el) return;
    put(r, el);
    // Solid hands the ref over before the label is a child, so the box measured
    // above can still be empty. One pass after layout settles it; because the
    // bubble is width:max-content that pass is final rather than another round
    // of nudging a box that changed shape to get there.
    requestAnimationFrame(() => {
      const a = anchor();
      if (a && bubble() === el) put(a, el);
    });
  });

  onCleanup(() => document.removeEventListener("pointermove", watch, true));

  function watch(e: PointerEvent) {
    const t = e.target as Node | null;
    // The bubble is pointer-events-none, so containment against the wrapper is
    // enough to decide whether the pointer is still on the trigger.
    if (anchor() && (!t || !wrap?.contains(t))) hide();
  }

  return (
    <span
      ref={wrap}
      class={`inline-flex ${props.class ?? ""}`}
      onMouseEnter={(e) => {
        place(e.currentTarget);
        document.addEventListener("pointermove", watch, true);
      }}
      onFocusIn={(e) => {
        place(e.currentTarget);
        document.addEventListener("pointermove", watch, true);
      }}
      onFocusOut={hide}
    >
      {props.children}
      <Show when={anchor() && props.label}>
        <span
          ref={setBubble}
          role="tooltip"
          class={`pointer-events-none fixed z-[80] w-max -translate-x-1/2 rounded-md border border-border bg-popover px-1.5 py-0.5 text-2xs break-words whitespace-pre-wrap text-popover-foreground shadow-md ${
            pos()?.below ? "" : "-translate-y-full"
          }`}
          style={{
            left: `${pos()?.x ?? 0}px`,
            top: `${pos()?.y ?? 0}px`,
            "max-width": `min(${MAX_W}px, calc(100vw - ${PAD * 2}px))`,
          }}
        >
          {props.label}
        </span>
      </Show>
    </span>
  );
}
