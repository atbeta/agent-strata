import { describe, expect, test } from "bun:test";
import { readPromptParts, MAX_ATTACHMENT_BYTES } from "../src/prompt-parts";

const png = "data:image/png;base64,iVBORw0KGgo=";

describe("a prompt's parts", () => {
  test("text alone is shorthand for one text part", () => {
    expect(readPromptParts({ text: "hi" })).toEqual([{ type: "text", text: "hi" }]);
  });

  test("text, workspace files and attachments pass as sent", () => {
    const parts = [
      { type: "text", text: "@a.ts look" },
      { type: "file_ref", path: "src/a.ts", mention: { start: 0, end: 5 } },
      { type: "attachment", mime: "image/png", url: png, filename: "shot.png" },
    ];
    expect(readPromptParts({ parts })).toEqual(parts as never);
  });

  test("an attachment without words is a prompt", () => {
    expect(readPromptParts({ parts: [{ type: "attachment", mime: "application/pdf", url: "data:application/pdf;base64,JVBERi0=" }] })).toHaveLength(1);
  });

  test("nothing to send, or a part it cannot read, is refused with a reason", () => {
    const bad = (body: unknown) => {
      const r = readPromptParts(body as never);
      expect(Array.isArray(r)).toBe(false);
      return (r as { error: string }).error;
    };
    expect(bad({})).toMatch(/text or parts/);
    expect(bad({ parts: [] })).toMatch(/text or parts/);
    expect(bad({ parts: [{ type: "text", text: "  " }] })).toMatch(/text or parts/);
    expect(bad({ parts: [{ type: "video" }] })).toMatch(/part 0/);
    expect(bad({ parts: [{ type: "file_ref", path: "C:\\Windows\\win.ini" }] })).toMatch(/workspace/);
    expect(bad({ parts: [{ type: "file_ref", path: "/etc/passwd" }] })).toMatch(/workspace/);
    expect(bad({ parts: [{ type: "file_ref", path: "../outside.txt" }] })).toMatch(/workspace/);
    expect(bad({ parts: [{ type: "file_ref", path: "a.ts", mention: { start: 3, end: 1 } }] })).toMatch(/part 0/);
    expect(bad({ parts: [{ type: "attachment", mime: "text/html", url: "data:text/html;base64,PGI+" }] })).toMatch(/image or PDF/);
    expect(bad({ parts: [{ type: "attachment", mime: "image/png", url: "https://x/y.png" }] })).toMatch(/data URL/);
    expect(bad({ parts: [{ type: "attachment", mime: "image/png", url: "data:image/jpeg;base64,AA==" }] })).toMatch(/data URL/);
    const big = "data:image/png;base64," + "A".repeat(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 8);
    expect(bad({ parts: [{ type: "attachment", mime: "image/png", url: big }] })).toMatch(/5 MB/);
  });
});
