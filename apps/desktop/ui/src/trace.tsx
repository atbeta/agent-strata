import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { fmtDuration, fmtUsd, getJson, type StrataEvent } from "./api";
import { inDesktopShell } from "./shell";
import { Md } from "./md";
import { Tip } from "./tip";
import { CopyButton, Payload } from "./payload";
import { num, stamp, t } from "./i18n";
import { Icon } from "./icons";
import { mergeUserBar, traceMaxOffset, tracePage, traceWindow } from "./trace-window";
import { Button } from "@/components/ui/button";
import { MiniTabs } from "@/components/ui/mini-tabs";

export interface TraceUsage {
  input: number;
  output: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface TraceBlock {
  key: string;
  seq: number;
  ts: string;
  lane: "user" | "assistant" | "tool";
  title: string;
  preview: string;
  /** Raw event payloads, not serialised. The drawer decides how to render them:
   *  a JSON value becomes a tree, a string becomes highlighted text. */
  input?: unknown;
  result?: unknown;
  /** Measured duration, when the backend reported one. Kept as a number so the
   *  strip can size a lane by it — this used to be scraped back out of a joined
   *  display string with a regex. */
  latencyMs?: number;
  /** Token counts, kept split rather than summed: the cache columns are the
   *  interesting ones and a total hides them. */
  usage?: TraceUsage;
  costUsd?: number;
  model?: string;
  agent?: string;
  variant?: string;
  stopReason?: string;
  tone: string;
  error?: boolean;
  /** thinking only, no user-visible text */
  quiet?: boolean;
}

/** `label` holds the dictionary key; the row renders `t()` over it. */
const LANES = [
  { id: "user", label: "trace.lane.input", dot: "bg-event-user" },
  { id: "assistant", label: "trace.lane.reply", dot: "bg-event-assistant" },
  { id: "tool", label: "trace.lane.tool", dot: "bg-event-tool" },
] as const;

function parts(content: unknown): { type?: string; text?: string }[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && typeof b === "object") as { type?: string; text?: string }[];
}

function textOf(content: unknown, kind: "spoken" | "thinking"): string {
  return parts(content)
    .filter((b) => (kind === "thinking" ? b.type === "thinking" : b.type !== "thinking"))
    .map((b) => b.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function toolTone(name: string): string {
  const n = name.toLowerCase();
  if (n === "bash" || n.includes("shell") || n === "powershell" || n === "cmd") return "bg-status-cancelled";
  if (n.includes("search") || n.includes("fetch") || n.includes("web")) return "bg-event-tool";
  if (/(^|_)(read|glob|grep|list)($|_)/.test(n) || n === "read") return "bg-event-file";
  if (n.includes("edit") || n.includes("write") || n.includes("patch")) return "bg-event-user";
  if (n === "question" || n.includes("ask")) return "bg-event-permission";
  if (n === "skill") return "bg-status-completed";
  return "bg-primary";
}

function inputPreview(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return pretty(input);
  const o = input as Record<string, unknown>;
  for (const key of ["query", "command", "url", "path", "file_path", "pattern", "name", "prompt"]) {
    if (typeof o[key] === "string" && o[key]) return o[key] as string;
  }
  if (Array.isArray(o.questions) && o.questions[0] && typeof o.questions[0] === "object") {
    const q = (o.questions[0] as { question?: string }).question;
    if (q) return q;
  }
  return pretty(input);
}

function pretty(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A finite number, or nothing. A backend that sent null or a string gets dropped
 *  rather than rendered as `NaN`. */
function numOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageOf(value: unknown): TraceUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const input = numOf(u.input);
  const output = numOf(u.output);
  if (input === undefined && output === undefined) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    reasoning: numOf(u.reasoning),
    cache_read: numOf(u.cache_read),
    cache_write: numOf(u.cache_write),
  };
}

export function traceBlocks(events: StrataEvent[]): TraceBlock[] {
  const blocks: TraceBlock[] = [];
  const tools = new Map<string, TraceBlock>();
  const assistants = new Map<string, TraceBlock>();
  const users = new Map<string, TraceBlock>();
  for (const e of events) {
    const d = e.data;
    if (e.type === "turn.user") {
      const turnId = String(d.turn_id ?? e.id);
      const preview = textOf(d.content, "spoken") || "message";
      const prev = users.get(turnId);
      const merged = mergeUserBar(prev, { seq: e.seq, ts: e.ts, preview });
      if (prev) {
        prev.seq = merged.seq;
        prev.ts = merged.ts;
        prev.preview = merged.preview;
      } else {
        const block: TraceBlock = {
          key: turnId,
          seq: merged.seq,
          ts: merged.ts,
          lane: "user",
          title: "输入",
          preview: merged.preview,
          tone: "bg-event-user",
        };
        users.set(turnId, block);
        blocks.push(block);
      }
    } else if (e.type === "turn.assistant") {
      const id = String(d.msg_id ?? e.id);
      const spoken = textOf(d.content, "spoken");
      const thought = textOf(d.content, "thinking");
      const model = d.model ? String(d.model) : undefined;
      const agent = d.agent ? String(d.agent) : undefined;
      const variant = d.variant ? String(d.variant) : undefined;
      const stopReason = d.stop_reason ? String(d.stop_reason) : undefined;
      // Each of these is its own field. They used to be joined into one "detail"
      // string, which put the model id and the price under a label reading
      // "Elapsed" and forced the strip to regex the milliseconds back out.
      const latencyMs = numOf(d.latency_ms);
      const usage = usageOf(d.usage);
      const costUsd = numOf(d.cost_usd);
      const prev = assistants.get(id);
      if (prev) {
        prev.seq = e.seq;
        prev.ts = e.ts;
        prev.preview = spoken || thought.slice(0, 280) || prev.preview;
        prev.quiet = !spoken;
        prev.model = model ?? prev.model;
        prev.agent = agent ?? prev.agent;
        prev.variant = variant ?? prev.variant;
        prev.stopReason = stopReason ?? prev.stopReason;
        if (latencyMs !== undefined) prev.latencyMs = latencyMs;
        if (usage) prev.usage = usage;
        if (costUsd !== undefined) prev.costUsd = costUsd;
        prev.tone = "bg-event-assistant";
        prev.title = model ? model.slice(model.indexOf("/") + 1) : prev.title;
      } else {
        const block: TraceBlock = {
          key: id,
          seq: e.seq,
          ts: e.ts,
          lane: "assistant",
          title: model ? model.slice(model.indexOf("/") + 1) : "回复",
          preview: spoken || thought.slice(0, 280) || "reply",
          latencyMs,
          usage,
          costUsd,
          model,
          agent,
          variant,
          stopReason,
          tone: "bg-event-assistant",
          quiet: !spoken,
        };
        assistants.set(id, block);
        blocks.push(block);
      }
    } else if (e.type === "tool.call") {
      const callId = String(d.call_id ?? e.id);
      const title = String(d.tool ?? "tool");
      const block: TraceBlock = {
        key: callId,
        seq: e.seq,
        ts: e.ts,
        lane: "tool",
        title,
        preview: inputPreview(d.input) || title,
        input: d.input,
        tone: toolTone(title),
      };
      tools.set(callId, block);
      blocks.push(block);
    } else if (e.type === "tool.result") {
      const callId = String(d.call_id ?? "");
      const block = tools.get(callId);
      const output = d.output;
      const failed = d.status === "error";
      if (block) {
        block.seq = e.seq;
        block.ts = e.ts;
        block.result = output;
        block.error = failed;
        if (failed) block.tone = "bg-status-error";
        if (typeof d.latency_ms === "number") block.latencyMs = d.latency_ms;
      }
    }
  }
  return blocks;
}

/**
 * `traceBlocks` runs inside a fetch, not a render pass, so calling `t()` there
 * would freeze a word in whatever language was active when the events loaded.
 * The stand-in words travel through the data as markers and are translated at
 * the two places a title or preview is actually shown. A title that carries a
 * model id or a tool name is passed through untouched, like every other piece of
 * text the backend sends.
 */
function displayTitle(b: TraceBlock): string {
  if (b.lane === "user" && b.title === "输入") return t("trace.lane.input");
  if (b.lane === "assistant" && b.title === "回复") return t("trace.lane.reply");
  if (b.lane === "tool" && b.title === "tool") return t("trace.title.tool");
  return b.title;
}

function displayPreview(b: TraceBlock): string {
  if (b.lane === "user" && b.preview === "message") return t("trace.preview.message");
  if (b.lane === "assistant" && b.preview === "reply") return t("trace.preview.reply");
  return b.preview;
}

function layout(blocks: TraceBlock[]) {
  const sorted = [...blocks].sort((a, b) => a.seq - b.seq);
  const pos = new Map<string, { left: number; width: number }>();
  let x = 0;
  let prev = 0;
  for (const b of sorted) {
    const t = Date.parse(b.ts);
    const gap = prev && Number.isFinite(t) ? t - prev : 0;
    const space = gap > 2_000 ? Math.min(18, Math.round(gap / 12_000)) : 0;
    const ms = b.latencyMs ?? 0;
    const width = b.lane === "user" ? 7 : Math.min(28, 9 + (ms > 4_000 ? 8 : ms > 800 ? 4 : 0));
    x += space;
    pos.set(b.key, { left: x, width });
    x += width + 4;
    if (Number.isFinite(t)) prev = t;
  }
  return { pos, width: x };
}

function blockLabel(block: TraceBlock): string {
  const title = displayTitle(block);
  const preview = displayPreview(block);
  return `${title}${preview && preview !== title ? ` — ${preview.slice(0, 80)}` : ""}`;
}

export function TraceStrip(props: {
  sessionId: string;
  selected: string | null;
  onSelect: (block: TraceBlock) => void;
}) {
  const [events] = createResource(
    () => props.sessionId,
    async (id) => {
      const r = await getJson<{ events: StrataEvent[] }>(
        `/events?session_id=${encodeURIComponent(id)}&order=asc&limit=2000`,
      );
      return traceBlocks(r.events);
    },
  );

  const placed = createMemo(() => layout(events() ?? []));
  const contentWidth = () => placed().width;
  const [viewEl, setViewEl] = createSignal<HTMLDivElement>();
  const [viewWidth, setViewWidth] = createSignal(0);
  const [offset, setOffset] = createSignal(0);
  /** Stay on the newest events until the reader moves somewhere else. */
  const [pinned, setPinned] = createSignal(true);
  let glide = 0;
  let drag: { x: number; off: number; moved: boolean } | null = null;
  let swallowClick = false;
  onCleanup(() => cancelAnimationFrame(glide));

  createEffect(() => {
    props.sessionId;
    cancelAnimationFrame(glide);
    setPinned(true);
  });

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
    const pos = placed().pos;
    const out: Record<(typeof LANES)[number]["id"], TraceBlock[]> = {
      user: [],
      assistant: [],
      tool: [],
    };
    for (const block of events() ?? []) {
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

  return (
    <div class="shrink-0 border-b border-border px-4 py-2.5">
      <Show
        when={!events.loading}
        fallback={<div class="h-8 motion-safe:animate-pulse rounded-md bg-secondary/50" />}
      >
        <Show when={(events()?.length ?? 0) > 0} fallback={null}>
          <div class="flex gap-2">
            <div class="w-8 shrink-0 space-y-1">
              <For each={LANES}>
                {(lane) => (
                  <div class="flex h-3 items-center text-2xs leading-none text-muted-foreground">
                    {t(lane.label)}
                  </div>
                )}
              </For>
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
                              const box = () => placed().pos.get(block.key);
                              const label = () => blockLabel(block);
                              const on = () => props.selected === block.key;
                              return (
                                <Tip label={label()}>
                                  <button
                                    class={`absolute rounded-[2px] ${block.tone} ${
                                      on()
                                        ? "z-10 opacity-100"
                                        : block.quiet
                                          ? "opacity-40 hover:opacity-100"
                                          : "opacity-90 hover:opacity-100"
                                    }`}
                                    style={{
                                      left: `${box()?.left ?? 0}px`,
                                      width: `${box()?.width ?? 8}px`,
                                      top: on() ? "0px" : "2px",
                                      height: on() ? "12px" : "8px",
                                    }}
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
                </div>
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
        </Show>
      </Show>
    </div>
  );
}

type Tab = "overview" | "input" | "result" | "time";

/**
 * One labelled figure. The label must not wrap and the value must be allowed to
 * shrink: a long mono value in a 320px drawer used to push its label onto two
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

export function TraceDrawer(props: { block: TraceBlock; onClose: () => void }) {
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

  const when = () => {
    const at = new Date(props.block.ts);
    // Falls back to the raw string when the backend sent something unparseable,
    // which is a better answer than "Invalid Date".
    return Number.isNaN(at.getTime()) ? props.block.ts : stamp(at);
  };

  const hasFacts = () =>
    !!props.block.model ||
    !!props.block.agent ||
    !!props.block.variant ||
    !!props.block.stopReason ||
    !!props.block.usage ||
    props.block.costUsd !== undefined;

  return (
    <aside class="flex w-80 shrink-0 flex-col border-l border-border bg-card/30">
      <div
        class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 select-none"
        data-tauri-drag-region={inDesktopShell() ? "" : undefined}
      >
        <span
          class={`h-1.5 w-1.5 shrink-0 rounded-full ${props.block.tone}`}
        />
        <h2 class="min-w-0 flex-1 truncate text-sm font-medium">{displayTitle(props.block)}</h2>
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
        onChange={setTab}
        options={tabs().map((item) => ({ id: item.id, label: item.label }))}
        label={t("trace.view")}
        class="gap-1 px-3 pt-3"
      />
      <div class="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-4">
        <Show when={tab() === "overview"}>
          <Md text={props.block.preview} class="text-xs leading-[1.65]" />

          {/* What the backend measured about this message, as its own fields.
              It used to be one "detail" string glued together with · and printed
              under 概述 as a footnote. */}
          <Show when={hasFacts()}>
            <dl class="mt-3 divide-y divide-border border-t border-border">
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
              <Show when={props.block.usage}>
                <TokenFacts usage={props.block.usage!} />
              </Show>
              <Show when={props.block.costUsd !== undefined}>
                <Fact label={t("info.cost")} value={fmtUsd(props.block.costUsd!)} />
              </Show>
            </dl>
          </Show>

          <Show when={props.block.result !== undefined}>
            <section class="mt-4">
              <h3 class="mb-1.5 text-2xs font-medium text-muted-foreground">
                {t("trace.section.result")}
              </h3>
              <Payload value={props.block.result} maxHeight="max-h-48" />
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
            <Fact label={t("trace.field.started")} value={when()} />
            <Show when={props.block.latencyMs !== undefined}>
              <Fact label={t("trace.field.elapsed")} value={fmtDuration(props.block.latencyMs!)} />
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
