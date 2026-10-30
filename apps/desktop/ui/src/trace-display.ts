import { fmtDuration } from "./api";
import { t } from "./i18n";
import type { TraceBlock } from "./trace-model";

/** `traceBlocks` runs inside a fetch, not a render pass, so calling `t()` there
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

const STATUS_LABEL: Record<TraceBlock["status"], Parameters<typeof t>[0]> = {
  ok: "trace.status.ok",
  error: "trace.status.error",
  interrupted: "trace.status.interrupted",
  pending: "trace.status.pending",
};

export function traceStatusText(b: TraceBlock): string {
  return t(STATUS_LABEL[b.status]);
}

export function tracePosition(b: TraceBlock): string {
  if (b.turn === undefined) return "";
  return b.step !== undefined
    ? t("trace.step", { turn: b.turn, step: b.step })
    : t("trace.turn", { turn: b.turn });
}

/** Only a real clock produces a duration; an instantaneous marker is not 0ms
 * of measured work. */
export function traceBlockDuration(b: TraceBlock): number | undefined {
  const elapsed = Math.max(0, b.endTs - b.startTs);
  if (elapsed > 0) return elapsed;
  return b.latencyMs !== undefined && b.latencyMs > 0 ? b.latencyMs : undefined;
}

export interface TraceTooltip {
  position: string;
  title: string;
  preview: string;
  status: string;
  durationMs?: number;
  text: string;
}

export function traceBlockTooltip(b: TraceBlock): TraceTooltip {
  const position = tracePosition(b);
  const title = displayTitle(b);
  const preview = displayPreview(b);
  const status = traceStatusText(b);
  const durationMs = traceBlockDuration(b);
  const summary = `${title}${preview && preview !== title ? ` — ${preview.slice(0, 240)}` : ""}`;
  const text = [
    position,
    summary,
    status,
    durationMs === undefined ? "" : `${t("trace.field.elapsed")}: ${fmtDuration(durationMs)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return { position, title, preview, status, durationMs, text };
}

export function traceFoldLabel(durationMs: number): string {
  return t("trace.folded", { duration: fmtActive(durationMs) });
}

export type TraceMarkerShape = "circle" | "diamond" | "triangle";

export function traceMarkerShape(b: TraceBlock): TraceMarkerShape {
  if (b.status === "error" || b.status === "interrupted" || b.kind === "error" || b.kind === "retry") {
    return "triangle";
  }
  if (b.kind === "permission" || b.kind === "question") return "diamond";
  return "circle";
}

export const TRACE_LANE_PX = 20;

/** Center one to three tracks in a lane instead of squeezing them into the
 * old fixed 12px box. */
export function traceLaneSlot(track: number, trackCount: number): { top: number; height: number } {
  const n = Math.max(1, Math.min(3, Math.floor(trackCount)));
  const gap = n > 1 ? 2 : 0;
  const height = n === 1 ? 12 : Math.max(4, Math.floor((TRACE_LANE_PX - 4 - gap * (n - 1)) / n));
  const stackHeight = height * n + gap * (n - 1);
  const index = Math.max(0, Math.min(n - 1, Math.floor(track)));
  return { top: (TRACE_LANE_PX - stackHeight) / 2 + index * (height + gap), height };
}
