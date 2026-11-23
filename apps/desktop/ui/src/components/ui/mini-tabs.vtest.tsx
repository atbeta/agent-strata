import { expect, test } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { MiniTabs } from "./mini-tabs";

test("a rebuilt option list keeps the tab under the pointer", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const [options, setOptions] = createSignal([
    { id: "files", label: "文件" },
    { id: "background", label: "后台", count: 1 },
    { id: "plugin:terminal", label: "交互终端" },
  ]);
  const [value, setValue] = createSignal("files");
  const clicks: string[] = [];
  const dispose = render(
    () => (
      <MiniTabs
        kind="tabs"
        label="面板"
        panelId="session-rail-panel"
        value={value()}
        options={options()}
        onChange={(id) => {
          clicks.push(id);
          setValue(id);
        }}
      />
    ),
    host,
  );

  const before = [...host.querySelectorAll("button")];
  expect(before.map((button) => button.textContent)).toEqual(["文件", "后台 1", "交互终端"]);
  // The same shape the rail produces on a transcript tick: new objects, same ids,
  // one count changed. The buttons have to be the nodes the pointer is already on.
  setOptions([
    { id: "files", label: "文件" },
    { id: "background", label: "后台", count: 2 },
    { id: "plugin:terminal", label: "交互终端" },
  ]);
  const after = [...host.querySelectorAll("button")];
  expect(after).toEqual(before);
  expect(after[1]!.textContent).toBe("后台 2");
  expect(after[0]!.getAttribute("aria-selected")).toBe("true");

  after[2]!.click();
  expect(clicks).toEqual(["plugin:terminal"]);
  expect(value()).toBe("plugin:terminal");
  expect(after[2]!.getAttribute("aria-selected")).toBe("true");
  expect(after[0]!.getAttribute("aria-selected")).toBe("false");

  setOptions([
    { id: "files", label: "文件" },
    { id: "plugin:schedule", label: "定时任务" },
  ]);
  const next = [...host.querySelectorAll("button")];
  expect(next).toHaveLength(2);
  expect(next[0]).toBe(before[0]);
  expect(next[1]!.textContent).toBe("定时任务");
  // The removed tab is no longer the keyboard target.
  expect(next[0]!.tabIndex).toBe(0);

  dispose();
  host.remove();
});
