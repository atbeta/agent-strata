import { describe, expect, test } from "bun:test";
import { previewWindow } from "./search-format";

describe("transcript hit previews", () => {
  test("the window opens on the match, not on the first characters", () => {
    // The shape that made this useless: the word sits far past the prefix the
    // preview used to cut, so every result read like an unrelated message.
    const text = `${"head ".repeat(60)}a Mutex::lock().unwrap() here ${"tail ".repeat(60)}`;
    const w = previewWindow(text, "mutex");
    expect(w.match).toBe("Mutex");
    expect(`${w.lead}${w.match}${w.rest}`).toContain("Mutex::lock().unwrap()");
    expect(w.lead.startsWith("…")).toBe(true);
    expect(w.rest.length).toBeGreaterThan(0);
    expect(w.lead.length + w.match.length + w.rest.length).toBeLessThanOrEqual(200);
  });

  test("a match at the top still reads from the top", () => {
    const w = previewWindow("Mutex::lock().unwrap() and then some more text", "mutex");
    expect(w.lead).toBe("");
    expect(w.match).toBe("Mutex");
    expect(w.rest.startsWith("::lock")).toBe(true);
  });

  test("text the query never reached falls back to the opening", () => {
    const w = previewWindow("nothing to see here ".repeat(40), "mutex");
    expect(w.match).toBe("");
    expect(w.lead.length).toBe(160);
    expect(w.rest).toBe("");
  });

  test("an empty query marks nothing rather than matching at zero", () => {
    const w = previewWindow("anything at all", "");
    expect(w.match).toBe("");
    expect(w.lead).toBe("anything at all");
  });
});
