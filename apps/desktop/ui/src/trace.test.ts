import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("assistant trace facts", () => {
  test("keeps the actual agent, reasoning variant, and finish reason", () => {
    const src = readFileSync(join(import.meta.dir, "trace.tsx"), "utf8");
    for (const field of ["agent", "variant", "stopReason"]) {
      expect(src).toContain(`${field}?: string`);
    }
    expect(src).toContain("prev.agent = agent ?? prev.agent");
    expect(src).toContain("prev.variant = variant ?? prev.variant");
    expect(src).toContain("prev.stopReason = stopReason ?? prev.stopReason");
    expect(src).toContain('t("trace.field.agent")');
    expect(src).toContain('t("trace.field.variant")');
    expect(src).toContain('t("trace.field.finish")');
  });

  test("a length finish has a visible transcript warning in both languages", () => {
    const transcript = readFileSync(join(import.meta.dir, "transcript.tsx"), "utf8");
    expect(transcript).toContain("isLengthStop(props.message.stop_reason)");
    expect(transcript).toContain('t("message.truncated")');
    for (const locale of ["zh/session.ts", "en/session.ts"]) {
      expect(readFileSync(join(import.meta.dir, "locales", locale), "utf8")).toContain('"message.truncated"');
    }
  });
});
