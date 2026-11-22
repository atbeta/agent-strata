import { describe, expect, test } from "bun:test";
import { fmtDuration, fmtUsd } from "./api";
import {
  firstDivergentTurn,
  pairedDurationDelta,
  usageDeltaSentence,
} from "./compare-summary";
import { num, t } from "./i18n";

describe("usage comparison sentence", () => {
  test("joins every clause, with the last separator before the final one", () => {
    const cost = t("compare.delta.costMore", { amount: fmtUsd(0.12) });
    const tokens = t("compare.delta.tokensLess", { n: num(3000) });
    const time = t("compare.delta.timeSlower", { time: fmtDuration(40_000) });
    expect(usageDeltaSentence({ cost: 0.12, tokens: -3000, durationMs: 40_000 })).toBe(
      t("compare.delta.sentence", {
        detail: `${cost}${t("compare.delta.join")}${tokens}${t("compare.delta.last")}${time}`,
      }),
    );
  });

  test("a difference under a cent or a second is a wash", () => {
    expect(usageDeltaSentence({ cost: 1e-10, tokens: 0, durationMs: 500 })).toBe(
      t("compare.delta.even"),
    );
  });

  test("leaves time out when either side has no duration", () => {
    expect(usageDeltaSentence({ cost: 1, tokens: 0, durationMs: null })).toBe(
      t("compare.delta.sentence", {
        detail: t("compare.delta.costMore", { amount: fmtUsd(1) }),
      }),
    );
    expect(usageDeltaSentence({ cost: 0, tokens: 0, durationMs: null })).toBe(
      t("compare.delta.evenNoTime"),
    );
  });

  test("the first unmatched prompt is where alignment stops", () => {
    expect(firstDivergentTurn([{ same_prompt: true }, { same_prompt: false }, { same_prompt: false }])).toBe(1);
    expect(firstDivergentTurn([{ same_prompt: true }])).toBe(-1);
  });

  test("duration is the whole session or nothing", () => {
    expect(
      pairedDurationDelta([{ delta: { duration_ms: 1000 } }, { delta: { duration_ms: 2000 } }]),
    ).toBe(3000);
    expect(
      pairedDurationDelta([{ delta: { duration_ms: 1000 } }, { delta: { duration_ms: null } }]),
    ).toBeNull();
    expect(pairedDurationDelta([])).toBeNull();
  });
});
