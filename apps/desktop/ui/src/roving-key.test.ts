import { describe, expect, test } from "bun:test";
import { handleRovingKey } from "./roving-key";

function press(key: string, index: number, count = 3) {
  const options = Array.from({ length: count }, (_, i) => ({ id: `option-${i}` }));
  const changes: string[] = [];
  const focused: number[] = [];
  const items = options.map((_, i) => ({
    focus: () => {
      focused.push(i);
    },
  }) as unknown as HTMLElement);
  let prevented = false;
  handleRovingKey(
    {
      key,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as KeyboardEvent,
    index,
    options,
    (id) => changes.push(id),
    items,
  );
  return { changes, focused, prevented };
}

describe("roving option navigation", () => {
  test("arrows wrap in both directions", () => {
    expect(press("ArrowRight", 2)).toEqual({ changes: ["option-0"], focused: [0], prevented: true });
    expect(press("ArrowDown", 1)).toEqual({ changes: ["option-2"], focused: [2], prevented: true });
    expect(press("ArrowLeft", 0)).toEqual({ changes: ["option-2"], focused: [2], prevented: true });
    expect(press("ArrowUp", 1)).toEqual({ changes: ["option-0"], focused: [0], prevented: true });
  });

  test("Home and End select and focus the endpoints", () => {
    expect(press("Home", 2)).toEqual({ changes: ["option-0"], focused: [0], prevented: true });
    expect(press("End", 0)).toEqual({ changes: ["option-2"], focused: [2], prevented: true });
  });

  test("other keys and empty groups are left alone", () => {
    expect(press("Enter", 0)).toEqual({ changes: [], focused: [], prevented: false });
    expect(press("ArrowRight", 0, 0)).toEqual({ changes: [], focused: [], prevented: false });
  });
});
