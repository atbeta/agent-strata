import { describe, expect, test } from "bun:test";
import { toOpencodeParts } from "../src/opencode-parts";

describe("parts as OpenCode takes them", () => {
  test("a workspace file needs a workspace", () => {
    expect(() => toOpencodeParts([{ type: "file_ref", path: "a.ts" }], undefined)).toThrow(/no workspace/);
  });

  test("a file picked without a mention claims no characters of the text", () => {
    expect(toOpencodeParts([{ type: "file_ref", path: "src/a.ts" }], "/repo/x")[0]).toMatchObject({
      type: "file",
      filename: "a.ts",
      source: { type: "file", path: "src/a.ts", text: { value: "@src/a.ts", start: 0, end: 0 } },
    });
  });

  test.if(process.platform === "win32")("a drive-less workspace resolves onto the current drive as a file URL", () => {
    const [part] = toOpencodeParts([{ type: "file_ref", path: "src/a.ts" }], "/repo/x");
    expect((part as { url: string }).url).toMatch(/^file:\/\/\/[A-Za-z]:\/repo\/x\/src\/a\.ts$/);
  });
});
