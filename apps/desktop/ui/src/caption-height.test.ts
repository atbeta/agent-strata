import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * The custom caption bar is 36px, and the session header, the pane header, the
 * changes panel and the trace drawer all sit in the same column beside it.
 *
 * They are one stack of aligned rows, so their heights are one number and not
 * five decisions. Dropping only the caption would leave the row under it eight
 * pixels taller and the app would read as a strip laid over a window rather
 * than as one surface. That is the whole reason `h-11` was written out five
 * times before: nobody wrote it down once.
 *
 * So the number lives here, and every row has to agree with it.
 */
describe("the top row is one height", () => {
  const ROWS: { file: string; label: string }[] = [
    { file: "chrome.tsx", label: "the window caption bar" },
    { file: "chrome.tsx", label: "the drag bar" },
    { file: "session-detail.tsx", label: "the session header" },
    { file: "session-rail.tsx", label: "the changes panel header" },
    { file: "trace.tsx", label: "the trace drawer header" },
  ];

  test("every header in the column is the same 36px", () => {
    const found: string[] = [];
    for (const { file, label } of ROWS) {
      const src = read(file);
      // A row in this column carries an explicit height; a header that sizes
      // itself with padding is something else in the file (the trace drawer's
      // own body rows do) and must not be swept up here.
      const lines = src
        .split("\n")
        .filter((l) => /\bh-\d+\b/.test(l) && /\bborder-b\b/.test(l));
      expect(lines.length, `${label} (${file})`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `${label} (${file}) must be h-9`).toMatch(/\bh-9\b/);
      }
      found.push(label);
    }
    expect(found).toHaveLength(5);
  });

  test("the panel's input is not a row in this column", () => {
    // It is a field, not a header: taller on purpose, and it must not be dragged
    // down with the rows — a 36px input loses the padding that makes it read as
    // one. It is the only one left; the search overlay that shared it went when
    // the two panels became one.
    expect(read("palette.tsx")).toMatch(/class="h-11 px-3"/);
  });

  test("the caption buttons fill the row rather than carrying a height of their own", () => {
    // They are `h-full` with a Windows-native width. Pinning a height here is
    // what makes the caption bar stop shrinking when the row does.
    const chrome = read("chrome.tsx");
    const caption = chrome.slice(chrome.indexOf("function CaptionButtons"));
    expect(caption).toContain("class=\"h-full");
    expect(caption).not.toMatch(/\bh-1[012]\b/);
  });
});
