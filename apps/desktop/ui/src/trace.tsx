import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type JSX } from "solid-js";
import { fmtDuration, fmtUsd } from "./api";
import { inDesktopShell } from "./shell";
import { Md } from "./md";
import { Tip } from "./tip";
import { CopyButton, Payload } from "./payload";
import { num, stamp, t } from "./i18n";
import { Icon } from "./icons";
import { traceMaxOffset, tracePage, traceWindow } from "./trace-window";
import {
  filterTrace,
  layoutTrace,
  traceSummary,
  type TraceBlock,
  type TraceFile,
  type TraceFilter,
  type TraceLayoutMode,
  type TracePermission,
  type TraceUsage,
} from "./trace-model";
import { Button } from "@/components/ui/button";
import { MiniTabs } from "@/components/ui/mini-tabs";
import { TextFieldInput } from "@/components/ui/text-field";

export type { TraceBlock } from "./trace-model";

/** `label` holds the dictionary key; the row renders `t()` over it. */
const LANES = [
  { id: "user", label: "trace.lane.input" },
  { id: "assistant", label: "trace.lane.reply" },
  { id: "tool", label: "trace.lane.tool" },
  { id: "event", label: "trace.lane.event" },
] as const;

type LaneId = (typeof LANES)[number]["id"];

const LANE_BADGE: Record<LaneId, { label: string; cls: string }> = {
  user: { label: "trace.lane.input", cls: "bg-event-user/15 text-event-user" },
  assistant: { label: "trace.lane.reply", cls: "bg-event-assistant/15 text-event-assistant" },
  tool: { label: "trace.lane.tool", cls: "bg-event-tool/15 text-event-tool" },
  event: { label: "trace.lane.event", cls: "bg-muted-foreground/15 text-muted-foreground" },
};

/** A row/badges tinted by the block's own tone — the tones are the css
 *  variables the theme already defines, so this works in both themes. */
function toneVar(b: TraceBlock): string {
  return `var(--${b.tone.slice(3)})`;
}

/**
 * `traceBlocks` runs inside a fetch, not a render pass, so calling `t()` there
 * would freeze a word in whatever language was active when the events loaded.
 * Stand-in titles carry `titleKey` and are translated where they are shown;
 * the legacy marker words the model emits for the three turn lanes are mapped
 * here too. A title carrying a model id or tool name passes through verbatim.
 */
export function displayTitle(b: TraceBlock): string {
  if (b.titleKey) return t(b.titleKey);
  if (b.lane === "user" && b.title === "输入") return t("trace.lane.input");
  if (b.lane === "assistant" && b.title === "回复") return t("trace.lane.reply");
  if (b.lane === "tool" && b.title === "tool") return t("trace.title.tool");
  return b.title;
}

export function displayPreview(b: TraceBlock): string {
  if (b.lane === "user" && b.preview === "message") return t("trace.preview.message");
  if (b.lane === "assistant" && b.preview === "reply") return t("trace.preview.reply");
  return b.preview;
}

/** Active time at human scale: fmtDuration under an hour, then compact.
 *  Local to the trace — the global fmtDuration stays untouched. */
export function fmtActive(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 3_600_000) return fmtDuration(ms);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  if (h < 24) return `${h}h ${String(m).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Ruler ticks, tighter than fmtActive: `45s`, `63m`, `1h03m`, `3d4h`. */
export function fmtRuler(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  if (h < 24) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function blockLabel(block: TraceBlock): string {
  const title = displayTitle(block);
  const preview = displayPreview(block);
  return `${title}${preview && preview !== title ? ` — ${preview.slice(0, 80)}` : ""}`;
}

const STATUS_LABEL: Record<TraceBlock["status"], string> = {
  ok: "trace.status.ok",
  error: "trace.status.error",
  interrupted: "trace.status.interrupted",
  pending: "trace.status.pending",
};

const STATUS_PILL: Record<TraceBlock["status"], string> = {
  ok: "bg-status-completed/15 text-status-completed",
  error: "bg-status-error/15 text-status-error",
  interrupted: "bg-status-cancelled/15 text-status-cancelled",
  pending: "bg-status-active/15 text-status-active",
};

/* ------------------------------------------------------------------ */
/* persisted prefs                                                     */
/* ------------------------------------------------------------------ */

const MODE_KEY = "strata.trace.mode";
const LIST_KEY = "strata.trace.list";

function readMode(): TraceLayoutMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "duration" || v === "sequence") return v;
  } catch {
    // storage can be refused — the default still works
  }
  return "duration";
}

function writeMode(mode: TraceLayoutMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // best effort
  }
}

function readListOpen(): boolean {
  try {
    return localStorage.getItem(LIST_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeListOpen(open: boolean): void {
  try {
    localStorage.setItem(LIST_KEY, open ? "1" : "0");
  } catch {
    // best effort
  }
}

/* ------------------------------------------------------------------ */
/* panel: toolbar + strip + list                                       */
/* ------------------------------------------------------------------ */

export function TracePanel(props: {
  blocks: TraceBlock[];
  loading: boolean;
  /** the selected block's key — looked up against fresh data by the owner */
  selected: string | null;
  /** `debounce` is set when selection came from the keyboard, so rapid
   *  movement does not fire a replay fetch per keypress */
  onSelect: (block: TraceBlock, opts?: { debounce?: boolean }) => void;
  onClearSelection: () => void;
}) {
  const [mode, setMode] = createSignal<TraceLayoutMode>(readMode());
  const [kind, setKind] = createSignal<TraceFilter["kind"]>("all");
  const [query, setQuery] = createSignal("");
  const [listOpen, setListOpen] = createSignal(readListOpen());

  const filtered = createMemo(() =>
    filterTrace(props.blocks, { query: query(), kind: kind() }, {
      title: displayTitle,
      preview: displayPreview,
    }),
  );
  const matchKeys = createMemo(() => new Set(filtered().map((b) => b.key)));
  const filtering = () => kind() !== "all" || query().trim() !== "";
  const summary = createMemo(() => traceSummary(props.blocks));
  const placed = createMemo(() => layoutTrace(props.blocks, mode()));

  const changeMode = (id: string) => {
    const next = id as TraceLayoutMode;
    setMode(next);
    writeMode(next);
  };
  const toggleList = () => {
    const next = !listOpen();
    setListOpen(next);
    writeListOpen(next);
  };

  /** keyboard navigation — the row the keys move through is the filtered list */
  const moveSelection = (dir: -1 | 1 | "first" | "last") => {
    const rows = filtered();
    if (!rows.length) return;
    const i = rows.findIndex((b) => b.key === props.selected);
    let next: TraceBlock | undefined;
    if (dir === "first") next = rows[0];
    else if (dir === "last") next = rows[rows.length - 1];
    else if (i < 0) next = dir === 1 ? rows[0] : rows[rows.length - 1];
    else next = rows[Math.min(rows.length - 1, Math.max(0, i + dir))];
    if (next && next.key !== props.selected) props.onSelect(next, { debounce: true });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // The search field keeps its keys: only Esc and the arrows mean us.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (query()) setQuery("");
        el.blur();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1);
      }
      return;
    }
    // Tab strips move with their own arrows — leave those keys to them.
    if (el.closest('[role="radiogroup"],[role="tablist"]')) return;
    switch (e.key) {
      case "ArrowDown":
      case "j":
        e.preventDefault();
        e.stopPropagation();
        moveSelection(1);
        break;
      case "ArrowUp":
      case "k":
        e.preventDefault();
        e.stopPropagation();
        moveSelection(-1);
        break;
      case "Home":
        e.preventDefault();
        e.stopPropagation();
        moveSelection("first");
        break;
      case "End":
        e.preventDefault();
        e.stopPropagation();
        moveSelection("last");
        break;
      case "Escape":
        e.stopPropagation();
        props.onClearSelection();
        break;
    }
  };

  return (
    <div class="shrink-0 border-b border-border" onKeyDown={onKeyDown}>
      {/* one slim toolbar: the numbers on the left, the controls on the right */}
      <div class="flex h-9 items-center gap-2 border-b border-border px-4 select-none">
        <span class="min-w-0 flex-1 truncate font-mono text-2xs tabular-nums text-muted-foreground">
          {t("trace.summary", {
            turns: num(summary().turns),
            calls: num(summary().calls),
            duration: fmtActive(summary().durationMs),
            errors: num(summary().errors),
          })}
        </span>
        <MiniTabs
          value={mode()}
          onChange={changeMode}
          options={[
            { id: "duration", label: t("trace.mode.duration") },
            { id: "sequence", label: t("trace.mode.sequence") },
          ]}
          label={t("trace.mode")}
        />
        <MiniTabs
          value={kind()}
          onChange={(id) => setKind(id as TraceFilter["kind"])}
          options={[
            { id: "all", label: t("trace.filter.all") },
            { id: "tool", label: t("trace.filter.tool") },
            { id: "error", label: t("trace.filter.error") },
          ]}
          label={t("trace.filter")}
        />
        <span class="relative">
          <Icon
            name="search"
            class="pointer-events-none absolute top-1/2 left-1.5 h-3 w-3 -translate-y-1/2 text-muted-foreground"
          />
          <TextFieldInput
            type="search"
            size="xs"
            value={query()}
            placeholder={t("trace.search.placeholder")}
            aria-label={t("trace.search.placeholder")}
            class="h-6 w-32 pr-2 pl-6 text-2xs"
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </span>
        <Tip label={t("trace.list.toggle")}>
          <Button
            type="button"
            size="icon-xs"
            variant="icon"
            aria-pressed={listOpen()}
            aria-label={t("trace.list.toggle")}
            class={listOpen() ? "bg-secondary text-foreground" : undefined}
            onClick={toggleList}
          >
            <Icon name="list" class="size-3.5" />
          </Button>
        </Tip>
      </div>
      <Show
        when={!props.loading}
        fallback={<div class="m-3 h-12 rounded-md bg-secondary/50 motion-safe:animate-pulse" />}
      >
        <Show when={props.blocks.length > 0}>
          <TraceStrip
            blocks={props.blocks}
            placed={placed()}
            selected={props.selected}
            dim={(key) => filtering() && !matchKeys().has(key)}
            onSelect={(block) => props.onSelect(block)}
          />
          <Show when={listOpen()}>
            <TraceList
              rows={filtered()}
              selected={props.selected}
              onSelect={(block) => props.onSelect(block)}
            />
          </Show>
        </Show>
      </Show>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* strip                                                               */
/* ------------------------------------------------------------------ */

function TraceStrip(props: {
  blocks: TraceBlock[];
  placed: ReturnType<typeof layoutTrace>;
  selected: string | null;
  dim: (key: string) => boolean;
  onSelect: (block: TraceBlock) => void;
}) {
  const contentWidth = () => props.placed.width;
  const [viewEl, setViewEl] = createSignal<HTMLDivElement>();
  const [viewWidth, setViewWidth] = createSignal(0);
  const [offset, setOffset] = createSignal(0);
  /** Stay on the newest events until the reader moves somewhere else. */
  const [pinned, setPinned] = createSignal(true);
  let glide = 0;
  let drag: { x: number; off: number; moved: boolean } | null = null;
  let swallowClick = false;
  onCleanup(() => cancelAnimationFrame(glide));

  const maxOffset = () => traceMaxOffset(contentWidth(), viewWidth());
  const overflows = () => viewWidth() > 0 && contentWidth() > viewWidth() + 1;
  const shownOffset = () => (pinned() ? maxOffset() : offset());

  const placeAt = (next: number) => {
    const max = maxOffset();
    const value = Math.min(Math.max(0, next), max);
    setOffset(value);
    setPinned(value >= max - 1);
  };

  /** Slide to a page. Dragging and the wheel write the offset directly. */
  const glideTo = (next: number) => {
    cancelAnimationFrame(glide);
    const max = maxOffset();
    const target = Math.min(Math.max(0, next), max);
    const from = shownOffset();
    if (Math.abs(target - from) < 1) {
      placeAt(target);
      return;
    }
    setPinned(false);
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 240);
      const eased = 1 - (1 - t) ** 3;
      const value = from + (target - from) * eased;
      if (t < 1) {
        setOffset(value);
        glide = requestAnimationFrame(step);
      } else placeAt(target);
    };
    glide = requestAnimationFrame(step);
  };

  createEffect(() => {
    const el = viewEl();
    if (!el) return;
    const measure = () => setViewWidth(el.clientWidth);
    const onWheel = (e: WheelEvent) => {
      const view = el.clientWidth;
      const content = contentWidth();
      if (view <= 0 || content <= view + 1) return;
      if (Math.abs(e.deltaX) < 1 || Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
      e.preventDefault();
      cancelAnimationFrame(glide);
      const max = traceMaxOffset(content, view);
      const base = pinned() ? max : offset();
      placeAt(base + e.deltaX);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("wheel", onWheel, { passive: false });
    onCleanup(() => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
    });
  });

  createEffect(() => {
    const max = maxOffset();
    if (pinned()) setOffset(max);
    else setOffset((current) => (current > max ? max : current));
  });

  // Selection changed from the keyboard or the list: glide the strip so the
  // bar it landed on is on screen. Only the selection and the layout trigger
  // this — reading the offset reactively made a manual drag snap straight
  // back to the selected bar.
  createEffect(() => {
    const key = props.selected;
    const placed = props.placed;
    if (!key) return;
    untrack(() => {
      const box = placed.pos.get(key);
      const view = viewWidth();
      if (!box || view <= 0) return;
      const start = shownOffset();
      if (box.left < start || box.left + box.width > start + view) {
        glideTo(box.left + box.width / 2 - view / 2);
      }
    });
  });

  const nudge = (dir: -1 | 1) => glideTo(tracePage(contentWidth(), viewWidth(), shownOffset(), dir));

  // Before the viewport is measured the tail is shown with a container-query
  // shift, so the mounted bars have to be the tail as well.
  const range = createMemo(
    () => {
      const content = contentWidth();
      const view = viewWidth();
      if (view <= 0) return traceWindow(Math.max(0, content - 1600), 1600);
      return traceWindow(shownOffset(), view);
    },
    { start: 0, end: 0 },
    { equals: (a, b) => a.start === b.start && a.end === b.end },
  );

  const visible = createMemo(() => {
    const { start, end } = range();
    const pos = props.placed.pos;
    const out: Record<LaneId, TraceBlock[]> = {
      user: [],
      assistant: [],
      tool: [],
      event: [],
    };
    for (const block of props.blocks) {
      const box = pos.get(block.key);
      if (!box || box.left + box.width < start || box.left > end) continue;
      out[block.lane].push(block);
    }
    return out;
  });

  const shift = () => {
    const width = `${contentWidth()}px`;
    if (pinned() && viewWidth() <= 0) {
      return { width, transform: "translate3d(min(0px, calc(-100% + 100cqw)), 0, 0)" };
    }
    return { width, transform: `translate3d(${-shownOffset()}px, 0, 0)` };
  };

  /** Bar slot inside the lane: whole height for one track, split for stacked
   *  concurrent calls — the lane itself never grows. */
  const slotFor = (lane: LaneId, track: number) => {
    const n = Math.max(1, props.placed.tracks[lane] ?? 1);
    if (n <= 1) return { top: 2, height: 8 };
    const sub = Math.floor(12 / n);
    const h = Math.max(3, sub - 1);
    return { top: Math.min(12 - h, track * sub), height: h };
  };

  return (
    <div class="px-4 pt-2.5 pb-1.5">
      <div class="flex gap-2">
        <div class="w-8 shrink-0 space-y-1">
          <For each={LANES}>
            {(lane) => (
              <div class="flex h-3 items-center text-2xs leading-none text-muted-foreground">
                {t(lane.label as Parameters<typeof t>[0])}
              </div>
            )}
          </For>
          <div class="h-3.5" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="relative">
            <div
              ref={setViewEl}
              class="space-y-1 overflow-hidden"
              style={{ "container-type": "inline-size", "touch-action": "pan-y" }}
              onPointerDown={(e) => {
                if (e.button !== 0 || !overflows()) return;
                if ((e.target as HTMLElement).closest("[data-trace-nav]")) return;
                swallowClick = false;
                cancelAnimationFrame(glide);
                drag = { x: e.clientX, off: shownOffset(), moved: false };
              }}
              onPointerMove={(e) => {
                if (!drag) return;
                const dx = e.clientX - drag.x;
                if (!drag.moved && Math.abs(dx) < 4) return;
                drag.moved = true;
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
                  e.currentTarget.setPointerCapture(e.pointerId);
                }
                placeAt(drag.off - dx);
              }}
              onPointerUp={() => {
                const moved = !!drag?.moved;
                drag = null;
                if (!moved) return;
                // The click that follows a drag must not open a bar. Clear
                // after that click, which is dispatched in this same turn.
                swallowClick = true;
                setTimeout(() => {
                  swallowClick = false;
                });
              }}
              onPointerCancel={() => {
                drag = null;
              }}
            >
              <For each={LANES}>
                {(lane) => (
                  <div class="relative h-3 overflow-hidden rounded-sm bg-secondary/40">
                    <div class="absolute top-0 h-full will-change-transform" style={shift()}>
                      <For each={visible()[lane.id]}>
                        {(block) => {
                          const box = () => props.placed.pos.get(block.key);
                          const label = () => blockLabel(block);
                          const on = () => props.selected === block.key;
                          const dim = () => props.dim(block.key);
                          const slot = () => slotFor(lane.id, box()?.track ?? 0);
                          return (
                            <Tip label={label()}>
                              <button
                                class={`absolute rounded-[2px] ${block.tone} ${
                                  on()
                                    ? "z-10 opacity-100 ring-1 ring-foreground/70"
                                    : dim()
                                      ? "opacity-15 hover:opacity-60"
                                      : block.quiet
                                        ? "opacity-40 hover:opacity-100"
                                        : "opacity-90 hover:opacity-100"
                                }`}
                                style={
                                  block.lane === "event"
                                    ? {
                                        left: `${
                                          (box()?.left ?? 0) + (box()?.width ?? 8) / 2 - 4
                                        }px`,
                                        width: "8px",
                                        height: "8px",
                                        top: `${slot().top + Math.max(0, (slot().height - 8) / 2)}px`,
                                        transform: "rotate(45deg)",
                                      }
                                    : {
                                        left: `${box()?.left ?? 0}px`,
                                        width: `${box()?.width ?? 8}px`,
                                        top: `${slot().top}px`,
                                        height: `${slot().height}px`,
                                      }
                                }
                                aria-label={label()}
                                onClick={() => {
                                  if (swallowClick) {
                                    swallowClick = false;
                                    return;
                                  }
                                  props.onSelect(block);
                                }}
                              />
                            </Tip>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                )}
              </For>
              {/* turn boundaries: a hairline across all lanes at each turn's
                  first block — clipped here, the view is static-positioned so
                  the shifted child would otherwise paint past the lanes */}
              <div
                class="pointer-events-none absolute inset-0 overflow-hidden"
                aria-hidden="true"
              >
                <div class="absolute top-0 h-full will-change-transform" style={shift()}>
                  <For each={props.placed.turns}>
                    {(x) => (
                      <div
                        class="absolute top-0 h-full w-px bg-foreground/8"
                        style={{ left: `${x}px` }}
                      />
                    )}
                  </For>
                  <For each={props.placed.breaks}>
                    {(x) => (
                      <div
                        class="absolute top-0 h-full border-x border-dashed border-muted-foreground/40"
                        style={{ left: `${x}px`, width: "14px" }}
                      />
                    )}
                  </For>
                </div>
              </div>
            </div>
            {/* the ruler runs under the lanes in duration mode */}
            <Show when={props.placed.ruler.length > 0}>
              <div class="relative h-3.5 overflow-hidden">
                <div class="absolute top-0 h-full will-change-transform" style={shift()}>
                  <For each={props.placed.ruler}>
                    {(r) => (
                      <div
                        class="absolute top-0 flex items-center gap-1"
                        style={{ left: `${r.x}px` }}
                      >
                        <span class="h-1.5 w-px bg-border" />
                        <span class="font-mono text-2xs whitespace-nowrap text-muted-foreground/60 tabular-nums">
                          {fmtRuler(r.ms)}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={overflows() && shownOffset() > 1}>
              <button
                type="button"
                data-trace-nav
                class="absolute top-1/2 left-0 z-10 grid h-5 w-4 -translate-y-1/2 place-items-center rounded text-muted-foreground/50 hover:bg-secondary hover:text-foreground"
                aria-label={t("trace.earlier")}
                onClick={() => nudge(-1)}
              >
                <Icon name="chevron" class="h-3 w-3 rotate-90" />
              </button>
            </Show>
            <Show when={overflows() && shownOffset() < maxOffset() - 1}>
              <button
                type="button"
                data-trace-nav
                class="absolute top-1/2 right-0 z-10 grid h-5 w-4 -translate-y-1/2 place-items-center rounded text-muted-foreground/50 hover:bg-secondary hover:text-foreground"
                aria-label={t("trace.later")}
                onClick={() => nudge(1)}
              >
                <Icon name="chevron" class="h-3 w-3 -rotate-90" />
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* list                                                                */
/* ------------------------------------------------------------------ */

/** Fixed row height — positions are arithmetic, never measured. */
const ROW_PX = 28;
const ROW_OVERSCAN = 8;

function TraceList(props: {
  rows: TraceBlock[];
  selected: string | null;
  onSelect: (block: TraceBlock) => void;
}) {
  let scrollEl: HTMLDivElement | undefined;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);

  const range = createMemo(() => {
    const lo = Math.max(0, Math.floor(top() / ROW_PX) - ROW_OVERSCAN);
    const hi = Math.min(
      props.rows.length,
      Math.ceil((top() + height()) / ROW_PX) + ROW_OVERSCAN,
    );
    return { lo, hi };
  });
  const mounted = createMemo(() => props.rows.slice(range().lo, range().hi));
  const indexOf = createMemo(() => {
    const m = new Map<string, number>();
    props.rows.forEach((b, i) => m.set(b.key, i));
    return m;
  });

  createEffect(() => {
    const el = scrollEl;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  // Keep the selected row inside the list's own scrollbox — arithmetic on
  // scrollTop only, never scrollIntoView, so the transcript stays put.
  createEffect(() => {
    const key = props.selected;
    if (!key || !scrollEl) return;
    const i = indexOf().get(key);
    if (i === undefined) return;
    const raf = requestAnimationFrame(() => {
      if (!scrollEl) return;
      const y = i * ROW_PX;
      if (y < scrollEl.scrollTop) scrollEl.scrollTop = y;
      else if (y + ROW_PX > scrollEl.scrollTop + scrollEl.clientHeight) {
        scrollEl.scrollTop = y + ROW_PX - scrollEl.clientHeight;
      }
    });
    onCleanup(() => cancelAnimationFrame(raf));
  });

  const resultPreview = (b: TraceBlock): string =>
    typeof b.result === "string" ? (b.result.split("\n")[0] ?? "").slice(0, 80) : "";

  const turnStep = (b: TraceBlock): string => {
    if (b.turn === undefined) return "";
    return b.step !== undefined ? `${b.turn}·${b.step}` : `${b.turn}`;
  };

  return (
    <div
      class="border-t border-border/60"
      style={{ height: "min(36vh, 320px)" }}
      role="listbox"
      aria-label={t("trace.view")}
    >
      <Show
        when={props.rows.length > 0}
        fallback={
          <div class="grid h-full place-items-center text-2xs text-muted-foreground">
            {t("trace.list.empty")}
          </div>
        }
      >
        <div
          ref={(el) => (scrollEl = el)}
          class="h-full overflow-y-auto overscroll-contain"
          onScroll={(e) => setTop(e.currentTarget.scrollTop)}
        >
          <div style={{ position: "relative", height: `${props.rows.length * ROW_PX}px` }}>
            <For each={mounted()}>
              {(block) => {
                const i = () => indexOf().get(block.key) ?? 0;
                const on = () => props.selected === block.key;
                const badge = () => LANE_BADGE[block.lane];
                const preview = () => displayPreview(block);
                const result = () => resultPreview(block);
                const dur = () => Math.max(0, block.endTs - block.startTs);
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={on()}
                    class={`absolute left-0 flex w-full items-center gap-2 px-2 text-left text-xs ${
                      on() ? "bg-secondary" : "hover:bg-secondary/50"
                    }`}
                    style={{
                      top: `${i() * ROW_PX}px`,
                      height: `${ROW_PX}px`,
                      ...(on()
                        ? { "box-shadow": `inset 2px 0 0 ${toneVar(block)}` }
                        : {}),
                    }}
                    onClick={() => props.onSelect(block)}
                  >
                    <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${block.tone}`} />
                    <span
                      class={`shrink-0 rounded px-1 py-px text-2xs leading-none ${badge().cls}`}
                    >
                      {t(badge().label as Parameters<typeof t>[0])}
                    </span>
                    <span class="w-15 shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                      {turnStep(block)}
                    </span>
                    <span class="min-w-0 flex-1 truncate">
                      <Show when={block.lane !== "user"}>
                        <span class="font-medium">{displayTitle(block)}</span>
                      </Show>
                      <Show when={preview()}>
                        <span
                          class={
                            block.lane === "tool"
                              ? "font-mono text-muted-foreground"
                              : "text-muted-foreground"
                          }
                        >
                          {" "}
                          {preview()}
                        </span>
                      </Show>
                      <Show when={result()}>
                        <span class="text-muted-foreground/70"> → {result()}</span>
                      </Show>
                    </span>
                    <span class="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                      {dur() > 0 ? fmtDuration(dur()) : ""}
                    </span>
                  </button>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* drawer                                                              */
/* ------------------------------------------------------------------ */

type Tab = "overview" | "input" | "result" | "time";

/**
 * One labelled figure. The label must not wrap and the value must be allowed to
 * shrink: a long mono value in a narrow drawer pushes its label onto two
 * lines, which reads as a broken layout rather than as a long value.
 */
function Fact(props: { label: string; value: JSX.Element; class?: string }) {
  return (
    <div class={`flex items-baseline justify-between gap-4 py-2 ${props.class ?? ""}`}>
      <dt class="shrink-0 text-xs text-muted-foreground">{props.label}</dt>
      <dd class="min-w-0 truncate text-right font-mono text-xs tabular-nums">{props.value}</dd>
    </div>
  );
}

/** The token split, as rows. A single total hides the cache columns, which are
 *  the ones that say whether the backend is actually reusing anything. */
function TokenFacts(props: { usage: TraceUsage }) {
  const parts = () => {
    const u = props.usage;
    const out: { label: string; value: number }[] = [];
    if (u.input) out.push({ label: t("info.input"), value: u.input });
    if (u.output) out.push({ label: t("info.output"), value: u.output });
    if (u.reasoning) out.push({ label: t("info.reasoning"), value: u.reasoning });
    if (u.cache_read) out.push({ label: t("info.cache_read"), value: u.cache_read });
    if (u.cache_write) out.push({ label: t("info.cache_write"), value: u.cache_write });
    return out;
  };
  const total = () => parts().reduce((sum, p) => sum + p.value, 0);
  return (
    <>
      <Fact label={t("info.tokens")} value={num(total())} />
      <For each={parts()}>{(part) => <Fact label={part.label} value={num(part.value)} />}</For>
    </>
  );
}

function statusText(b: TraceBlock): string {
  return t(STATUS_LABEL[b.status] as Parameters<typeof t>[0]);
}

function decisionText(p: TracePermission): string {
  if (p.decision === "deny") return t("trace.decision.deny");
  if (p.decision === "allow") return t("trace.decision.allow");
  return t("trace.status.pending");
}

/** The marker's own facts — what the event lane can say beyond title and time. */
function EventFacts(props: { block: TraceBlock }) {
  const ev = () => (props.block.event ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : undefined);
  return (
    <dl class="divide-y divide-border border-t border-border">
      <Show when={props.block.kind === "compacted" || props.block.kind === "compacting"}>
        <Fact
          label={t("trace.field.trigger")}
          value={t(
            ev().overflow === true
              ? "trace.event.overflow"
              : ev().auto === true
                ? "trace.event.auto"
                : "trace.event.manual",
          )}
        />
      </Show>
      <Show when={props.block.kind === "error"}>
        <Show when={s(ev().name)}>
          <Fact label={t("trace.field.name")} value={s(ev().name)!} />
        </Show>
        <Show when={s(ev().message)}>
          <Fact label={t("trace.field.message")} value={s(ev().message)!} />
        </Show>
        <Show when={typeof ev().statusCode === "number"}>
          <Fact label={t("trace.field.code")} value={String(ev().statusCode)} />
        </Show>
        <Show when={typeof ev().isRetryable === "boolean"}>
          <Fact
            label={t("trace.field.retryable")}
            value={t(ev().isRetryable === true ? "trace.yes" : "trace.no")}
          />
        </Show>
      </Show>
      <Show when={props.block.kind === "retry"}>
        <Fact
          label={t("trace.field.attempt")}
          value={t("trace.event.retry.count", { n: num(props.block.count ?? 1) })}
        />
        <Show when={s(ev().message)}>
          <Fact label={t("trace.field.message")} value={s(ev().message)!} />
        </Show>
        <Show when={typeof ev().attempt === "number"}>
          <Fact label={t("trace.field.retry_no")} value={num(ev().attempt as number)} />
        </Show>
        <Show when={typeof ev().next === "number"}>
          <Fact label={t("trace.field.next")} value={stamp(ev().next as number)} />
        </Show>
      </Show>
      <Show when={props.block.kind === "permission" && props.block.permission}>
        {(p) => (
          <>
            <Show when={p().tool}>
              <Fact label={t("trace.lane.tool")} value={p().tool!} />
            </Show>
            <Fact label={t("trace.field.decision")} value={decisionText(p())} />
            <Show when={p().by}>
              <Fact label={t("trace.field.by")} value={p().by!} />
            </Show>
            <Show when={p().rule_id ?? p().reason}>
              <Fact label={t("trace.field.rule")} value={(p().rule_id ?? p().reason)!} />
            </Show>
          </>
        )}
      </Show>
      <Show when={props.block.kind === "goal"}>
        <Show when={s(ev().text)}>
          <Fact label={t("trace.event.goal")} value={s(ev().text)!} />
        </Show>
        <Show when={ev().met === true || ev().paused === true}>
          <Fact
            label={t("trace.field.status")}
            value={t(ev().met === true ? "trace.event.goal.met" : "trace.event.goal.paused")}
          />
        </Show>
      </Show>
    </dl>
  );
}

/** The goal marker's text and the plan marker's entries read as prose, not as
 *  one-line facts — they get their own sections. */
function EventSections(props: { block: TraceBlock }) {
  const ev = () => (props.block.event ?? {}) as Record<string, unknown>;
  const entries = () =>
    (Array.isArray(ev().entries) ? ev().entries : []) as { content?: string; status?: string }[];
  const questions = () =>
    (Array.isArray(ev().questions) ? ev().questions : []) as {
      question?: string;
      header?: string;
    }[];
  const answers = () => (Array.isArray(ev().answers) ? (ev().answers as string[][]) : []).flat();
  return (
    <>
      <Show when={props.block.kind === "question" && questions().length > 0}>
        <section class="mt-4">
          <h3 class="mb-1.5 text-2xs font-medium text-muted-foreground">
            {t("trace.event.question")}
          </h3>
          <ul class="space-y-1.5">
            <For each={questions()}>
              {(q) => (
                <li class="text-xs leading-relaxed">
                  <Show when={q.header}>
                    <span class="text-muted-foreground">{q.header} · </span>
                  </Show>
                  {q.question}
                </li>
              )}
            </For>
          </ul>
          <Show when={answers().length > 0}>
            <h3 class="mt-3 mb-1.5 text-2xs font-medium text-muted-foreground">
              {t("trace.field.answers")}
            </h3>
            <ul class="space-y-1">
              <For each={answers()}>{(a) => <li class="text-xs">{a}</li>}</For>
            </ul>
          </Show>
        </section>
      </Show>
      <Show when={props.block.kind === "plan" && entries().length > 0}>
        <section class="mt-4">
          <h3 class="mb-1.5 text-2xs font-medium text-muted-foreground">
            {t("trace.event.plan")}
          </h3>
          <ul class="space-y-1">
            <For each={entries()}>
              {(entry) => (
                <li class="flex items-baseline gap-2 text-xs">
                  <span
                    class={`h-1.5 w-1.5 shrink-0 self-center rounded-full ${
                      entry.status === "completed"
                        ? "bg-status-completed"
                        : entry.status === "in_progress"
                          ? "bg-status-active"
                          : "bg-muted-foreground/50"
                    }`}
                  />
                  <span
                    class={
                      entry.status === "completed" ? "text-muted-foreground line-through" : ""
                    }
                  >
                    {entry.content}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={props.block.kind === "goal" && typeof ev().text === "string"}>
        <section class="mt-4">
          <Md text={String(ev().text)} class="text-xs leading-[1.65]" />
        </section>
      </Show>
      <Show when={props.block.kind === "file" && (props.block.files?.length ?? 0) > 0}>
        <section class="mt-4">
          <h3 class="mb-1.5 text-2xs font-medium text-muted-foreground">
            {t("trace.field.files")}
          </h3>
          <ul class="divide-y divide-border border-t border-border">
            <For each={props.block.files}>
              {(f: TraceFile) => (
                <li class="py-1.5">
                  <div class="flex items-baseline justify-between gap-3">
                    <span class="min-w-0 truncate font-mono text-xs">{f.path}</span>
                    <span class="shrink-0 font-mono text-2xs text-muted-foreground">
                      {f.change}
                    </span>
                  </div>
                  <Show when={f.diff}>
                    <div class="mt-1.5">
                      <Payload value={f.diff} maxHeight="max-h-40" />
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </>
  );
}

export function TraceDrawer(props: {
  block: TraceBlock;
  /** the assistant message a tool call was declared by */
  parent?: TraceBlock;
  /** idle time between the previous block's end and this one's start */
  gapMs?: number;
  onOpenChild?: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = createSignal<Tab>("overview");
  createEffect(() => {
    props.block.key;
    setTab("overview");
  });

  const tabs = (): { id: Tab; label: string }[] => {
    const out: { id: Tab; label: string }[] = [
      { id: "overview", label: t("trace.tab.overview") },
    ];
    if (props.block.input) out.push({ id: "input", label: t("trace.tab.input") });
    if (props.block.result) out.push({ id: "result", label: t("trace.tab.result") });
    out.push({ id: "time", label: t("trace.tab.time") });
    return out;
  };

  const clock = (ms: number) => (ms > 0 ? stamp(new Date(ms)) : "—");

  const elapsed = () => {
    const d = Math.max(0, props.block.endTs - props.block.startTs);
    return d > 0 ? d : props.block.latencyMs;
  };

  const subtitle = () => {
    const b = props.block;
    if (b.turn === undefined) return "";
    if (b.step !== undefined) return t("trace.step", { turn: b.turn, step: b.step });
    return t("trace.turn", { turn: b.turn });
  };

  const levelText = () => {
    const b = props.block;
    if (b.lane === "user") return t("trace.level.input");
    if (b.lane === "assistant") return t("trace.level.assistant");
    if (b.lane === "event") return t("trace.level.event");
    const base = t("trace.level.tool");
    const parent = props.parent;
    return parent
      ? `${base} ← ${t("trace.level.assistant")} ${displayTitle(parent)}`
      : base;
  };

  const hasFacts = () =>
    !!props.block.model ||
    !!props.block.agent ||
    !!props.block.variant ||
    !!props.block.stopReason ||
    !!props.block.usage ||
    props.block.costUsd !== undefined;

  const permText = () => {
    const p = props.block.permission;
    if (!p) return "";
    return [decisionText(p), p.by, p.rule_id ?? p.reason].filter(Boolean).join(" · ");
  };

  return (
    <aside class="flex w-[22rem] shrink-0 flex-col border-l border-border bg-card/30">
      <div
        class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 select-none"
        data-tauri-drag-region={inDesktopShell() ? "" : undefined}
      >
        <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${props.block.tone}`} />
        <div class="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 class="min-w-0 truncate text-sm font-medium">{displayTitle(props.block)}</h2>
          <Show when={subtitle()}>
            <p class="shrink-0 truncate font-mono text-2xs text-muted-foreground tabular-nums">
              {subtitle()}
            </p>
          </Show>
        </div>
        <span
          class={`shrink-0 rounded px-1.5 py-px text-2xs ${STATUS_PILL[props.block.status]}`}
        >
          {statusText(props.block)}
        </span>
        <Tip label={t("trace.action.close")}>
          <Button
            type="button"
            size="icon-sm"
            variant="icon"
            aria-label={t("trace.action.close")}
            onClick={() => props.onClose()}
          >
            ×
          </Button>
        </Tip>
      </div>
      <MiniTabs
        value={tab()}
        onChange={(id) => setTab(id as Tab)}
        options={tabs().map((item) => ({ id: item.id, label: item.label }))}
        label={t("trace.view")}
        class="gap-1 px-3 pt-3"
      />
      <div class="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-4">
        <Show when={tab() === "overview"}>
          {/* What kind of thing this is and where it sits, before any
              backend-reported facts. */}
          <dl class="divide-y divide-border border-t border-border">
            <Fact
              label={t("trace.field.status")}
              value={
                <span class={STATUS_PILL[props.block.status].split(" ")[1]}>
                  {statusText(props.block)}
                </span>
              }
            />
            <Fact label={t("trace.field.level")} value={levelText()} />
            <Show when={props.block.model}>
              <Fact label={t("info.model")} value={props.block.model!} />
            </Show>
            <Show when={props.block.agent}>
              <Fact label={t("trace.field.agent")} value={props.block.agent!} />
            </Show>
            <Show when={props.block.variant}>
              <Fact label={t("trace.field.variant")} value={props.block.variant!} />
            </Show>
            <Show when={props.block.stopReason}>
              <Fact label={t("trace.field.finish")} value={props.block.stopReason!} />
            </Show>
            <Show when={props.block.errorText}>
              <Fact label={t("trace.field.error")} value={props.block.errorText!} />
            </Show>
            <Show when={props.block.permission && props.block.lane !== "event"}>
              <Fact label={t("trace.field.permission")} value={permText()} />
            </Show>
            <Show when={props.block.usage}>
              <TokenFacts usage={props.block.usage!} />
            </Show>
            <Show when={props.block.costUsd !== undefined}>
              <Fact label={t("info.cost")} value={fmtUsd(props.block.costUsd!)} />
            </Show>
          </dl>
          <Show when={props.block.kind}>
            <EventFacts block={props.block} />
          </Show>

          <Show when={props.block.preview}>
            <div class="mt-3">
              <Md text={displayPreview(props.block)} class="text-xs leading-[1.65]" />
            </div>
          </Show>

          {/* Thinking is collapsed behind the reply: it exists for the reader
              who asks "what was it doing", not for the one reading the answer. */}
          <Show when={props.block.thinking}>
            <details class="group mt-4">
              <summary class="flex cursor-pointer items-center gap-1.5 text-2xs font-medium text-muted-foreground select-none">
                <Icon
                  name="chevron-right"
                  class="h-3 w-3 transition-transform group-open:rotate-90"
                />
                {t("trace.field.thinking")}
                <Show when={props.block.thinkingMs !== undefined}>
                  <span class="font-mono tabular-nums">
                    {" "}
                    · {fmtDuration(props.block.thinkingMs!)}
                  </span>
                </Show>
              </summary>
              <div class="mt-1.5">
                <Md
                  text={props.block.thinking!}
                  class="text-xs leading-[1.65] text-muted-foreground"
                />
              </div>
            </details>
          </Show>

          <Show when={(props.block.files?.length ?? 0) > 0 && props.block.lane !== "event"}>
            <section class="mt-4">
              <h3 class="mb-1.5 text-2xs font-medium text-muted-foreground">
                {t("trace.field.files")}
              </h3>
              <ul class="divide-y divide-border border-t border-border">
                <For each={props.block.files}>
                  {(f) => (
                    <li class="flex items-baseline justify-between gap-3 py-1.5">
                      <span class="min-w-0 truncate font-mono text-xs">{f.path}</span>
                      <span class="shrink-0 font-mono text-2xs text-muted-foreground">
                        {f.change}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          <EventSections block={props.block} />

          <Show when={props.block.childSessionId && props.onOpenChild}>
            <Button
              type="button"
              size="xs"
              variant="outline"
              class="mt-4"
              onClick={() => props.onOpenChild!(props.block.childSessionId!)}
            >
              {t("trace.open.child")}
            </Button>
          </Show>

          <Show when={props.block.result !== undefined}>
            <section class="mt-4">
              <h3 class="mb-1.5 text-2xs font-medium text-muted-foreground">
                {t("trace.section.result")}
              </h3>
              <Payload value={props.block.result} maxHeight="max-h-48" />
            </section>
          </Show>

          {/* One row per model call inside this message. The message-level
              figures above are their sum; the steps say which call spent it
              and how each one ended. */}
          <Show when={props.block.steps?.length}>
            <section class="mt-4">
              <h3 class="mb-1.5 text-2xs font-medium text-muted-foreground">
                {t("trace.section.steps")}
              </h3>
              <ul class="divide-y divide-border border-t border-border">
                <For each={props.block.steps}>
                  {(step, i) => (
                    <li class="flex items-baseline justify-between gap-3 py-1.5">
                      <span class="min-w-0 truncate text-xs">
                        <span class="font-mono text-2xs text-muted-foreground">{i() + 1}</span>
                        {" · "}
                        {step.reason}
                      </span>
                      <span class="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                        {num(step.usage.input + step.usage.output + (step.usage.reasoning ?? 0))}
                        {" · "}
                        {fmtUsd(step.cost_usd)}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
        </Show>
        <Show when={tab() === "input"}>
          <Block label={t("trace.section.input")} value={props.block.input} />
        </Show>
        <Show when={tab() === "result"}>
          <Block label={t("trace.section.result")} value={props.block.result} />
        </Show>
        <Show when={tab() === "time"}>
          {/* Only the clock here. The model, the tokens and the price are facts
              about the message, not about when it ran, and they live in 概述. */}
          <dl class="divide-y divide-border border-t border-border">
            <Fact label={t("trace.field.started")} value={clock(props.block.startTs)} />
            <Fact label={t("trace.field.ended")} value={clock(props.block.endTs)} />
            <Show when={elapsed() !== undefined}>
              <Fact label={t("trace.field.elapsed")} value={fmtDuration(elapsed()!)} />
            </Show>
            <Show when={props.block.thinkingMs !== undefined}>
              <Fact
                label={t("trace.field.thinkingTime")}
                value={fmtDuration(props.block.thinkingMs!)}
              />
            </Show>
            <Show when={props.gapMs !== undefined}>
              <Fact label={t("trace.field.gap")} value={fmtDuration(props.gapMs!)} />
            </Show>
          </dl>
        </Show>
      </div>
    </aside>
  );
}

/** A labelled, bordered payload. Structured data wants a frame, not loose text. */
function Block(props: { label: string; value: unknown }) {
  const text = () =>
    typeof props.value === "string"
      ? props.value
      : props.value === undefined
        ? ""
        : JSON.stringify(props.value, null, 2);

  return (
    <section>
      <div class="group mb-1.5 flex items-center justify-between gap-2">
        <h3 class="text-2xs font-medium text-muted-foreground">{props.label}</h3>
        <Show when={text()}>
          <CopyButton text={text()} />
        </Show>
      </div>
      <Payload value={props.value} empty={t("trace.empty")} />
    </section>
  );
}
