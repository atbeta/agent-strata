import { fmtUsd, type Turn } from "./api";
import { num, stamp, t } from "./i18n";
import { assistantMetrics, fmtLatency } from "./transcript-format";

export type AssistantMessageData = Turn["assistant"][number];
export type MessageDetail = { key: string; label: string; value: string };

export function assistantMessageDetails(message?: AssistantMessageData): MessageDetail[] {
  if (!message) return [];
  const rows: MessageDetail[] = [];
  const text = (key: string, label: string, value?: string) => {
    if (value?.trim()) rows.push({ key, label, value });
  };

  text("model", t("info.model"), message.model);
  text("agent", t("message.details.agent"), message.agent);
  text("variant", t("message.details.variant"), message.variant);
  if (message.latency_ms !== undefined) {
    rows.push({
      key: "latency_ms",
      label: t("message.details.latency"),
      value: fmtLatency(message.latency_ms)!,
    });
  }
  const metrics = assistantMetrics(message);
  if (metrics.ttft_ms !== undefined) {
    rows.push({ key: "ttft_ms", label: t("message.details.ttft"), value: fmtLatency(metrics.ttft_ms)! });
  }
  if (message.usage) {
    const usage = [
      ["input", t("info.input"), message.usage.input],
      ["output", t("info.output"), message.usage.output],
      ["reasoning", t("info.reasoning"), message.usage.reasoning],
      ["cache_read", t("info.cache_read"), message.usage.cache_read],
      ["cache_write", t("info.cache_write"), message.usage.cache_write],
    ] as const;
    for (const [key, label, value] of usage) {
      if (value !== undefined) rows.push({ key, label, value: num(value) });
    }
  }
  if (metrics.output_tps !== undefined) {
    rows.push({
      key: "output_tps",
      label: t("message.details.output_tps"),
      value: t("message.details.output_tps.value", { n: num(Math.round(metrics.output_tps * 10) / 10) }),
    });
  }
  if (message.cost_usd !== undefined) {
    rows.push({ key: "cost_usd", label: t("info.cost"), value: fmtUsd(message.cost_usd) });
  }
  text("stop_reason", t("message.details.stop_reason"), message.stop_reason);
  text("ts", t("message.details.completed"), message.ts ? stamp(message.ts) : undefined);
  return rows;
}
