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

  const dataUrl = (mime: string, text: string) => `data:${mime};base64,${btoa(text)}`;

  test("a textual attachment goes as text/plain so OpenCode inlines it instead of the provider rejecting the mime", () => {
    for (const mime of ["application/json", "text/markdown", "application/yaml", "image/svg+xml"]) {
      const [part] = toOpencodeParts(
        [{ type: "attachment", mime, url: dataUrl(mime, '{"a": 1}'), filename: "a.json" }],
        undefined,
      );
      expect(part).toMatchObject({ type: "file", mime: "text/plain", filename: "a.json" });
      expect((part as { url: string }).url).toBe(dataUrl("text/plain", '{"a": 1}'));
    }
  });

  test("an octet-stream attachment that decodes as text still goes as text/plain", () => {
    const url = dataUrl("application/octet-stream", "# readme\n");
    const [part] = toOpencodeParts([{ type: "attachment", mime: "application/octet-stream", url }], undefined);
    expect(part).toMatchObject({ type: "file", mime: "text/plain", url: dataUrl("text/plain", "# readme\n") });
  });

  test("binary attachments keep their declared mime", () => {
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]).toString("base64")}`;
    const [image] = toOpencodeParts([{ type: "attachment", mime: "image/png", url: png }], undefined);
    expect(image).toMatchObject({ type: "file", mime: "image/png", url: png });

    const bin = `data:application/octet-stream;base64,${Buffer.from([0x50, 0x4b, 0x00, 0x00]).toString("base64")}`;
    const [zip] = toOpencodeParts([{ type: "attachment", mime: "application/octet-stream", url: bin }], undefined);
    expect(zip).toMatchObject({ type: "file", mime: "application/octet-stream", url: bin });
  });
});
