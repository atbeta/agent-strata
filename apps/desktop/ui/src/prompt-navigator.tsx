import { createEffect, createMemo, createRenderEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Button } from "./components/ui/button";
import { Icon } from "./icons";
import { t } from "./i18n";
import { magnifiedWidth, navSteps, railOverflows } from "./prompt-nav";
import type { PromptEntry } from "./prompt-outline";

/** How far a hovered line reaches into its neighbours, in px. */
const MAG_INFLUENCE = 50;
const RIB_BASE = 8;
const RIB_PEAK = 20;
const RIB_CURRENT = 14;
const RIB_CURRENT_PEAK = 22;

/**
 * Prompt rail: one line per user prompt, anchored to the transcript viewport's
 * left gutter. Hovering or focusing a line floats a single non-interactive
 * preview card for that turn; clicking the line jumps straight to it. All
 * entries keep stable positions in the rail's own scrollbox — nothing is
 * windowed or re-ordered around the active turn.
 *
 * Once the ticks outgrow the cap, the scrollbar stays hidden and the ends
 * stay on screen: an arrow steps to the neighbouring prompt, and a dot jumps
 * to the first or the last. Passing the pointer widens the lines around it.
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
  let nav: HTMLDivElement | undefined;
  let rail: HTMLDivElement | undefined;
  let card: HTMLDivElement | undefined;
  const [chrome, setChrome] = createSignal(false);
  const steps = createMemo(() => navSteps(
    props.entries.map((e) => e.turnId),
    props.activeId,
  ));

  const text = (e: PromptEntry) => e.prompt || t("nav.attach");
  const current = () => props.entries.find((e) => e.turnId === previewId());

  const showFor = (id: string, anchorEl?: HTMLElement) => {
    const el = anchorEl ?? refs.get(id);
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

  // The cap is the rail's own max, or whatever of the transcript is left after
  // the 24px margin. Chrome (arrows and end dots) only appears once the ticks
  // are taller than that, which is the case the hidden scrollbar used to hide.
  createEffect(() => {
    props.entries.length;
    const el = nav;
    if (!el) return;
    const measure = () => {
      const host = el.parentElement;
      const room = host ? host.clientHeight - 24 : 360;
      const cap = Math.max(0, Math.min(360, room));
      const raw = getComputedStyle(el).getPropertyValue("--nav-row-size").trim();
      const row = parseFloat(raw);
      setChrome(railOverflows(props.entries.length, Number.isFinite(row) ? row : 8, cap));
    };
    measure();
    const host = el.parentElement;
    if (!host) return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let frame = 0;
  let pendingY: number | null = null;
  const paintRibs = (clientY: number | null) => {
    const col = rail;
    if (!col) return;
    const still = clientY == null || reduced();
    // Read every line's geometry before writing any width: interleaving the
    // two turns one pointermove into N forced layouts, one per tick.
    const targets: { line: HTMLElement; center: number; current: boolean }[] = [];
    for (const btn of col.querySelectorAll<HTMLButtonElement>(".nav-tick")) {
      const line = btn.querySelector<HTMLElement>(".nav-line");
      if (!line) continue;
      const r = btn.getBoundingClientRect();
      targets.push({
        line,
        center: r.top + r.height / 2,
        current: btn.getAttribute("aria-current") === "true",
      });
    }
    for (const target of targets) {
      if (still) {
        if (target.line.style.width === "") continue;
        target.line.style.transition = "width 140ms ease-out";
        target.line.style.width = "";
        continue;
      }
      // Centres live in viewport space like the pointer, so the arrows above
      // the rail and the rail's own scrollTop cannot shift the widest rib.
      const width = magnifiedWidth(
        target.current ? RIB_CURRENT : RIB_BASE,
        target.current ? RIB_CURRENT_PEAK : RIB_PEAK,
        Math.abs((clientY as number) - target.center),
        MAG_INFLUENCE,
      );
      const px = `${Math.round(width * 100) / 100}px`;
      if (target.line.style.width === px) continue;
      target.line.style.transition = "none";
      target.line.style.width = px;
    }
  };
  // Coalesce pointermoves to one paint per frame; the last position wins.
  const onRailMove = (e: PointerEvent) => {
    pendingY = e.clientY;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paintRibs(pendingY);
    });
  };
  const onRailLeave = () => {
    pendingY = null;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    paintRibs(null);
  };

  const go = (id: string | undefined) => {
    if (!id) return;
    hide();
    props.onSelect(id);
  };

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

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame);
    refs.clear();
  });

  const tabFor = (id: string) =>
    (tabId() ?? props.activeId ?? props.entries[0]?.turnId) === id ? 0 : -1;

  const stepClass =
    "nav-step h-4 w-7 opacity-55 group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-30 group-hover:disabled:opacity-30";
  const endClass = "nav-end h-4 w-7 opacity-55 group-hover:opacity-100 group-focus-within:opacity-100";

  return (
    <div
      ref={nav}
      class="prompt-nav group absolute left-2 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center"
      style={{
        "--nav-count": props.entries.length,
        height: chrome()
          ? "min(360px, calc(100% - 24px))"
          : "min(calc(var(--nav-count) * var(--nav-row-size)), 360px, calc(100% - 24px))",
      }}
      onMouseLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        hide();
        onRailLeave();
      }}
      onFocusOut={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        hide();
        onRailLeave();
      }}
    >
      <Show when={chrome() && steps()}>
        {(s) => (
          <>
            <Button
              variant="quiet"
              size="icon-2xs"
              class={stepClass}
              aria-label={t("nav.previous")}
              disabled={!s().previousId}
              onMouseEnter={hide}
              onClick={() => go(s().previousId)}
            >
              <Icon name="chevron" class="size-3.5 rotate-180" />
            </Button>
            <Button
              variant="quiet"
              size="icon-2xs"
              class={endClass}
              aria-label={t("nav.first")}
              onMouseEnter={(e) => showFor(s().firstId, e.currentTarget)}
              onFocus={(e) => showFor(s().firstId, e.currentTarget)}
              onClick={() => go(s().firstId)}
            >
              <span class="nav-dot" />
            </Button>
          </>
        )}
      </Show>
      <div
        ref={rail}
        class={`rail overflow-y-auto overscroll-contain ${chrome() ? "min-h-0 w-full flex-1" : "h-full"}`}
        role="group"
        aria-label={t("nav.outline", { n: props.entries.length })}
        onPointerMove={onRailMove}
        onPointerLeave={onRailLeave}
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
      <Show when={chrome() && steps()}>
        {(s) => (
          <>
            <Button
              variant="quiet"
              size="icon-2xs"
              class={endClass}
              aria-label={t("nav.last")}
              onMouseEnter={(e) => showFor(s().lastId, e.currentTarget)}
              onFocus={(e) => showFor(s().lastId, e.currentTarget)}
              onClick={() => go(s().lastId)}
            >
              <span class="nav-dot" />
            </Button>
            <Button
              variant="quiet"
              size="icon-2xs"
              class={stepClass}
              aria-label={t("nav.next")}
              disabled={!s().nextId}
              onMouseEnter={hide}
              onClick={() => go(s().nextId)}
            >
              <Icon name="chevron" class="size-3.5" />
            </Button>
          </>
        )}
      </Show>
      <Show when={current()}>
        {(en) => (
          <Portal>
            <div
              id="prompt-nav-tip"
              role="tooltip"
              ref={card}
              class="surface-popover pointer-events-none fixed z-[70] w-[280px] max-w-[min(280px,calc(100vw-24px))] rounded-lg bg-popover p-2.5 text-popover-foreground"
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
