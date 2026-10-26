import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

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
      "session-search.tsx",
      "session-tools.tsx",
      "prompt-navigator.tsx",
    ];
    for (const file of files) {
      const src = read(file);
      expect(src, file).toContain("surface-popover");
      expect(src, file).not.toContain("bg-popover shadow-lg");
      expect(src, file).not.toContain("rounded-lg border border-border bg-popover");
    }
    expect(read("components/ui/dropdown-menu.tsx")).not.toContain(
      "rounded-md border border-border bg-popover",
    );
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
