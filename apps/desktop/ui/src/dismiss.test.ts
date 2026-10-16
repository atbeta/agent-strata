import { describe, expect, test } from "bun:test";
import { isOutside } from "./dismiss";

/**
 * A stand-in carrying only the walk `contains` does, so the decision can be
 * exercised without a DOM. An element reports itself from `contains`.
 */
interface El {
  contains(n: El): boolean;
}
const el = (...children: El[]): El => {
  const self: El = { contains: (n) => n === self || children.some((c) => c.contains(n)) };
  return self;
};
/** The real signature is DOM's; these stand-ins only have to satisfy it. */
const asElement = (e: El) => e as unknown as Element;

describe("what counts as outside", () => {
  test("the trigger itself is inside", () => {
    const trigger = asElement(el());
    expect(isOutside(trigger, [trigger])).toBe(false);
  });

  test("anything the panel contains is inside", () => {
    const input = asElement(el());
    const panel = asElement(el(input));
    expect(isOutside(input, [panel])).toBe(false);
    expect(isOutside(panel, [panel])).toBe(false);
  });

  test("the page under it is outside", () => {
    const panel = asElement(el());
    const page = asElement(el());
    expect(isOutside(page, [panel])).toBe(true);
  });

  test("naming only the panel and not the trigger is the bug that sticks the button", () => {
    // The press that dismisses and the press that reopens both arrive on the
    // trigger; only the second one is named, so the panel closes as it opens.
    const trigger = asElement(el());
    const panel = asElement(el());
    expect(isOutside(trigger, [panel])).toBe(true);
    expect(isOutside(trigger, [panel, trigger])).toBe(false);
  });

  test("a detached element does not make the panel undismissable", () => {
    // The panel unmounted between the press and the read. Belonging to nobody
    // is not the same as being outside.
    expect(isOutside(asElement(el()), [undefined])).toBe(true);
  });

  test("no target is nobody's press to act on", () => {
    expect(isOutside(null, [asElement(el())])).toBe(false);
  });

  test("a panel and its trigger together cover both", () => {
    const input = asElement(el());
    const panel = asElement(el(input));
    const trigger = asElement(el());
    const inside = [panel, trigger];
    expect(isOutside(asElement(el()), inside)).toBe(true);
    expect(isOutside(input, inside)).toBe(false);
    expect(isOutside(trigger, inside)).toBe(false);
    expect(isOutside(panel, inside)).toBe(false);
  });
});
