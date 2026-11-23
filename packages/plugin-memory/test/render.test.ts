import { describe, expect, test } from "bun:test";
import { MEMORY_PROTOCOL, renderPrompt } from "../src/render";
import type { MemoryEntry } from "../src/types";

function entry(id: string, text: string, enabled = true): MemoryEntry {
  return {
    id,
    text,
    enabled,
    source: "agent",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("memory prompt", () => {
  test("nothing is injected when nothing has been remembered", () => {
    const rendered = renderPrompt({});
    expect(rendered.empty).toBe(true);
    expect(rendered.text).toBe("");
    expect(rendered.shown).toBe(0);
  });

  test("an entry is shown with its id, so the model can change it later", () => {
    const rendered = renderPrompt({ global: [entry("m_abc", "User prefers Traditional Chinese.")] });
    expect(rendered.text).toContain("- [m_abc] User prefers Traditional Chinese.");
    expect(rendered.shown).toBe(1);
  });

  test("a disabled entry is kept in the file but not in the prompt", () => {
    const rendered = renderPrompt({ global: [entry("m_off", "wrong for now", false)] });
    expect(rendered.empty).toBe(true);
    expect(rendered.text).not.toContain("wrong for now");
  });

  test("what does not fit the budget is left out and said out loud", () => {
    const entries = [
      entry("m_1", "a".repeat(200)),
      entry("m_2", "b".repeat(200)),
      entry("m_3", "c".repeat(200)),
    ];
    const rendered = renderPrompt({ global: entries, budget: MEMORY_PROTOCOL.length + 400 });
    expect(rendered.shown).toBe(1);
    expect(rendered.omitted).toBe(2);
    expect(rendered.text).toContain("2 memories not shown");
    expect(rendered.text).toContain("memory_list");
  });

  test("the budget is a ceiling, not a target", () => {
    // The protocol, the entries and the note about what did not fit are all
    // paid for out of the same budget, so the text never exceeds it.
    const entries = Array.from({ length: 200 }, (_, i) => entry(`m_${i}`, `note ${i} ${"x".repeat(120)}`));
    for (const budget of [1_000, 1_500, 3_000, 6_000, 12_000]) {
      const rendered = renderPrompt({ global: entries, budget });
      expect(rendered.text.length).toBeLessThanOrEqual(budget);
    }
  });

  test("a budget too small for the protocol buys silence, not a broken prompt", () => {
    const rendered = renderPrompt({
      global: [entry("m_1", "prefers concise answers")],
      budget: MEMORY_PROTOCOL.length,
    });
    expect(rendered.empty).toBe(true);
    expect(rendered.text).toBe("");
  });

  test("the note about omitted entries is paid for out of the budget", () => {
    // Leaving entries out costs a sentence, so the sentence has to come out
    // of the same budget — otherwise the ceiling is a lie.
    const entries = Array.from({ length: 40 }, (_, i) => entry(`m_${i}`, `note ${i} ${"y".repeat(200)}`));
    const rendered = renderPrompt({ global: entries, budget: 2_000 });
    expect(rendered.omitted).toBeGreaterThan(0);
    expect(rendered.text).toContain("memories not shown");
    expect(rendered.text.length).toBeLessThanOrEqual(2_000);
  });

  test("the same memories produce the same text, so the prompt cache holds", () => {
    const global = [entry("m_1", "one"), entry("m_2", "two")];
    expect(renderPrompt({ global }).text).toBe(renderPrompt({ global }).text);
    // A different set is a different prompt — that is the point.
    expect(renderPrompt({ global }).text).not.toBe(renderPrompt({ global: [entry("m_1", "one")] }).text);
  });

  test("the protocol half never changes when the entries do", () => {
    const one = renderPrompt({ global: [entry("m_1", "one")] }).text;
    const two = renderPrompt({ global: [entry("m_1", "one"), entry("m_2", "two")] }).text;
    expect(one.startsWith(MEMORY_PROTOCOL)).toBe(true);
    expect(two.startsWith(MEMORY_PROTOCOL)).toBe(true);
    expect(one.slice(0, MEMORY_PROTOCOL.length)).toBe(two.slice(0, MEMORY_PROTOCOL.length));
  });

  test("a crowded global scope does not squeeze the workspace out", () => {
    // Sixty long global notes and three workspace ones: the workspace notes
    // are about the work in front of the agent and must survive.
    const global = Array.from({ length: 60 }, (_, i) =>
      entry(`m_g${i}`, `global note number ${i} about preferences and habits, spelled out at some length`),
    );
    const workspace = [
      entry("m_w1", "This repo deploys with make deploy."),
      entry("m_w2", "The staging database is on port 5433."),
      entry("m_w3", "Tests run with bun test packages."),
    ];
    const rendered = renderPrompt({ workspace, global, budget: 6000 });
    for (const note of workspace) expect(rendered.text).toContain(note.text);
    expect(rendered.omitted).toBeGreaterThan(0);
  });

  test("a crowded workspace does not squeeze the reader's preferences out", () => {
    const workspace = Array.from({ length: 60 }, (_, i) =>
      entry(`m_w${i}`, `workspace note number ${i} about this project, spelled out at some length`),
    );
    const global = [entry("m_g1", "User prefers replies in Traditional Chinese.")];
    const rendered = renderPrompt({ workspace, global, budget: 6000 });
    expect(rendered.text).toContain("User prefers replies in Traditional Chinese.");
  });

  test("the newest memory is the one that survives a tight budget", () => {
    // The plugin hands the entries over newest first; the budget keeps the
    // front of the list, so the most recent memory is the one shown.
    const global = [entry("m_new", "newest"), entry("m_old", "x".repeat(200))];
    const rendered = renderPrompt({ global, budget: MEMORY_PROTOCOL.length + 120 });
    expect(rendered.text).toContain("newest");
    expect(rendered.text).not.toContain("xxx");
    expect(rendered.omitted).toBe(1);
  });
});
