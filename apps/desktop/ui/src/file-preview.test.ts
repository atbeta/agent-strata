import { describe, expect, test } from "bun:test";
import { filePreview, IMAGE_BASE64_LIMIT } from "./file-preview";
import type { FileBody } from "./api";

const text = (content = "body"): FileBody => ({ type: "text", content });
const binary = (patch: Partial<FileBody> = {}): FileBody => ({
  type: "binary",
  content: "aGVsbG8=",
  encoding: "base64",
  mimeType: "image/png",
  ...patch,
});

describe("file previews", () => {
  test("common images become a controlled data URL", () => {
    expect(filePreview("photo.PNG", binary({ mimeType: " Image/PNG; charset=binary" }))).toEqual({
      kind: "image",
      url: "data:image/png;base64,aGVsbG8=",
    });
    for (const mimeType of ["image/jpeg", "image/gif", "image/webp", "image/avif"]) {
      expect(filePreview("image", binary({ mimeType })).kind).toBe("image");
    }
  });

  test("HTML and Markdown text can be rendered or read as source", () => {
    expect(filePreview("index.html", text()).kind).toBe("html");
    expect(filePreview("INDEX.HTM", text()).kind).toBe("html");
    expect(filePreview("README.md", text()).kind).toBe("markdown");
    expect(filePreview("component.mdx", text()).kind).toBe("markdown");
    expect(filePreview("main.ts", text()).kind).toBe("code");
  });

  test("unknown, unencoded, SVG and oversized binaries stay out of the image renderer", () => {
    expect(filePreview("x.bin", binary({ mimeType: "application/octet-stream" })).kind).toBe("binary");
    expect(filePreview("x.png", binary({ encoding: undefined })).kind).toBe("binary");
    expect(filePreview("x.svg", binary({ mimeType: "image/svg+xml" })).kind).toBe("binary");
    expect(filePreview("x.svg", text("<svg/>")).kind).toBe("code");
    expect(filePreview("x.png", binary({ content: "x".repeat(IMAGE_BASE64_LIMIT + 1) }))).toEqual({
      kind: "binary",
      oversized: true,
    });
  });
});
