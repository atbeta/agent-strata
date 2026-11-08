import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * A plain class string that holds all of these tokens.
 *
 * Order- and spacing-tolerant on purpose: the thing worth failing on is a
 * surface hand-built out of the same three classes, not the order someone
 * happens to write them in.
 */
function combined(source: string, tokens: string[]): string | undefined {
  for (const match of source.matchAll(/class="([^"]*)"/g)) {
    const set = new Set((match[1] ?? "").split(/\s+/).filter(Boolean));
    if (tokens.every((token) => set.has(token))) return match[0];
  }
  return undefined;
}

describe("quiet visual consistency", () => {
  test("the app owns the 14px UI baseline", () => {
    const theme = read("theme.css");
    const body = theme.slice(theme.indexOf("body {"), theme.indexOf("}", theme.indexOf("body {")));
    expect(body).toContain("text-sm");
  });

  test("floating surfaces use one edge treatment", () => {
    const files = [
      "components/ui/dropdown-menu.tsx",
      "components/ui/popover.tsx",
      "components/ui/context-menu.tsx",
      "session-search.tsx",
      "session-tools.tsx",
      "prompt-navigator.tsx",
      "tip.tsx",
      "composer-menu.tsx",
      "transcript-view.tsx",
      "sidebar.tsx",
    ];
    for (const file of files) {
      const src = read(file);
      expect(src, file).toContain("surface-popover");
      // Token sets rather than exact strings: a hand-written surface is the
      // regression, and it does not become acceptable by reordering classes.
      expect(combined(src, ["bg-popover", "shadow-lg"]), file).toBeUndefined();
      expect(combined(src, ["rounded-lg", "border", "bg-popover"]), file).toBeUndefined();
    }
    expect(combined(read("components/ui/dropdown-menu.tsx"), ["rounded-md", "border", "bg-popover"])).toBeUndefined();
  });

  test("message actions float as separate chips, with the lightest shadow", () => {
    // A tray holding the actions made a copy button and a stats button read as
    // one control, and a tray over body text is heavier than either button.
    const src = read("message-actions.tsx");
    expect(src).not.toContain("surface-popover");
    const chip = /const btn = "([^"]*)"/.exec(src)?.[1] ?? "";
    expect(chip).toContain("shadow-sm");
    expect(chip).toContain("bg-card/95");
  });

  test("menu triggers share button variants and composer focus preserves elevation", () => {
    for (const file of ["components/ui/dropdown-menu.tsx", "components/ui/popover.tsx"]) {
      const src = read(file);
      expect(src, file).toContain("buttonVariants");
      expect(src, file).toContain('variant?: ButtonProps["variant"]');
      expect(src, file).toContain('size?: ButtonProps["size"]');
    }
    // Focus on the composer is a hairline, not a frame: the reader is already
    // there, and a ring reads as an alarm. The intent is what is asserted —
    // any value that paints a two-pixel edge fails.
    const theme = read("theme.css");
    const rule = /\.surface-composer:focus-within\s*\{([^}]*)\}/.exec(theme)?.[1] ?? "";
    expect(rule).toContain("box-shadow");
    expect(rule).not.toContain("0 0 0 2px");
  });

  test("backend fields keep the primitive's font size and padding", () => {
    const src = read("backend-settings.tsx");
    const inputs = src.match(/<TextFieldInput[\s\S]*?\/>/g) ?? [];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input).toContain('size="sm"');
      expect(input).not.toContain("text-2xs");
      expect(input).not.toContain("px-2");
    }
  });

  test("connection rows and keyboard actions survive a narrow or focused rail", () => {
    const backends = read("backend-settings.tsx");
    expect(backends).toContain("flex flex-col gap-2.5");
    expect(backends).toContain("@min-[560px]/main:flex-row");
    expect(backends).toContain("flex-wrap");

    const row = read("sidebar-row.tsx");
    expect(row).toContain("group-focus-within:visible");
    expect(row).toContain("group-focus-within:invisible");
    expect(row).toContain("tabIndex={props.actions ? 0 : -1}");
  });

  test("content preferences cover prose and mono, and the footer keeps addresses on demand", () => {
    const settings = read("settings.tsx");
    expect(settings).toContain('hint={t("settings.font.size.hint")}');
    expect(settings).not.toContain('{ id: "", label: t("settings.font.system") },\n                ...CONTENT_SIZES');
    expect(read("theme.css")).toContain("html[data-content-size] :is(.md, .md code, .font-mono)");

    const footer = read("use-connections.tsx");
    expect(footer).toContain('<Tip label={endpointHost(conn.baseUrl)}');
    expect(footer).not.toContain("endpointShort(conn.baseUrl)");
    expect(footer).not.toContain("endpointHost(conn.baseUrl)}</span>");
  });
});
