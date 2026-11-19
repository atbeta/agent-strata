import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { setLocale } from "./i18n";
import { SchedulesPanel } from "./schedules-panel";
import { useSchedules } from "./use-schedules";

/**
 * The panel's shape is the thing a reader sees, and the format tests never
 * mount it. This checks the two decisions that only exist in the component:
 * the form stays closed until asked, and a card reads as one line rather
 * than as a labelled row per fact.
 */

const payload = () => {
  const now = Date.now();
  return {
  schedules: [
    {
      id: "daily",
      name: "每日站会",
      prompt: "把今天的三件事和昨天没做完的事各列三条",
      created_by: "opencode:me",
      enabled: true,
      when: { kind: "daily", hour: 9, minute: 30 },
      target: { kind: "session", session_id: "opencode:me" },
      next_at: new Date(now + 2 * 3_600_000).toISOString(),
      last_run_at: new Date(now - 20 * 3_600_000).toISOString(),
      last_result: "ok",
    },
    {
      id: "weekly",
      name: "周五发布检查",
      prompt: "跑一遍发布前检查清单，把失败项贴出来",
      created_by: "opencode:me",
      enabled: true,
      when: { kind: "weekly", weekday: 5, hour: 18, minute: 0 },
      target: { kind: "session", session_id: "opencode:pipe" },
      target_title: "发布流水线",
      next_at: new Date(now + 3 * 86_400_000).toISOString(),
      last_run_at: new Date(now - 4 * 86_400_000).toISOString(),
      last_result: "skipped-busy",
    },
    {
      id: "paused",
      name: "已暂停的每小时同步",
      prompt: "同步依赖清单",
      created_by: "opencode:me",
      enabled: false,
      when: { kind: "every", everyMs: 60 * 60_000 },
      target: { kind: "session", session_id: "opencode:me" },
      next_at: null,
      last_run_at: new Date(now - 2 * 86_400_000).toISOString(),
      last_result: "failed",
    },
  ],
  candidates: [{ session_id: "opencode:pipe", title: "发布流水线" }],
  };
};

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

test("a card is one sentence, and the form stays closed until asked", async () => {
  setLocale("zh");
  // jsdom has no scrollIntoView; opening the form asks the rail to show it.
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/plugins/schedule/resources/schedules")) {
      return Promise.resolve(new Response(JSON.stringify(payload()), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });

  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => {
    const controller = useSchedules(() => "opencode:me");
    return <SchedulesPanel sessionId={() => "opencode:me"} controller={controller} />;
  }, host);
  await vi.waitFor(() => {
    expect(host.textContent).toContain("每日站会");
  });

  const text = host.textContent ?? "";
  expect(text).toContain("把今天的三件事和昨天没做完的事各列三条");
  expect(text).toContain("下次 2 小时后");
  expect(text).toContain("成功，20 小时前");
  expect(text).toContain("发到 发布流水线");
  expect(text).toContain("已暂停 · 失败，2 天前");
  // The old labelled rows answered the same questions in more space.
  expect(text).not.toContain("下次运行");
  expect(text).not.toContain("最近运行");
  expect(text).not.toContain("生效会话");
  expect(text).not.toContain("新建定时");
  expect(text).not.toContain("任务内容");

  const prompt = [...host.querySelectorAll("p")].find((p) =>
    p.textContent?.includes("把今天的三件事"),
  );
  expect(prompt?.className).toContain("line-clamp-2");

  const paused = [...host.querySelectorAll("p")].find((p) => p.textContent === "已暂停的每小时同步");
  expect(paused?.className).toContain("text-muted-foreground");

  const open = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("新建"));
  expect(open).toBeTruthy();
  open!.click();
  expect(host.textContent).toContain("新建定时任务");
  expect(host.textContent).not.toContain("任务内容");
  const clock = host.querySelector<HTMLInputElement>("input[placeholder='09:30']");
  expect(clock).toBeTruthy();
  expect(clock?.type).toBe("text");
});

test("a taken name names the session that already uses it", async () => {
  setLocale("zh");
  Element.prototype.scrollIntoView ??= () => {};
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/plugins/schedule/resources/schedules")) {
      return Promise.resolve(new Response(JSON.stringify(payload()), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected ${url}`));
  });

  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => {
    const controller = useSchedules(() => "opencode:me");
    return <SchedulesPanel sessionId={() => "opencode:me"} controller={controller} />;
  }, host);
  await vi.waitFor(() => expect(host.textContent).toContain("周五发布检查"));

  const open = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("新建"));
  open!.click();
  const name = host.querySelector<HTMLInputElement>("input");
  expect(name).toBeTruthy();
  name!.value = "周五发布检查";
  name!.dispatchEvent(new InputEvent("input", { bubbles: true }));
  const create = [...host.querySelectorAll("button")].find((b) => b.textContent === "创建");
  create!.click();

  expect(host.textContent).toContain("名称「周五发布检查」已被会话「发布流水线」占用");
  expect(host.textContent).not.toMatch(/sch_[a-z0-9]+/);
});

test("the first load never presents the empty state as settled content", async () => {
  setLocale("zh");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal("fetch", () =>
    pending.then(
      () => new Response(JSON.stringify(payload()), { status: 200 }),
    ),
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => {
    const controller = useSchedules(() => "opencode:me");
    return <SchedulesPanel sessionId={() => "opencode:me"} controller={controller} />;
  }, host);

  expect(host.textContent).toContain("正在读取定时任务");
  expect(host.textContent).not.toContain("还没有定时任务");
  expect(host.querySelector<HTMLButtonElement>("button[disabled]")?.textContent).toContain("新建");

  release();
  await vi.waitFor(() => expect(host.textContent).toContain("每日站会"));
  expect(host.textContent).not.toContain("正在读取定时任务");
});
