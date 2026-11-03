import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(join(import.meta.dir, "pane-stage.tsx"), "utf8");
const divider = source.slice(source.indexOf("function SplitDivider"), source.indexOf("export function PaneStage"));

describe("keyboard split resizing", () => {
  test("exposes the real ratio and supports small and large steps", () => {
    expect(divider).toContain("aria-valuenow={Math.round(props.ratio * 100)}");
    expect(divider).toContain("event.shiftKey ? 0.1 : 0.02");
    expect(divider).toContain("props.onResize(RATIO_DEFAULT)");
  });

  test("restores focus to the replacement divider after a ratio update", () => {
    expect(divider).toContain('data-split-id={props.splitId}');
    expect(divider).toContain("requestAnimationFrame");
    expect(divider).toContain("CSS.escape(id)");
    expect(divider).toContain("focus({ preventScroll: true })");
  });
});
