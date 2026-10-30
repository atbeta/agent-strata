import { describe, expect, test } from "bun:test";
import type { Turn } from "./api";

const globals = globalThis as { document?: Document };
globals.document ??= { documentElement: {} } as Document;

const { locale, setLocale, stamp } = await import("./i18n");
const { assistantMessageDetails } = await import("./message-details");

type AssistantMessage = Turn["assistant"][number];
const message = (value: Partial<AssistantMessage>): AssistantMessage => ({ content: [], ...value });

function withLocale(lang: "zh" | "en", body: () => void): void {
  const previous = locale();
  setLocale(lang);
  try {
    body();
  } finally {
    setLocale(previous);
  }
}

describe("assistant message details", () => {
  test("has no rows when the backend reported no metadata", () => {
    expect(assistantMessageDetails()).toEqual([]);
    expect(assistantMessageDetails(message({ model: "", agent: " ", stop_reason: "" }))).toEqual([]);
    expect(assistantMessageDetails(message({ steps: [{ reason: "tool", usage: { input: 9, output: 4 }, cost_usd: 2 }] }))).toEqual([]);
  });

  test("keeps reported zero latency, token counts, and cost", () => {
    withLocale("en", () => {
      const rows = assistantMessageDetails(message({
        latency_ms: 0,
        usage: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        cost_usd: 0,
      }));
      expect(rows.map((row) => row.key)).toEqual([
        "latency_ms", "input", "output", "reasoning", "cache_read", "cache_write", "cost_usd",
      ]);
      expect(rows.map((row) => row.value)).toEqual(["0ms", "0", "0", "0", "0", "0", "$0.00"]);
    });
  });

  test("uses message-level usage without adding diagnostic steps again", () => {
    withLocale("en", () => {
      const rows = assistantMessageDetails(message({
        usage: { input: 12, output: 7 },
        cost_usd: 0.25,
        steps: [
          { reason: "first", usage: { input: 12, output: 2 }, cost_usd: 0.1 },
          { reason: "second", usage: { input: 0, output: 5 }, cost_usd: 0.15 },
        ],
      }));
      expect(rows).toEqual([
        { key: "input", label: "Input", value: "12" },
        { key: "output", label: "Output", value: "7" },
        { key: "cost_usd", label: "Cost", value: "$0.2500" },
      ]);
    });
  });

  test("shows TTFT and average output speed in both languages", () => {
    const start = Date.parse("2026-10-22T10:00:00.000Z");
    const value = message({
      content: [
        { type: "thinking", text: "reasoning", started_ms: start + 1500 },
        { type: "text", text: "answer", started_ms: start + 2500 },
      ],
      latency_ms: 5000,
      usage: { input: 10, output: 30, reasoning: 100 },
      ts: new Date(start + 5000).toISOString(),
    });
    withLocale("en", () => {
      expect(assistantMessageDetails(value)).toEqual([
        { key: "latency_ms", label: "Backend latency", value: "5.0s" },
        { key: "ttft_ms", label: "First output", value: "1.5s" },
        { key: "input", label: "Input", value: "10" },
        { key: "output", label: "Output", value: "30" },
        { key: "reasoning", label: "Reasoning", value: "100" },
        { key: "output_tps", label: "Average output", value: "8.6 output tok/s" },
        { key: "ts", label: "Completed", value: stamp(value.ts!) },
      ]);
    });
    withLocale("zh", () => {
      expect(assistantMessageDetails(value).map((row) => row.label)).toEqual([
        "后端耗时", "首段输出", "输入", "输出", "推理", "平均输出速度", "完成时间",
      ]);
    });
  });

  test("labels every field and calls ts the completion time", () => {
    const ts = "2026-10-30T12:34:56.000Z";
    const value = message({
      model: "model-x",
      agent: "build",
      variant: "high",
      latency_ms: 1500,
      usage: { input: 10, output: 5, reasoning: 2, cache_read: 1, cache_write: 3 },
      cost_usd: 0.5,
      stop_reason: "end_turn",
      ts,
    });
    withLocale("en", () => {
      expect(assistantMessageDetails(value)).toEqual([
        { key: "model", label: "Model", value: "model-x" },
        { key: "agent", label: "Agent", value: "build" },
        { key: "variant", label: "Variant", value: "high" },
        { key: "latency_ms", label: "Backend latency", value: "1.5s" },
        { key: "input", label: "Input", value: "10" },
        { key: "output", label: "Output", value: "5" },
        { key: "reasoning", label: "Reasoning", value: "2" },
        { key: "cache_read", label: "Cache read", value: "1" },
        { key: "cache_write", label: "Cache write", value: "3" },
        { key: "cost_usd", label: "Cost", value: "$0.5000" },
        { key: "stop_reason", label: "Stop reason", value: "end_turn" },
        { key: "ts", label: "Completed", value: stamp(ts) },
      ]);
    });
    withLocale("zh", () => {
      expect(assistantMessageDetails(value).map((row) => row.label)).toEqual([
        "模型", "智能体", "变体", "后端耗时", "输入", "输出", "推理", "缓存读取", "缓存写入", "花费", "结束原因", "完成时间",
      ]);
    });
  });
});
