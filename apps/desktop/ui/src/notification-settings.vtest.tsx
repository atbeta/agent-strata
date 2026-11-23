import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { setLocale } from "./i18n";
import { NotificationSettings } from "./notification-settings";
import { THINKING_KEY } from "./thinking";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  localStorage.clear();
  document.body.innerHTML = "";
});

test("session notifications live together and thinking keeps its saved preference", async () => {
  setLocale("zh");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const changed = vi.fn();
  window.addEventListener("strata-thinking", changed);
  dispose = render(() => <NotificationSettings />, host);

  expect(host.textContent).toContain("思考过程");
  expect(host.textContent).toContain("完成时通知");
  expect(host.textContent).toContain("等待时通知");
  expect(host.textContent).toContain("音效");
  expect(host.textContent).not.toContain("配色方案");

  const thinking = host.querySelector<HTMLInputElement>("input[aria-label='思考过程']")!;
  thinking.click();
  expect(localStorage.getItem(THINKING_KEY)).toBe("open");
  expect(changed).toHaveBeenCalledOnce();
  window.removeEventListener("strata-thinking", changed);
});
