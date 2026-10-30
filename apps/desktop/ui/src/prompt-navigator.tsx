import { createEffect, createMemo, createRenderEffect, createSelector, createSignal, For, onCleanup, Show } from "solid-js";
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
  /**
   * Room the rail has, measured. A signal because it comes from the host's
   * height; the flag below is derived from it rather than stored beside it.
   *
   * `chrome` used to be its own signal, written by the measuring effect. It
   * outlived the session it was measured in: switching to a conversation with
   * fewer prompts left the flag `true` from the last one, so the rail drew at
   * the full 360px cap until the effect ran again — the size visibly carrying
   * over from the previous session. Deriving it means a switch cannot show a
   * stale answer, because the answer is recomputed from the count in hand.
   */
  const [navRoom, setNavRoom] = createSignal(0);
  /** Resolved --nav-row-size in px; 8 is the stylesheet's default until measured. */
  const [rowPx, setRowPx] = createSignal(8);
  const chrome = createMemo(() => {
    const room = navRoom();
    // 0 is "not measured yet". Claiming chrome before there is a height to
    // compare against would put arrows on a rail that may not need them.
    if (room <= 0) return false;
    const cap = Math.max(0, Math.min(360, room - 24));
    return railOverflows(props.entries.length, rowPx(), cap);
  });
  const steps = createMemo(() => navSteps(
    props.entries.map((e) => e.turnId),
    props.activeId,
  ));

  const text = (e: PromptEntry) => e.prompt || t("nav.attach");
  const current = () => props.entries.find((e) => e.turnId === previewId());

  /**
   * The rail windows its ticks the way the transcript windows its rows: a
   * long session has ~1600 of them, and every forced layout in the pane
   * paid their box tree whether they were on screen or not. Rows are a
   * fixed size (--nav-row-size), so positions are arithmetic, not
   * measurements — tick i sits at i*row inside a spacer of n*row. When the
   * rail does not overflow, the window covers every entry and the DOM is
   * the same as an unwindowed list.
   */
  const [railTop, setRailTop] = createSignal(0);
  const [railHeight, setRailHeight] = createSignal(0);
  /** How far past the viewport ticks stay mounted, in rows. */
  const TICK_OVERSCAN = 20;
  const byId = createMemo(() => {
    const m = new Map<string, number>();
    props.entries.forEach((e, i) => m.set(e.turnId, i));
    return m;
  });
  const railRange = createMemo(() => {
    const r = rowPx();
    const lo = Math.max(0, Math.floor(railTop() / r) - TICK_OVERSCAN);
    const hi = Math.min(
      props.entries.length,
      Math.ceil((railTop() + railHeight()) / r) + TICK_OVERSCAN,
    );
    return { lo, hi };
  });
  const railWindow = createMemo(() => {
    const { lo, hi } = railRange();
    return props.entries.slice(lo, hi);
  });
  /** A focus request waiting on the window: Home/End scroll first, focus once mounted. */
  const [focusId, setFocusId] = createSignal<string | null>(null);
  createEffect(() => {
    const id = focusId();
    if (!id) return;
    railWindow();
    const el = refs.get(id);
    if (!el) return;
    el.focus();
    setFocusId(null);
  });

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
  // Positions are arithmetic (fixed row size), so the check needs no layout
  // read; the frame delay just coalesces a run of activeId moves into one
  // scroll decision against the layout the reader sees.
  let railScrollVersion = 0;
  createEffect(() => {
    const id = props.activeId;
    if (!id) return;
    const scheduledVersion = railScrollVersion;
    const raf = requestAnimationFrame(() => {
      if (scheduledVersion !== railScrollVersion) return;
      const i = byId().get(id);
      if (i === undefined || !rail) return;
      const top = i * rowPx();
      const bottom = top + rowPx();
      if (top < rail.scrollTop) rail.scrollTop = top;
      else if (bottom > rail.scrollTop + rail.clientHeight)
        rail.scrollTop = bottom - rail.clientHeight;
    });
    onCleanup(() => cancelAnimationFrame(raf));
  });

  // The cap is the rail's own max, or whatever of the transcript is left after
  // the 24px margin. Chrome (arrows and end dots) only appears once the ticks
  // are taller than that, which is the case the hidden scrollbar used to hide.
  createEffect(() => {
    props.entries.length;
    const el = nav;
    if (!el) return;
    // No synchronous read: clientHeight here would force a full layout
    // inside the commit, and observe() delivers the initial size anyway.
    // Until the first callback navRoom stays 0, which only defers chrome —
    // the rail's height is already the same value in CSS.
    const host = el.parentElement;
    if (!host) {
      setNavRoom(360);
      return;
    }
    const measure = () => {
      // Only the room. Whether that room needs chrome is derived from the
      // entry count, so a switch to another session cannot inherit the last
      // one's answer.
      setNavRoom(host.clientHeight - 24);
      const px = parseFloat(getComputedStyle(el).getPropertyValue("--nav-row-size"));
      if (Number.isFinite(px) && px > 0) setRowPx(px);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  // The rail's own height drives the window; it changes when chrome toggles,
  // not only when the host does, so it gets its own observer.
  createEffect(() => {
    const el = rail;
    if (!el) return;
    const ro = new ResizeObserver(() => setRailHeight(el.clientHeight));
    ro.observe(el);
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

  // Focus a rail index that may not be mounted yet: scroll it into the
  // window first, then let the focus effect pick it up once it exists.
  const railTo = (j: number) => {
    const id = props.entries[j]?.turnId;
    if (!id || !rail) return;
    if (refs.get(id)) {
      refs.get(id)!.focus();
      return;
    }
    rail.scrollTop = Math.max(0, j * rowPx() - rail.clientHeight / 2);
    setFocusId(id);
  };

  const onKey = (e: KeyboardEvent) => {
    const el = document.activeElement as HTMLElement | null;
    const i = el ? props.entries.findIndex((x) => x.turnId === el.dataset.turnId) : -1;
    if (i < 0) return;
    const last = props.entries.length - 1;
    const go = (j: number) => {
      const id = props.entries[j]?.turnId;
      if (id) railTo(j);
    };
    if (e.key === "ArrowDown") {
      e.preventDefault();
      go(Math.min(i + 1, last));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      railTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      railTo(last);
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

  // Selectors, not per-tick comparisons: reading `props.activeId` inside every
  // button's attributes re-evaluated the lookup once per tick per change —
  // O(entries) reads a frame. A selector resolves it once and only re-renders
  // the tick the answer moved from and the one it moved to.
  const isActive = createSelector(() => props.activeId);
  // The windowed rail must always keep one mounted tick in the tab order:
  // if the designated one scrolled out of the window, the first mounted
  // tick takes the stop rather than leaving the rail unreachable.
  const isTab = createSelector(() => {
    const { lo, hi } = railRange();
    const id = tabId() ?? props.activeId ?? props.entries[0]?.turnId;
    const i = id ? byId().get(id) : undefined;
    return i !== undefined && i >= lo && i < hi ? id : props.entries[lo]?.turnId;
  });

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
        onScroll={(e) => {
          railScrollVersion++;
          setRailTop(e.currentTarget.scrollTop);
        }}
        onPointerMove={onRailMove}
        onPointerLeave={onRailLeave}
        onKeyDown={onKey}
      >
        {/* The spacer is the rail's only in-flow child; the absolute ticks
            contribute nothing to its size, so it carries the rail's width
            itself — without it the whole nav collapses to zero. */}
        <div
          style={{
            position: "relative",
            width: "var(--nav-tick-w)",
            height: `${props.entries.length * rowPx()}px`,
          }}
        >
          <For each={railWindow()}>
            {(e) => {
              onCleanup(() => refs.delete(e.turnId));
              return (
                <button
                  ref={(el) => refs.set(e.turnId, el)}
                  type="button"
                  data-turn-id={e.turnId}
                  class="nav-tick"
                  style={{ position: "absolute", top: `${(byId().get(e.turnId) ?? 0) * rowPx()}px` }}
                  tabIndex={isTab(e.turnId) ? 0 : -1}
                  aria-current={isActive(e.turnId) || undefined}
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
              );
            }}
          </For>
        </div>
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
