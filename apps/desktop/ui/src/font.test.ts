import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fontIsAvailable, fontStack, parseFonts, sanitizeFamily } from "./font";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

describe("detecting a font the machine actually has", () => {
  // The browser substitutes a family it cannot resolve, so a missing font is
  // one that renders exactly like the fallback it was asked to sit next to.
  // `sizes` holds the widths of the families that exist, keyed by name.
  const measureFor = (sizes: Record<string, number>) => (stack: string) => {
    const asked = /^"([^"]+)",\s*(.+)$/.exec(stack);
    if (!asked) return sizes[stack]!;
    const [, family, base] = asked;
    return sizes[family] ?? sizes[base]!;
  };

  test("a family the browser resolves lands on its own width", () => {
    const measure = measureFor({ Consolas: 812, monospace: 800, serif: 640, "sans-serif": 700 });
    expect(fontIsAvailable(measure, "Consolas")).toBe(true);
  });

  test("a family it has to substitute measures as the fallback does", () => {
    const measure = measureFor({ monospace: 800, serif: 640, "sans-serif": 700 });
    expect(fontIsAvailable(measure, "Satoshi")).toBe(false);
  });

  test("agreeing with one baseline still counts as installed", () => {
    // A family that measures like `monospace` but not like `serif` is real;
    // deciding from a single comparison would call it missing.
    const measure = measureFor({ LXGW: 700, monospace: 700, serif: 640, "sans-serif": 700 });
    expect(fontIsAvailable(measure, "LXGW")).toBe(true);
  });

  test("only a family indistinguishable from every fallback reads as missing", () => {
    const measure = measureFor({ Ghost: 800, monospace: 800, serif: 800, "sans-serif": 800 });
    expect(fontIsAvailable(measure, "Ghost")).toBe(false);
  });

  test("an unusable name is never available", () => {
    expect(fontIsAvailable(() => 100, "")).toBe(false);
    expect(fontIsAvailable(() => 100, '";{}')).toBe(false);
  });
});

describe("a font family name", () => {
  test("keeps a normal family and a CJK name", () => {
    expect(sanitizeFamily("JetBrains Mono")).toBe("JetBrains Mono");
    expect(sanitizeFamily("更纱黑体")).toBe("更纱黑体");
  });

  test("drops characters that would break the CSS declaration", () => {
    expect(sanitizeFamily('Cascadia"; color: red')).toBe("");
    expect(sanitizeFamily("")).toBe("");
  });

  test("puts a chosen family ahead of the fallback stack", () => {
    expect(fontStack("Consolas", "monospace")).toBe('"Consolas", monospace');
    expect(fontStack('";{}', "monospace")).toBe("monospace");
  });
});

describe("a stored font choice", () => {
  test("falls back when the value is missing or nonsense", () => {
    expect(parseFonts(null).ligatures).toBe(true);
    expect(parseFonts(null).terminal).toBe("");
    expect(parseFonts(JSON.stringify({ code: "Consolas" })).terminal).toBe("");
    expect(parseFonts("{").code).toBe("");
    expect(parseFonts(JSON.stringify({ size: "99", leading: "huge" })).size).toBe("");
  });

  test("keeps a complete choice", () => {
    expect(
      parseFonts(
        JSON.stringify({
          ui: "Segoe UI",
          code: "Sarasa Gothic SC",
          terminal: "Consolas",
          size: "14",
          leading: "relaxed",
          ligatures: false,
        }),
      ),
    ).toEqual({
      ui: "Segoe UI",
      code: "Sarasa Gothic SC",
      terminal: "Consolas",
      size: "14",
      leading: "relaxed",
      ligatures: false,
    });
  });
});

describe("ligatures off", () => {
  test("reaches markdown code, not only the font-mono class", () => {
    // Chat code takes its face from `@apply font-mono`, so the element never
    // carries the class. A rule aimed only at `.font-mono` leaves `>=` joined
    // in the transcript after the switch is off.
    const theme = read("theme.css");
    const at = theme.indexOf('html[data-code-ligatures="off"]');
    expect(at).toBeGreaterThan(-1);
    const rule = theme.slice(at, theme.indexOf("}", at) + 1);
    expect(rule).toContain(".font-mono");
    expect(rule).toContain(".md code");
    expect(rule).toContain("font-variant-ligatures: none");
    // Coding faces keep `>=` in `calt`. Clearing only the variant property
    // leaves that feature on in Chromium.
    expect(rule).toContain('"liga" 0');
    expect(rule).toContain('"calt" 0');
  });

  test("the settings sample contains a ligature that can be seen", () => {
    const settings = read("settings.tsx");
    const at = settings.indexOf("const PREVIEW_CODE");
    const sample = settings.slice(at, settings.indexOf("`;", at));
    expect(sample).toContain(">=");
  });
});
