import { afterEach, expect, test, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { setLocale } from "./i18n";
import { ScheduleDateTimeField } from "./schedule-date-time";
import { ScheduleSessionPicker } from "./schedule-session-picker";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function press(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
  element.click();
}

test("the calendar edits the date and keeps the selected wall-clock time", async () => {
  setLocale("zh");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const [value, setValue] = createSignal("2026-11-19T12:30");
  dispose = render(() => <ScheduleDateTimeField value={value()} onChange={setValue} />, host);

  host.querySelector<HTMLButtonElement>("button[aria-label='日期和时间']")!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("2026年11月"));
  expect(document.querySelector("input[type='datetime-local']")).toBeNull();

  const day20 = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "20" && !button.className.includes("text-muted-foreground/50"),
  );
  day20!.click();
  expect(value()).toBe("2026-11-20T12:30");

  type(document.querySelector<HTMLInputElement>("#schedule-at-time")!, "1");
  expect(value()).toBe("2026-11-20T1");
  type(document.querySelector<HTMLInputElement>("#schedule-at-time")!, "18:05");
  expect(value()).toBe("2026-11-20T18:05");

  document.querySelector<HTMLButtonElement>("button[aria-label='下个月']")!.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("2026年12月"));
  const day1 = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "1" && !button.className.includes("text-muted-foreground/50"),
  );
  day1!.click();
  expect(value()).toBe("2026-12-01T18:05");
});

test("the session picker searches and mounts only the first thirty matches", async () => {
  setLocale("zh");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.appendChild(host);
  const options = Array.from({ length: 40 }, (_, index) => ({
    session_id: `session:${index + 1}`,
    title: `Session ${index + 1}`,
  }));
  const [value, setValue] = createSignal("");
  dispose = render(
    () => <ScheduleSessionPicker value={value()} options={options} onChange={setValue} />,
    host,
  );

  press(host.querySelector<HTMLButtonElement>("button[aria-label='目标会话']")!);
  const search = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("input[aria-label='搜索会话名称或 ID']");
    expect(input).toBeTruthy();
    return input!;
  });
  expect(document.querySelectorAll("[role='menuitem']").length).toBe(30);
  expect(document.body.textContent).toContain("仅显示前 30 个结果");

  type(search, "session:40");
  await vi.waitFor(() => expect(document.querySelectorAll("[role='menuitem']").length).toBe(1));
  press(document.querySelector<HTMLElement>("[role='menuitem']")!);
  await vi.waitFor(() => expect(value()).toBe("session:40"));
  expect(host.textContent).toContain("Session 40");

  press(host.querySelector<HTMLButtonElement>("button[aria-label='目标会话']")!);
  const reopened = await vi.waitFor(() => {
    const input = document.querySelector<HTMLInputElement>("input[aria-label='搜索会话名称或 ID']");
    expect(input).toBeTruthy();
    return input!;
  });
  type(reopened, "nothing matches this");
  await vi.waitFor(() => expect(document.body.textContent).toContain("没有匹配的会话"));
});
