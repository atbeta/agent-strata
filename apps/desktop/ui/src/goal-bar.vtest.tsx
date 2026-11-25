import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { GoalStrip, useGoal } from "./goal-bar";
import { setLocale } from "./i18n";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  setLocale("zh");
});

function mount(state: { paused?: boolean; blocked?: boolean }) {
  const writes: unknown[] = [];
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    writes.push(JSON.parse(String(init?.body ?? "null")));
    return Promise.resolve(Response.json({ ok: true }));
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => {
    const g = useGoal(
      () => "opencode:s1",
      () => "ship it",
      () => false,
      () => state.paused,
      () => state.blocked,
      () => "needs a key",
    );
    return <GoalStrip g={g} />;
  }, host);
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
  return { writes, button };
}

test("resuming a blocked goal lifts the block instead of asking to pause it", async () => {
  const { writes, button } = mount({ blocked: true });
  button("继续")!.click();
  await vi.waitFor(() => expect(writes).toEqual([{ paused: false }]));
});

test("a running goal's button pauses it", async () => {
  const { writes, button } = mount({});
  button("暂停")!.click();
  await vi.waitFor(() => expect(writes).toEqual([{ paused: true }]));
});
