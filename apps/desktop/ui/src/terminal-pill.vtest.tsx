import { afterEach, expect, test, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { setLocale } from "./i18n";
import { TerminalPill } from "./terminal-pill";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  setLocale("zh");
});

test("the pill stays hidden until a terminal exists, then opens its panel", async () => {
  setLocale("zh");
  const [count, setCount] = createSignal(0);
  const [active, setActive] = createSignal(false);
  const open = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <TerminalPill
        count={count}
        details={() => ["终端 1 · 仅自己 · agent-strata"]}
        open={open}
        active={active}
      />
    ),
    host,
  );
  expect(host.querySelector("button")).toBeNull();

  setCount(1);
  const button = await vi.waitFor(() => {
    const value = host.querySelector<HTMLButtonElement>("button");
    expect(value?.textContent).toContain("1 个终端");
    return value!;
  });
  button.click();
  expect(open).toHaveBeenCalledOnce();
  setActive(true);
  expect(button.className).toContain("border-input");
  expect(button.querySelector("svg")).not.toBeNull();
  button.parentElement?.dispatchEvent(new MouseEvent("mouseenter"));
  await vi.waitFor(() => {
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe("终端 1 · 仅自己 · agent-strata");
  });
});
