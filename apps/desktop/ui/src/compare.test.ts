import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

describe("turn duration comparison", () => {
  test("renders the nullable duration through the delta formatter", () => {
    const src = readFileSync(join(import.meta.dir, "compare.tsx"), "utf8");
    expect(src).toContain("<Delta value={props.pair.delta.duration_ms} duration />");
    expect(src).toContain("fmtDurationDelta(props.value)");
    expect(src).toContain('if (props.value == null) return "—"');
  });
});
