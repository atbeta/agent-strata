import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visibleArchiveNote } from "./archived-note";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * Archived sessions are not part of the working set, but they still need a
 * place: a fixed band at the foot of the rail, quiet, and answering "how many
 * are set aside" even when the answer is zero.
 */
describe("archived sessions sit under the working list", () => {
  test("the entry comes after the project groups and before the footer", () => {
    const sidebar = read("sidebar.tsx");
    const projects = sidebar.indexOf("<For each={sectionKeys()}>");
    const archived = sidebar.indexOf("<ArchivedSection");
    const footer = sidebar.indexOf("<ConnectionsFooter");
    expect(projects).toBeGreaterThan(-1);
    expect(archived).toBeGreaterThan(projects);
    expect(archived).toBeLessThan(footer);
  });

  test("the archive is a band under the list, not another item in it", () => {
    const sidebar = read("sidebar.tsx");
    const scroll = sidebar.indexOf("overflow-y-auto");
    const archived = sidebar.indexOf("<ArchivedSection");
    expect(scroll).toBeGreaterThan(-1);
    expect(archived).toBeGreaterThan(scroll);
    // The scrolling area closes before the archive: the band is a fixed place
    // under the list, not the last thing the list happens to hold.
    expect(sidebar.slice(scroll, archived)).toContain("</div>");
  });

  test("the entry is a quiet line, not a section divider", () => {
    const src = read("archived-section.tsx");
    const head = src.slice(src.indexOf("return ("), src.indexOf("</RowButton>"));
    // The row itself carries no rule; the band above it does, so the fixed
    // place reads as separate from the list that scrolls above it.
    expect(head.slice(head.indexOf("<RowButton"))).not.toContain("border");
    expect(head).toContain("text-2xs");
    expect(head).toContain("border-t");
  });

  test("the band stays and reports zero when nothing is archived", () => {
    const src = read("archived-section.tsx");
    expect(src).not.toContain("rows().length > 0");
  });

  test("a delete note leaves with the row it named", () => {
    const note = { id: "a", text: "已删除。" };
    expect(visibleArchiveNote(note, ["a", "b"])).toBe("已删除。");
    expect(visibleArchiveNote(note, ["b"])).toBeUndefined();
    expect(visibleArchiveNote(undefined, ["a"])).toBeUndefined();
    expect(read("archived-section.tsx")).toContain("visibleArchiveNote(");
  });
});
