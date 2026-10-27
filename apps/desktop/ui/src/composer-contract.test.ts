import { describe, expect, test } from "bun:test";
import {
  MAX_ATTACHMENT_BYTES as UI_MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS as UI_MAX_ATTACHMENTS,
  commandParts,
  promptParts,
  type Attachment,
} from "./composer-input";
import {
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

  test("a command's files", () => {
    const parts = commandParts("/review @a.ts, then @b.ts", ["a.ts", "b.ts"], [shot(0)]);
    expect(parts.some((p) => p.type === "file_ref")).toBe(true);
    expect(readPromptParts({ parts })).toEqual(parts);
  });

  test("as many attachments as allowed", () => {
    const parts = promptParts("look", [], Array.from({ length: UI_MAX_ATTACHMENTS }, (_, i) => shot(i)));
    expect(readPromptParts({ parts })).toEqual(parts);
  });

  test("the same attachment limits", () => {
    expect(UI_MAX_ATTACHMENT_BYTES).toBe(MAX_ATTACHMENT_BYTES);
    expect(UI_MAX_ATTACHMENTS).toBe(MAX_ATTACHMENTS);
  });

  test("a file that is not an image still reaches the service", () => {
    // The composer used to allow four image types and PDF, which was our guess
    // at what a model can read. The service held the same list, so the guess was
    // enforced twice and a `.ts` never left the app. Both sides take it now.
    const typed = (i: number, name: string, mime: string): Attachment => ({
      id: String(i),
      name,
      mime,
      url: `data:${mime};base64,AA==`,
    });
    const parts = promptParts("look", [], [
      typed(0, "a.ts", "application/typescript"),
      typed(1, "notes.md", "text/markdown"),
      typed(2, "blob.bin", "application/octet-stream"),
    ]);
    expect(readPromptParts({ parts })).toEqual(parts);
  });
});
