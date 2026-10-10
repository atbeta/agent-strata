import { describe, expect, test } from "bun:test";
import { fontStack, parseFonts, sanitizeFamily } from "./font";

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
    expect(parseFonts("{").code).toBe("");
    expect(parseFonts(JSON.stringify({ size: "99", leading: "huge" })).size).toBe("");
  });

  test("keeps a complete choice", () => {
    expect(
      parseFonts(
        JSON.stringify({
          ui: "Segoe UI",
          code: "Sarasa Gothic SC",
          size: "14",
          leading: "relaxed",
          ligatures: false,
        }),
      ),
    ).toEqual({
      ui: "Segoe UI",
      code: "Sarasa Gothic SC",
      size: "14",
      leading: "relaxed",
      ligatures: false,
    });
  });
});
