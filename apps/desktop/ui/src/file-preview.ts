import type { FileBody } from "./api";

export const IMAGE_BASE64_LIMIT = 16_000_000;

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export type FilePreview =
  | { kind: "image"; url: string }
  | { kind: "html" | "markdown" | "code" }
  | { kind: "binary"; oversized?: boolean };

export function filePreview(name: string, body: FileBody): FilePreview {
  if (body.type === "binary") {
    const mime = body.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
    if (body.encoding !== "base64" || !mime || !IMAGE_MIME.has(mime)) return { kind: "binary" };
    if (body.content.length > IMAGE_BASE64_LIMIT) return { kind: "binary", oversized: true };
    return { kind: "image", url: `data:${mime};base64,${body.content}` };
  }
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "html" || ext === "htm") return { kind: "html" };
  if (ext === "md" || ext === "mdx") return { kind: "markdown" };
  return { kind: "code" };
}
