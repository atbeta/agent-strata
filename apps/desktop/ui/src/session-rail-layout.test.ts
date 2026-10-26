import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

describe("the session rail's responsive and keyboard behavior", () => {
  test("the available column clamps display without overwriting the preference", () => {
    const rail = read("session-rail.tsx");
    expect(rail).toContain("new ResizeObserver(measure)");
    expect(rail).toContain("observer.observe(container)");
    expect(rail).toContain('window.addEventListener("resize", measure)');
    expect(rail).toContain("clampRailWidth(preferredWidth(), availableWidth())");
    expect(rail).toContain("aria-valuemax={railWidthLimit(availableWidth())}");
    expect(rail).not.toContain("resizeRail(was + (from - ev.clientX), true)");
  });

  test("both diff layouts stack their file list in a narrow rail", () => {
    for (const file of ["review.tsx", "session-rail.tsx"]) {
      const src = read(file);
      expect(src, file).toContain("@container flex min-h-0 flex-1 flex-col @min-[560px]:flex-row");
      expect(src, file).toContain("max-h-[40%]");
      expect(src, file).toContain("@min-[560px]:border-r");
    }
  });

  test("the tabs have one tab stop, arrow navigation, and a named panel", () => {
    const tabs = read("components/ui/mini-tabs.tsx");
    expect(tabs).toContain("tabIndex={selectedIndex() === index() ? 0 : -1}");
    expect(tabs).toContain('e.key === "ArrowRight"');
    expect(tabs).toContain('e.key === "Home"');
    expect(tabs).toContain('e.key === "End"');

    const rail = read("session-rail.tsx");
    expect(rail).toContain('panelId="session-rail-panel"');
    expect(rail).toContain('role={props.opencode() ? "tabpanel" : undefined}');
    expect(rail).toContain("session-rail-panel-tab-${effectiveTab()}");
  });

  test("closing returns focus and trace does not leave a false pressed state", () => {
    const detail = read("session-detail.tsx");
    expect(detail).toContain("panelTriggerEl?.focus()");
    expect(detail).toContain("bindRef={(el) => (panelTriggerEl = el)}");
    expect(detail).toContain("const panelVisible = () => panelOpen() && !traceBlock();");
  });

  test("an empty folder says so instead of leaving a blank list", () => {
    expect(read("files.tsx")).toContain('t("files.empty")');
    expect(read("locales/zh/session.ts")).toContain('"files.empty"');
    expect(read("locales/en/session.ts")).toContain('"files.empty"');
  });
});
