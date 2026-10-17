import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * Mermaid is the largest thing this UI can pull in, and the transcript is a
 * windowed list that renders markdown a token at a time. Both facts are easy to
 * break in ways no screenshot would catch: a diagram drawn out of a half-written
 * fence, or redrawn every time a row scrolls back into view. These hold the
 * places where that is decided.
 */
describe("mermaid rendering ratchet", () => {
  test("only a finished region is asked to draw", () => {
    // `stableBoundary` already separates what has closed from what is still
    // arriving. Handing the tail to the diagram engine means parsing a source
    // that is still being written, and drawing it again on the next frame.
    const src = read("md.tsx");
    expect(src).toContain("if (finished) drawDiagrams(tpl.content)");
    expect(src).toMatch(/nodesFrom\(tail, false\)/);
  });

  test("the engine is loaded on first use, never at import", () => {
    // Around 0.6MB of shared core, gzipped, plus a chunk per diagram type. A
    // session with no diagram in it must never pay for one.
    const src = read("mermaid.ts");
    expect(src).toContain('import("mermaid")');
    // And the module must not be imported statically anywhere near the top.
    const head = src.slice(0, src.indexOf("type MermaidApi"));
    expect(head).not.toMatch(/^import .*mermaid"$/m);
  });

  test("one engine serves every diagram", () => {
    // Two diagrams on screen would otherwise each start an import.
    const src = read("mermaid.ts");
    expect(src).toContain("loading ??= import(\"mermaid\")");
  });

  test("a failed load is not cached", () => {
    // Caching a rejection makes the failure permanent for the life of the
    // window: no later diagram can ever get another chance.
    const src = read("mermaid.ts");
    expect(src).toMatch(/loading = null/);
  });

  test("a drawn diagram is not drawn again", () => {
    // The transcript unmounts rows that scroll away and rebuilds them on the
    // way back. Keying on the source is what makes the cost once per message
    // rather than once per scroll.
    const src = read("mermaid.ts");
    expect(src).toContain("block.dataset.diagram === source");
  });

  test("mermaid never writes into the page itself", () => {
    // Left on, mermaid's failure path appends an illustrated error block to
    // `document.body` — outside the transcript, so the reader gets a stray
    // graphic with nothing connecting it to the block that failed.
    const src = read("mermaid.ts");
    expect(src).toContain("suppressErrorRendering: true");
    expect(src).toContain("sweepErrorArtifacts()");
  });

  test("a diagram cannot inject html into a transcript", () => {
    const src = read("mermaid.ts");
    expect(src).toContain('securityLevel: "strict"');
  });

  test("a failure keeps the source and says why", () => {
    // Dropping the source loses content the reader can still read and copy.
    const src = read("mermaid.ts");
    expect(src).not.toContain("block.hidden = true;\n    return { ok: false");
    const md = read("md.tsx");
    expect(md).toContain("noteDiagramFailure(block, r.reason)");
  });
});
