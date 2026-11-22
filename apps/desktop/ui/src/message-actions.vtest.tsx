import { afterEach, expect, test } from "vitest";
import { render } from "solid-js/web";
import type { JSX } from "solid-js";
import { stamp } from "./i18n";
import { MessageActions } from "./message-actions";

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  host?.remove();
  host = undefined;
});

const ISO = "2026-10-22T06:32:00.000Z";

function mount(node: () => JSX.Element) {
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(node, host);
  return host;
}

test("the footer time sits outside the hover-revealed tools and keeps the full stamp in its title", () => {
  const el = mount(
    () => (
      <MessageActions
        text="hi"
        align="start"
        time={ISO}
        details={{ content: [], ts: ISO }}
      />
    ),
  );

  const footer = el.querySelector(".message-actions");
  expect(footer).not.toBeNull();
  const tools = footer!.querySelector(".message-actions-tools");
  expect(tools).not.toBeNull();
  const buttons = [...tools!.querySelectorAll("button")];
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) {
    expect(b.className).toContain("size-5");
    expect(b.className).toContain("bg-card/95");
    expect(b.className).toContain("shadow-sm");
  }
  for (const icon of tools!.querySelectorAll("svg")) {
    expect(icon.getAttribute("class")).toContain("size-3");
    expect(icon.getAttribute("class")).not.toContain("size-3.5");
  }

  const time = footer!.querySelector("time[datetime]");
  expect(time).not.toBeNull();
  expect(time!.getAttribute("datetime")).toBe(ISO);
  expect(time!.closest(".message-actions-tools")).toBeNull();
  expect(time!.getAttribute("title")).toBe(stamp(ISO));
  expect(time!.className).not.toContain("ml-auto");
  expect(time!.previousElementSibling).toBe(tools);
});

test("persistent footers render their buttons without the hover-reveal group", () => {
  const el = mount(
    () => (
      <MessageActions
        text="hi"
        align="start"
        time={ISO}
        details={{ content: [], ts: ISO }}
        persistent
      />
    ),
  );

  const footer = el.querySelector(".message-actions");
  expect(footer).not.toBeNull();
  expect(footer!.querySelector(".message-actions-tools")).toBeNull();
  const buttons = [...footer!.querySelectorAll("button")];
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) {
    expect(b.className).toContain("size-5");
    expect(b.className).not.toContain("bg-card/95");
    expect(b.className).not.toContain("shadow-sm");
  }
  for (const icon of footer!.querySelectorAll("svg")) {
    expect(icon.getAttribute("class")).toContain("size-3.5");
  }

  const time = footer!.querySelector("time[datetime]");
  expect(time).not.toBeNull();
  expect(time!.className).not.toContain("ml-auto");
});

test("disabled hides the time with the rest of the controls", () => {
  const el = mount(() => <MessageActions text="hi" align="start" time={ISO} disabled />);

  expect(el.querySelector(".message-actions time")).toBeNull();
  expect(el.querySelector(".message-actions-tools")).toBeNull();
});
