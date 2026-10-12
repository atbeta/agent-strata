import { createEffect, createRenderEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "./i18n";
import type { PromptEntry } from "./prompt-outline";

/**
 * Prompt rail: one line per user prompt, anchored to the transcript viewport's
 * left gutter. Hovering or focusing a line floats a single non-interactive
 * preview card for that turn; clicking the line jumps straight to it. All
 * entries keep stable positions in the rail's own scrollbox — nothing is
 * windowed or re-ordered around the active turn.
 */
export function PromptNavigator(props: {
  entries: readonly PromptEntry[];
  activeId?: string;
  onSelect: (turnId: string) => void;
}) {
  const [previewId, setPreviewId] = createSignal<string | null>(null);
  const [anchor, setAnchor] = createSignal<DOMRect | null>(null);
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
  const [tabId, setTabId] = createSignal<string | null>(null);
  const refs = new Map<string, HTMLButtonElement>();
  let rail: HTMLDivElement | undefined;
  let card: HTMLDivElement | undefined;

  const text = (e: PromptEntry) => e.prompt || t("nav.attach");
  const current = () => props.entries.find((e) => e.turnId === previewId());

  const showFor = (id: string) => {
    const el = refs.get(id);
    if (!el) return;
    setAnchor(el.getBoundingClientRect());
    setPreviewId(id);
    setPos(null);
  };
  const hide = () => {
    setPreviewId(null);
    setAnchor(null);
    setPos(null);
  };

  // Keep the active line inside the rail's own scrollbox — rail.scrollTop only,
  // never scrollIntoView, so the transcript/page never gets dragged along.
  createEffect(() => {
    const id = props.activeId;
    if (!id || !rail) return;
    const el = refs.get(id);
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < rail.scrollTop) rail.scrollTop = top;
    else if (bottom > rail.scrollTop + rail.clientHeight)
      rail.scrollTop = bottom - rail.clientHeight;
  });

  const onAnyScroll = (e: Event) => {
    if (!previewId()) return;
    if (e.target === rail) {
      // The rail moved the anchor: re-measure if the line is still visible,
      // dismiss when it has been scrolled out of the rail's own window.
      const id = previewId();
      const el = id ? refs.get(id) : undefined;
      const rr = rail?.getBoundingClientRect();
      if (el && rr) {
        const r = el.getBoundingClientRect();
        if (r.bottom > rr.top && r.top < rr.bottom) setAnchor(r);
        else hide();
      } else hide();
      return;
    }
    hide();
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && previewId()) hide();
  };

  createEffect(() => {
    if (!previewId()) return;
    window.addEventListener("scroll", onAnyScroll, { capture: true, passive: true });
    window.addEventListener("resize", hide, { passive: true });
    document.addEventListener("keydown", onDocKey);
    onCleanup(() => {
      window.removeEventListener("scroll", onAnyScroll, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("keydown", onDocKey);
    });
  });

  // Measure the card against its own box, same principle as Tip: right of the
  // hovered line, vertically centred on it, clamped to an 8px viewport margin.
  createRenderEffect(() => {
    const r = anchor();
    const el = card;
    if (!previewId() || !r || !el) return;
    const measure = () => {
      const a = anchor();
      if (!previewId() || !a || card !== el) return;
      const b = el.getBoundingClientRect();
      if (!b.width) return;
      const x = Math.max(8, Math.min(a.right + 8, innerWidth - b.width - 8));
      const y = Math.max(8, Math.min(a.top + a.height / 2 - b.height / 2, innerHeight - b.height - 8));
      setPos((p) => (p && p.x === x && p.y === y ? p : { x, y }));
    };
    measure();
    requestAnimationFrame(measure);
  });

  const onKey = (e: KeyboardEvent) => {
    const el = document.activeElement as HTMLElement | null;
    const i = el ? props.entries.findIndex((x) => x.turnId === el.dataset.turnId) : -1;
    if (i < 0) return;
    const last = props.entries.length - 1;
    const go = (j: number) => {
      const id = props.entries[j]?.turnId;
      if (id) refs.get(id)?.focus();
    };
    if (e.key === "ArrowDown") {
      e.preventDefault();
      go(Math.min(i + 1, last));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(last);
    } else if (e.key === "Escape" && previewId()) {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  };

  onCleanup(() => refs.clear());

  const tabFor = (id: string) =>
    (tabId() ?? props.activeId ?? props.entries[0]?.turnId) === id ? 0 : -1;

  return (
    <div
      class="prompt-nav absolute left-2 top-1/2 z-10 -translate-y-1/2"
      style={{
        "--nav-count": props.entries.length,
        height: "min(calc(var(--nav-count) * var(--nav-row-size)), 360px, calc(100% - 24px))",
      }}
    >
      <div
        ref={rail}
        class="rail h-full overflow-y-auto overscroll-contain"
        role="group"
        aria-label={t("nav.outline", { n: props.entries.length })}
        onMouseLeave={hide}
        onFocusOut={(e) => {
          if (!rail?.contains(e.relatedTarget as Node | null)) hide();
        }}
        onKeyDown={onKey}
      >
        <For each={props.entries}>
          {(e) => (
            <button
              ref={(el) => refs.set(e.turnId, el)}
              type="button"
              data-turn-id={e.turnId}
              class="nav-tick"
              tabIndex={tabFor(e.turnId)}
              aria-current={props.activeId === e.turnId || undefined}
              aria-label={`${e.number}. ${text(e)}`}
              aria-describedby={previewId() === e.turnId ? "prompt-nav-tip" : undefined}
              onMouseEnter={() => showFor(e.turnId)}
              onFocus={() => {
                setTabId(e.turnId);
                showFor(e.turnId);
              }}
              onClick={() => {
                hide();
                props.onSelect(e.turnId);
              }}
            >
              <span class="nav-line" />
            </button>
          )}
        </For>
      </div>
      <Show when={current()}>
        {(en) => (
          <Portal>
            <div
              id="prompt-nav-tip"
              role="tooltip"
              ref={card}
              class="pointer-events-none fixed z-[70] w-[280px] max-w-[min(280px,calc(100vw-24px))] rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-lg"
              style={{
                left: `${pos()?.x ?? (anchor()?.right ?? 0) + 8}px`,
                top: `${pos()?.y ?? anchor()?.top ?? 0}px`,
              }}
            >
              <div class="flex items-center gap-1.5">
                <span class="rounded bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground">
                  {t("nav.turn", { n: en().number })}
                </span>
                <Show when={en().reverted}>
                  <span class="rounded bg-muted px-1 py-px text-2xs text-muted-foreground">
                    {t("nav.reverted")}
                  </span>
                </Show>
              </div>
              <p class="mt-1 line-clamp-2 break-words text-xs leading-snug">{text(en())}</p>
              <Show when={en().reply}>
                <p class="mt-0.5 line-clamp-3 break-words text-2xs leading-snug text-muted-foreground">
                  {en().reply}
                </p>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}
