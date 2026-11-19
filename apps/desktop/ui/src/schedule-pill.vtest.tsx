import { afterEach, expect, test, vi } from "vitest";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { ScheduleRow } from "./api";
import { setLocale } from "./i18n";
import { SchedulePill } from "./schedule-pill";
import { SchedulesPanel } from "./schedules-panel";
import { useSchedules, type SchedulesController } from "./use-schedules";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  setLocale("zh");
});

test("the pill appears for work, opens the panel, and shows its active state", async () => {
  const [count, setCount] = createSignal(0);
  const [active, setActive] = createSignal(false);
  const open = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <SchedulePill
        count={count}
        names={() => ["每日站会"]}
        next={() => "下次 5 分钟后"}
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
    expect(value?.textContent).toContain("1 个定时任务");
    expect(value?.textContent).toContain("下次 5 分钟后");
    return value!;
  });
  button.click();
  expect(open).toHaveBeenCalledOnce();
  setActive(true);
  expect(button.className).toContain("border-input");
});

test("the panel and pill share one load and one reload", async () => {
  const now = Date.now();
  const scheduled: ScheduleRow = {
    id: "sch_1",
    name: "每日站会",
    prompt: "总结今天的工作",
    created_by: "opencode:other",
    enabled: true,
    when: { kind: "daily", hour: 9, minute: 0 },
    target: { kind: "session", session_id: "opencode:me" },
    next_at: new Date(now + 5 * 60_000).toISOString(),
  };
  let empty = false;
  let reads = 0;
  vi.stubGlobal("fetch", () => {
    reads += 1;
    return Promise.resolve(
      Response.json({
        schedules: empty ? [] : [scheduled],
        candidates: [],
      }),
    );
  });

  const [showPanel, setShowPanel] = createSignal(false);
  let controller!: SchedulesController;
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => {
    controller = useSchedules(() => "opencode:me");
    return (
      <>
        <SchedulePill
          count={controller.count}
          names={controller.names}
          next={controller.next}
          open={() => setShowPanel(true)}
        />
        <Show when={showPanel()}>
          <SchedulesPanel sessionId={() => "opencode:me"} controller={controller} />
        </Show>
      </>
    );
  }, host);

  await vi.waitFor(() => expect(host.textContent).toContain("1 个定时任务"));
  expect(reads).toBe(1);
  host.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() => expect(host.textContent).toContain("总结今天的工作"));
  expect(reads).toBe(1);

  empty = true;
  controller.reload();
  await vi.waitFor(() => expect(host.textContent).toContain("还没有定时任务"));
  expect(host.textContent).not.toContain("1 个定时任务");
  expect(reads).toBe(2);
});
