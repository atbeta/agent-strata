import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * Archived sessions are not part of the working set. A block above the pinned
 * lane is the first thing the rail says, which is the opposite of a pile you
 * set aside. The entry stays, under the projects, and it stays quiet.
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

  test("the entry is a quiet line, not a section divider", () => {
    const src = read("archived-section.tsx");
    const head = src.slice(src.indexOf("return ("), src.indexOf("</RowButton>"));
    expect(head).not.toContain("border-b");
    expect(head).toContain("text-2xs");
  });
});
