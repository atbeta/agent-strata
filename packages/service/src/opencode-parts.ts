import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { OpencodePromptPart } from "@agent-strata/adapter-opencode";
import type { PromptPart } from "./driver";

export type OpencodeFilePart = Extract<OpencodePromptPart, { type: "file" }>;

/** OpenCode reads a `file://` part itself, so a workspace file goes by its absolute URL. */
export function toOpencodeParts(parts: PromptPart[], directory: string | undefined): OpencodePromptPart[] {
  return parts.map((p): OpencodePromptPart => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "attachment")
      return { type: "file", mime: p.mime, url: p.url, ...(p.filename ? { filename: p.filename } : {}) };
    if (!directory) throw new Error("this session has no workspace to read files from");
    const abs = resolve(directory, p.path);
    const rel = relative(directory, abs);
    if (isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") throw new Error(`${p.path} is outside the workspace`);
    const value = `@${p.path}`;
    return {
      type: "file",
      mime: "text/plain",
      filename: basename(p.path),
      url: pathToFileURL(abs).href,
      source: {
        type: "file",
        path: p.path,
        // no mention in the text: a zero-width range keeps `source.path` without claiming any characters
        text: p.mention ? { value, start: p.mention.start, end: p.mention.end } : { value, start: 0, end: 0 },
      },
    };
  });
}
