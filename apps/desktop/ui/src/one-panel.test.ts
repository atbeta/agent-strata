import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * There were two overlays and one shortcut between them.
 *
 * `Ctrl K` searched sessions and the transcript inside them. `Ctrl Shift P`
 * listed commands and also found sessions, by title. Both were a centred dialog
 * with an input and a list, so the two could not be told apart by what they
 * looked like either — which means a reader who wanted a command had to know
 * there was a second panel, and a reader who wanted a line of text out of a
 * conversation had to know which of the two opened.
 *
 * One panel now. Both chords open it, and it answers to all three kinds.
 */
describe("one panel, and every way in leads to it", () => {
  const app = read("App.tsx");
  const sidebar = read("sidebar.tsx");
  const chrome = read("chrome.tsx");

  test("Ctrl K opens the panel that lists commands", () => {
    // It used to open a search with no commands in it at all, which is the half
    // of "look things up" that is not looking anything up.
    const cmd = app.slice(app.indexOf('id: "app.search"'));
    expect(cmd.slice(0, 900)).toContain('chord: { key: "k" }');
    expect(cmd.slice(0, 900)).toContain("setPaletteOpen((open) => !open)");
  });

  test("Ctrl Shift P opens the same panel", () => {
    const cmd = app.slice(app.indexOf('id: "app.palette"'));
    expect(cmd.slice(0, 900)).toContain('chord: { key: "p", shift: true }');
    expect(cmd.slice(0, 900)).toContain("setPaletteOpen((open) => !open)");
  });

  test("the window's own corner opens it too", () => {
    // The row that used to carry the shortcut moved up to the top-left corner
    // of the window, where the tooltip still spells out the keys. Two ways to
    // open the same panel is one too many, so the row is gone.
    expect(chrome).toContain("onOpenPalette");
    expect(app).toContain("onOpenPalette={openPalette}");
    expect(sidebar).not.toContain("onOpenSearch");
  });

  test("the old search overlay is gone from the sidebar", () => {
    // It is not merely unused — it is a second way to open a panel that answers
    // less, sitting next to the first.
    expect(sidebar).not.toContain("CommandSearch");
    expect(app).not.toContain("search={{");
  });

  test("the panel is given the events it searches", () => {
    // Transcript search is the one thing only this panel had, and losing it
    // would have made the merge a downgrade rather than a merge.
    expect(app).toContain("events={settled(results)}");
    expect(app).toContain("searching={results.loading}");
  });

  test("what you type reaches the full-text search", () => {
    // Transcript search is not a filter over what the panel already holds: it
    // is `/events?text=…` against the whole store. The query lived inside the
    // panel while the resource that ran that request lived in App, so nothing
    // ever set it — the request was never made and the panel went on searching
    // titles, which is a downgrade wearing a merge's clothes.
    expect(app).toContain('query={query()}');
    expect(app).toContain("onQuery={setQuery}");
    // One owner. A second copy of the query is how they drift apart again.
    expect(app).toContain("/events?text=");
    const palette = read("palette.tsx");
    expect(palette).not.toContain('createSignal("")');
    expect(palette).toContain("props.onQuery(e.currentTarget.value)");
  });
});
