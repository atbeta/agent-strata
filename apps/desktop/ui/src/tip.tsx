import { Show, createSignal, type JSX } from "solid-js";

/** Instant hover label. Fixed so a scrolling sidebar does not clip it. */
export function Tip(props: { label: string; class?: string; children: JSX.Element }) {
  const [box, setBox] = createSignal<{ x: number; y: number; below: boolean } | null>(null);
  const place = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const below = r.top < 40;
    setBox({
      x: Math.min(window.innerWidth - 8, Math.max(8, r.left + r.width / 2)),
      y: below ? r.bottom + 6 : r.top - 6,
      below,
    });
  };
  return (
    <span
      class={`inline-flex ${props.class ?? ""}`}
      onMouseEnter={(e) => place(e.currentTarget)}
      onMouseLeave={() => setBox(null)}
      onFocusIn={(e) => place(e.currentTarget)}
      onFocusOut={() => setBox(null)}
    >
      {props.children}
      <Show when={box()}>
        {(b) => (
          <span
            role="tooltip"
            class={`pointer-events-none fixed z-[80] -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-1.5 py-0.5 text-[11px] text-popover-foreground shadow-md ${
              b().below ? "" : "-translate-y-full"
            }`}
            style={{ left: `${b().x}px`, top: `${b().y}px` }}
          >
            {props.label}
          </span>
        )}
      </Show>
    </span>
  );
}
