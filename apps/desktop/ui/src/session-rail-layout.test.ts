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
    for (const file of ["review.tsx", "session-changes-panel.tsx"]) {
      const src = read(file);
      expect(src, file).toContain("@container flex min-h-0 flex-1 flex-col");
      expect(src, file).toContain("flex min-h-0 flex-1 flex-col @min-[560px]:flex-row");
      expect(src, file).toContain("max-h-[40%]");
      expect(src, file).toContain("@min-[560px]:border-r");
      expect(src, file).toContain("@min-[560px]:w-[clamp(200px,30%,280px)]");
    }
  });

  test("one current panel has a launcher instead of a growing tab strip", () => {
    const rail = read("session-rail.tsx");
    expect(rail).toContain("<RailLauncher");
    expect(rail).toContain("setLauncherOpen(false)");
    expect(rail).toContain('role="region"');
    expect(rail).not.toContain('panelId="session-rail-panel"');

    const launcher = read("rail-launcher.tsx");
    expect(launcher).toContain("item.running");
    expect(launcher).toContain("item.count");
  });

  test("closing returns focus and trace does not leave a false pressed state", () => {
    const detail = read("session-detail.tsx");
    expect(detail).toContain("panelTriggerEl?.focus()");
    expect(detail).toContain("bindPanelTrigger={(el) => (panelTriggerEl = el)}");
    expect(read("session-header.tsx")).toContain("bindRef={props.bindPanelTrigger}");
    expect(detail).toContain("const panelVisible = () => panelOpen() && !traceBlock();");
  });

  test("an empty folder says so instead of leaving a blank list", () => {
    expect(read("files.tsx")).toContain('t("files.empty")');
    expect(read("locales/zh/session.ts")).toContain('"files.empty"');
    expect(read("locales/en/session.ts")).toContain('"files.empty"');
  });

  test("the rail plays its exit before it unmounts", () => {
    const rail = read("session-rail.tsx");
    // The mount outlives the close so the fade can land; the chrome state
    // flips at once, only the aside waits.
    expect(rail).toContain("const [present, setPresent] = createSignal(props.open())");
    expect(rail).toContain("<Show when={present()}>");
    expect(rail).toContain('leaving() ? "rail-out" : "rail-in"');
    // A reader who asked for less motion gets no hold — there is no exit.
    expect(rail).toContain("prefers-reduced-motion: reduce");
  });
});
