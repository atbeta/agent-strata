import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES as UI_MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS as UI_MAX_ATTACHMENTS,
  promptParts,
  type Attachment,
} from "./composer-input";
import {
  ATTACHMENT_MIMES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  readPromptParts,
} from "../../../../packages/service/src/prompt-parts";

const shot = (i: number): Attachment => ({ id: String(i), name: `s${i}.png`, mime: "image/png", url: "data:image/png;base64,AA==" });

describe("what the composer sends, the service takes", () => {
  const drafts: [string, string, string[]][] = [
    ["a draft over several lines", "first line\n@a.ts\nthird @b.ts", ["a.ts", "b.ts"]],
    ["a file mentioned twice", "@a.ts then @a.ts again", ["a.ts"]],
    ["a path with a space", "look at @my notes.md please", ["my notes.md"]],
    ["a mention before a comma", "look at @a.ts, ok", ["a.ts"]],
    ["a mention before a full stop", "check @a.ts.", ["a.ts"]],
    ["a mention in brackets", "(@a.ts)", ["a.ts"]],
    ["a mention before CJK", "@a.ts的内容", ["a.ts"]],
    ["a mention after CJK", "请看@a.ts", ["a.ts"]],
  ];
  for (const [name, draft, picked] of drafts) {
    test(name, () => {
      const parts = promptParts(draft, picked, []);
      expect(parts.some((p) => p.type === "file_ref")).toBe(true);
      expect(readPromptParts({ parts })).toEqual(parts);
    });
  }

  test("as many attachments as allowed", () => {
    const parts = promptParts("look", [], Array.from({ length: UI_MAX_ATTACHMENTS }, (_, i) => shot(i)));
    expect(readPromptParts({ parts })).toEqual(parts);
  });

  test("the same attachment limits", () => {
    expect(new Set(ATTACHMENT_ACCEPT.split(","))).toEqual(new Set(ATTACHMENT_MIMES));
    expect(UI_MAX_ATTACHMENT_BYTES).toBe(MAX_ATTACHMENT_BYTES);
    expect(UI_MAX_ATTACHMENTS).toBe(MAX_ATTACHMENTS);
  });
});
