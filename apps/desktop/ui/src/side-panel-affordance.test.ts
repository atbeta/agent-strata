import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * The changes-and-files panel opened from a 24px strip on the right edge.
 *
 * That strip was permanently on screen and said one thing: something optional
 * existed on the other side of it. It held the visual weight of the 288px panel
 * it stood for, to advertise 288px — and a reader watching the edge saw a hard
 * edge become a panel rather than a panel arrive, because it was a `<Show>`
 * between two different elements and nothing about it could be transitioned.
 *
 * It is a button in the header row now, where the reader's eye already is, and
 * the reading column got the 24 pixels back. Export came out of the overflow
 * menu to make room; that menu held one item and is gone.
 */
describe("the side panel is opened from the header, not from a strip on the edge", () => {
  const detail = read("session-detail.tsx");
  const rail = read("session-rail.tsx");

  test("there is no collapsed strip left to find", () => {
    // The rail renders only when open. Nothing stands in for it when it does not.
    const open = rail.slice(rail.indexOf("return ("));
    expect(open).not.toContain("w-6 shrink-0");
    expect(open).not.toContain('class="h-full w-6');
    expect(open).not.toContain("flex-col justify-start");
    // And the rail no longer takes an opener, because it has no collapsed form.
    expect(rail).not.toContain("onOpen: () => void;");
    expect(rail).not.toContain("props.onOpen");
  });

  test("the header row carries the switch, last, next to the other session controls", () => {
    // In the row, so it reads as one of the session's own controls and sits
    // where the reader's eye already is.
    expect(detail).toContain("onClick={togglePanel}");
    const at = detail.indexOf("onClick={togglePanel}");
    expect(at).toBeGreaterThan(-1);
    // Lit state and aria follow `panelOpen`, so it is a toggle and not a button
    // that opens something.
    expect(detail.slice(at - 400, at)).toContain("pressed={panelOpen()}");
    expect(detail).toContain('on={panelOpen()}');
    // The mark says which side of the window this is: the fold button on the
    // other side draws the same way.
    expect(detail).toContain('<Icon name="panel-right" />');
  });

  test("export left the overflow menu, and the menu with it", () => {
    // The menu's comment said so outright: one item today, toggles live in the
    // row where their lit state reads. Export has no state to show, but it also
    // has no reason to be two clicks away when the row has room for it.
    const header = detail.slice(detail.indexOf("<header"), detail.indexOf("</header>"));
    expect(header).toContain("downloadExport(");
    expect(header).toContain('aria-label={t("header.export")}');
    // No menu left behind holding nothing.
    expect(header).not.toContain("header.more");
    expect(header).not.toContain("<DropdownMenu");
  });

  test("the panel still opens from the command palette and the keyboard", () => {
    // The strip was never the only way, and moving the button must not have
    // cost the other two.
    expect(detail).toContain('id: "session.panel"');
    expect(detail).toContain("run: () => togglePanel()");
  });

  test("the close button inside the open panel is still there", () => {
    expect(rail).toContain('aria-label={t("panel.hide")}');
    expect(rail).toContain("onClick={props.onClose}");
  });
});
