import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * The left rail's own views.
 *
 * The rail used to open with two things that belonged to nothing: the
 * overview, which is the fleet page, and the project list, which is the
 * list. Everything the reader could ask the window — what is waiting on them,
 * what is still working, where to start something new — had to be found
 * somewhere else.
 *
 * These rows are answers, and they answer from the whole library: a filter
 * that happens to be on must not be able to make "is anything waiting for me"
 * read as zero.
 */
describe("the views at the top of the rail", () => {
  const sidebar = read("sidebar.tsx");
  const footer = read("use-connections.tsx");

  test("the rail opens with the window's own views", () => {
    expect(sidebar).toContain('t("sidebar.status.waiting")');
    expect(sidebar).toContain('t("sidebar.status.running")');
    expect(sidebar).toContain("props.onNewSession()");
  });

  test("the counts come from the whole library, not from the filter", () => {
    expect(sidebar).toContain("fleetStatus(list().sessions())");
  });

  test("a row with nothing behind it stays on screen", () => {
    // The count is printed, not tested for existence: a count that comes and
    // goes is not a place, a count that says zero is an answer.
    expect(sidebar).not.toContain("when={waitingCount() > 0}");
    expect(sidebar).not.toContain("when={runningCount() > 0}");
    expect(sidebar).toContain("props.count === 0 && !props.active");
  });

  test("the rows are the filter, and pressing one again lets it go", () => {
    expect(sidebar).toContain("toggleStatus");
    expect(sidebar).toContain('list().setStatus(lens.status === status ? "all" : status)');
  });

  test("a rule closes the block, so the views read apart from the list", () => {
    const nav = sidebar.slice(sidebar.indexOf("<nav"), sidebar.indexOf("</nav>"));
    expect(nav).toContain("border-b border-border");
  });

  test("the tools over the list stay in sight, not only while they are in use", () => {
    // They used to hide until the row was pointed at, and come back on their
    // own only while a filter was on. A control that vanishes until it is
    // hunted for is a control the reader has to find, so they are simply
    // there — quiet about it, as muted icons beside a muted label, rather
    // than loud, as a filled pair of buttons.
    expect(sidebar).not.toContain("group-hover/tools:opacity-100");
    expect(sidebar).not.toContain("const toolsVisible");
    expect(sidebar).toContain('class="flex items-center gap-0.5"');
  });

  test("the permission policy sits in the footer, beside the gear", () => {
    expect(footer).toContain('t("sidebar.permission.policy")');
    expect(footer).toContain('location.hash = "/settings/permission"');
    expect(footer).toContain('name="shield"');
  });
});
