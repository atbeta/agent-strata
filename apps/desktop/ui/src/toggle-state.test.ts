import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toggleClasses } from "./toggle-state";

const read = (f: string) => readFileSync(join(import.meta.dir, f), "utf8");

describe("a toggle that says it is on", () => {
  test("the lit state is a ring, because hover already spends the background", () => {
    // The button's own hover is `bg-secondary text-foreground`, which is what
    // the lit state used to be. So a closed button under the cursor and an open
    // one without it were the same picture — and the cursor is over one of
    // these at the exact moment you are deciding which one to press.
    const on = toggleClasses(true);
    expect(on).toContain("ring-1");
    expect(on).not.toContain("bg-secondary");
    expect(toggleClasses(false)).toBe("");
  });

  test("no hover variant in the button sets a ring, so the ring cannot be faked", () => {
    // A background would have done the job had hover not already claimed that
    // channel; a ring is a box-shadow, so nothing in hover reaches it.
    const button = read("components/ui/button.tsx");
    const icon = button.slice(button.indexOf('icon: "'), button.indexOf('icon: "') + 200);
    expect(icon).not.toContain("ring");
  });
});

describe("the header row", () => {
  const detail = () => read("session-detail.tsx");

  test("every anchored panel names its trigger, so dismiss cannot fight its own open", () => {
    // Without the trigger in the inside-set, the press that dismisses and the
    // press that reopens both arrive and the button reads as stuck. The tools
    // panel's opener is not a button but an item inside the more-menu's portal,
    // so the menu body itself is what must count as inside.
    const src = detail();
    const search = src.slice(src.indexOf("useDismiss(search.searchOpen"), src.indexOf("useDismiss(tools.toolsOpen"));
    const tools = src.slice(src.indexOf("useDismiss(tools.toolsOpen"), src.indexOf("useDismiss(tools.toolsOpen") + 300);
    expect(search).toContain("searchPanelEl");
    expect(search).toContain("searchTriggerEl");
    expect(tools).toContain("toolsPanelEl");
    expect(tools).toContain("moreMenuEl");
  });

  test("both panels register their body so a press inside it is not a dismiss", () => {
    const src = detail();
    expect(src).toContain("<SearchPanel search={search} bindPanel={(el) => (searchPanelEl = el)} />");
    expect(src).toContain("tools={tools}");
    expect(src).toContain("bindPanel={(el) => (toolsPanelEl = el)}");
  });

  test("the shield is the one toggle whose open state is not just a panel", () => {
    // It changes what the agent may do without asking, so when it is on it takes
    // the colour the permission cards already use and cannot be read as
    // "something is showing". Red is its third state: a switch that cannot be
    // read is neither on nor off, and must not be drawn as either.
    const src = detail();
    const at = src.indexOf('label={t("header.autoAccept")}');
    expect(at).toBeGreaterThan(-1);
    const tone = src.slice(at, src.indexOf("onClick", at));
    expect(tone).toContain("text-event-permission");
    expect(tone).toContain("text-destructive");
    // The unlit end is spelled out rather than left to the default, because the
    // default would be the same muted grey a panel toggle uses and this row
    // needs the amber to be the thing that stands out.
    expect(tone).toContain("text-muted-foreground");
    expect(tone).toContain("on()");
  });

  test("a tone replaces both states, so an unreadable switch can be neither", () => {
    // `on` is false when the switch cannot be read, so a tone that only
    // decorated the lit state would have left the alarming one drawn as an
    // ordinary off button — which is exactly what it was before.
    const header = read("header-toggle.tsx");
    const at = header.indexOf("props.tone ??");
    expect(at).toBeGreaterThan(-1);
    const line = header.slice(at, header.indexOf("`}", at));
    expect(line).toContain("props.on ?");
  });

  test("the pane menu and the header share one lit state instead of two", () => {
    // They were written apart, which is how the header came to look like the
    // menu did not apply. The zoom button is the same collision inside a single
    // menu, so it had to move with them.
    const pane = read("pane-stage.tsx");
    expect(pane).toContain('from "./toggle-state"');
    expect(pane).not.toContain('props.zoomed ? "bg-secondary text-foreground"');
    expect(read("search.tsx")).toContain('from "./toggle-state"');
  });
});

describe("what else in the app still spends the hover background on a state", () => {
  test("no toggle does; the list selections are a different thing and stay", () => {
    // The remaining `bg-secondary text-foreground` sites are selected *rows* in
    // a list — settings nav, provider list, terminal tabs — where the highlight
    // is the primary signal and a hovered row reads as a different visual from a
    // selected one. They are left alone on purpose, so this says what is
    // deliberately still there rather than sweeping the string out.
    for (const f of ["session-detail.tsx", "search.tsx"]) {
      expect(read(f)).not.toContain('"bg-secondary text-foreground"');
    }
    // pane-stage.tsx now has one too, and it is the focused pane header: a
    // selected *surface*, the same family as the settings row and the mini tab
    // asserted below, rather than a control that changes something when pressed.
    // Sweeping the string out of this file would only have meant deleting a list
    // of exemptions from this test until it meant nothing, so the exemption is
    // stated instead and pinned: the one site is the header, and the state it
    // tracks is focus.
    const pane = read("pane-stage.tsx");
    const at = pane.indexOf('"bg-secondary text-foreground"');
    expect(at).toBeGreaterThan(-1);
    expect(pane.slice(Math.max(0, at - 200), at)).toContain("props.focused");
    expect(pane.slice(at + '"bg-secondary text-foreground"'.length)).not.toContain(
      '"bg-secondary text-foreground"',
    );
    expect(read("settings.tsx")).toContain('"bg-secondary text-foreground"');
    expect(read("components/ui/mini-tabs.tsx")).toContain('"bg-secondary text-foreground"');
  });
});
