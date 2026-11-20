import { beforeAll, expect, test, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { emptySessionView, type FileChangeView, type Turn } from "@agent-strata/projector";
import { TurnBlock } from "./transcript";
import { PlanStrip } from "./plan-strip";
import { writePlanChoice } from "./plan-progress";
import { SessionRail } from "./session-rail";
import { SessionDetail } from "./session-detail";
import type { DevProcesses } from "./dev-processes";
import type { SchedulesController } from "./use-schedules";
import type { SessionRowSummary } from "./pane-stage";

/**
 * A component that crashes during setup — a resource whose source reads a
 * const declared below it, a signal the JSX spells wrong — fails nothing in
 * `bun test`, because the suite there never mounts one. These tests exist so
 * a mount-time ReferenceError or render crash is a CI failure, not a report.
 */

beforeAll(() => {
  // jsdom does not implement ResizeObserver; the rail measures its column.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // The transcript's virtual list watches visibility the same way.
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
  Element.prototype.scrollIntoView ??= () => {};
  // jsdom has no matchMedia; the rail asks it whether motion is welcome.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
  })) as unknown as typeof window.matchMedia;
  // No service is listening: reads land as connection failures, the same
  // state the app itself boots through while the sidecar warms up.
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
      addEventListener() {}
      set onmessage(_v: unknown) {}
    },
  );
});

const devStub = {
  processes: () => [],
  running: () => 0,
  count: () => 0,
  commands: () => [],
  stop: async () => {},
  forget: async () => {},
  refetch: async () => {},
} as unknown as DevProcesses;

const schedulesStub = {
  rows: () => [],
  candidates: () => [],
  loadState: () => "ready",
  error: () => undefined,
  current: () => [],
  count: () => 0,
  names: () => [],
  next: () => "",
  reload: () => {},
} as SchedulesController;

test("PlanStrip mounts and draws a cancelled step as struck", () => {
  const host = document.createElement("div");
  // A plan with nothing in flight starts collapsed; pin it open the way a
  // reader's saved choice would.
  writePlanChoice("ses_x", true);
  render(
    () => (
      <PlanStrip
        sessionId="ses_x"
        generating={false}
        plan={[
          { content: "landed", status: "completed" },
          { content: "dropped", status: "cancelled" },
          { content: "waiting", status: "pending" },
        ]}
      />
    ),
    host,
  );
  const rows = [...host.querySelectorAll("li")];
  expect(rows.map((r) => r.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining("dropped")]),
  );
  const dropped = rows.find((r) => r.textContent?.includes("dropped"));
  expect(dropped?.querySelector(".line-through")).toBeTruthy();
});

const edit: FileChangeView = {
  path: "src/alpha.ts",
  change: "modify",
  count: 1,
  additions: 3,
  deletions: 1,
  unexplained: false,
  edits: [{ change: "modify", additions: 3, deletions: 1, turn_index: -1 }],
};

const railProps = (view: ReturnType<typeof emptySessionView>, opencode: boolean) => ({
  sessionId: () => view.session_id,
  view: () => view,
  opencode: () => opencode,
  open: () => true,
  tab: () => "changes" as const,
  onSelectTab: () => {},
  onClose: () => {},
  onJumpToTurn: () => {},
  onCite: () => {},
  dev: devStub,
  schedules: schedulesStub,
  vcs: () => undefined,
});

test("SessionRail mounts the session pane for a non-OpenCode backend", () => {
  const view = emptySessionView("acp:s1", "acp");
  view.files_changed.push(edit);
  const host = document.createElement("div");
  render(() => <SessionRail {...railProps(view, false)} />, host);
  expect(host.textContent).toContain("alpha.ts");
});

test("a change with no counted lines does not print a zero stat", () => {
  const view = emptySessionView("acp:zeros", "acp");
  view.files_changed.push(
    {
      path: "src/collapse.vue",
      change: "modify",
      count: 1,
      additions: 0,
      deletions: 0,
      unexplained: true,
      edits: [{ change: "modify", additions: 0, deletions: 0, turn_index: -1 }],
    },
    {
      path: "src/counted.vue",
      change: "modify",
      count: 2,
      additions: 4,
      deletions: 1,
      unexplained: true,
      edits: [
        { change: "modify", additions: 4, deletions: 1, turn_index: -1 },
        { change: "modify", additions: 0, deletions: 0, turn_index: -1 },
      ],
    },
  );
  const host = document.createElement("div");
  render(() => <SessionRail {...railProps(view, false)} />, host);
  const row = (name: string) =>
    [...host.querySelectorAll("li")].find((el) => el.textContent?.includes(name));
  // The file stays. The "≥+0 −0" that used to fill the list does not.
  expect(row("collapse.vue")?.textContent).toContain("collapse.vue");
  expect(row("collapse.vue")?.textContent).not.toContain("≥");
  expect(row("collapse.vue")?.textContent).not.toContain("+0");
  // A lower bound that actually counted something is still said.
  expect(row("counted.vue")?.textContent).toContain("≥+");
  expect(row("counted.vue")?.textContent).toContain("4");
});

test("SessionRail mounts for an OpenCode session on the default source", () => {
  const view = emptySessionView("opencode:s2", "opencode");
  view.files_changed.push(edit);
  const host = document.createElement("div");
  render(() => <SessionRail {...railProps(view, true)} />, host);
  // Default source is "session": the file record renders, not a git fetch.
  expect(host.textContent).toContain("alpha.ts");
});

test("SessionRail switches through the launcher and restores the last panel", async () => {
  const view = emptySessionView("opencode:launcher", "opencode");
  view.files_changed.push(edit);
  const [tab, setTab] = createSignal<string>("changes");
  const [open, setOpen] = createSignal(true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(
    () => <SessionRail {...railProps(view, true)} tab={tab} open={open} onSelectTab={setTab} />,
    host,
  );
  const panelButton = (label: string) =>
    [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(label));
  const switcher = () => host.querySelector('[aria-label="切换面板"]') as HTMLButtonElement | null;

  panelButton("alpha.ts")?.click();
  expect(panelButton("alpha.ts")?.getAttribute("aria-current")).toBe("true");
  switcher()?.click();
  expect(host.textContent).toContain("从这里开始");
  expect(panelButton("改动")?.textContent).toContain("1");
  panelButton("后台")?.click();
  expect(tab()).toBe("background");
  expect(host.textContent).toContain("这个会话还没有后台进程");
  expect(host.textContent).not.toContain("从这里开始");

  setOpen(false);
  await new Promise((resolve) => setTimeout(resolve, 160));
  setOpen(true);
  expect(host.textContent).toContain("这个会话还没有后台进程");
  expect(host.textContent).not.toContain("从这里开始");

  switcher()?.click();
  panelButton("改动")?.click();
  expect(tab()).toBe("changes");
  expect(host.textContent).toContain("alpha.ts");
  expect(panelButton("alpha.ts")?.getAttribute("aria-current")).toBe("true");
  dispose();
  host.remove();
});

test("SessionRail measures its mounted parent instead of the window", async () => {
  const view = emptySessionView("acp:geometry", "acp");
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 660, configurable: true });
  localStorage.setItem("strata.rail-width", "700");
  const dispose = render(() => <SessionRail {...railProps(view, false)} />, host);
  await Promise.resolve();
  const rail = host.querySelector("aside")!;
  expect(rail.style.width).toBe("409px");
  expect(rail.querySelector('[role="separator"]')?.getAttribute("aria-valuemax")).toBe("409");
  dispose();
});

test("SessionRail holds its mount for the exit, then leaves", async () => {
  const view = emptySessionView("acp:exit", "acp");
  const [open, setOpen] = createSignal(true);
  const host = document.createElement("div");
  const dispose = render(() => <SessionRail {...railProps(view, false)} open={open} />, host);
  expect(host.querySelector("aside")?.className).toContain("rail-in");
  setOpen(false);
  // The close is answered at once in the class, but the aside stays for the fade.
  expect(host.querySelector("aside")?.className).toContain("rail-out");
  await new Promise((r) => setTimeout(r, 200));
  expect(host.querySelector("aside")).toBeNull();
  dispose();
});

test("a scheduled prompt keeps its source in the user bubble, not its wire text", () => {
  const turn: Turn = {
    turn_id: "scheduled",
    user: [{ type: "text", text: "[scheduled: 测试定时任务]\n\n看到只需要回复一个 OK" }],
    assistant: [],
    tool_calls: [],
  };
  const host = document.createElement("div");
  const dispose = render(() => <TurnBlock turn={turn} />, host);
  const message = host.querySelector('[data-message-role="user"]');
  const source = host.querySelector('[data-message-source="scheduled"]');
  expect(source?.textContent).toContain("定时任务");
  expect(source?.textContent).toContain("测试定时任务");
  expect(message?.textContent).toContain("看到只需要回复一个 OK");
  expect(message?.textContent).not.toContain("[scheduled:");
  expect(turn.user?.[0]).toEqual({
    type: "text",
    text: "[scheduled: 测试定时任务]\n\n看到只需要回复一个 OK",
  });
  dispose();
});

test("a permission wait is amber and still, while real work keeps its pulse", () => {
  const waiting: Turn = {
    turn_id: "waiting",
    assistant: [],
    tool_calls: [
      {
        call_id: "permission",
        tool: "read",
        input: { path: "a.ts" },
        status: "pending",
        permission: { request_id: "ask-permission" },
      },
    ],
  };
  const host = document.createElement("div");
  const dispose = render(() => <TurnBlock turn={waiting} live={() => true} />, host);
  expect(host.querySelector("span.text-event-permission")).not.toBeNull();
  expect(host.querySelector('[class*="animate-pulse"]')).toBeNull();
  expect(host.querySelector(".tool-dot")).toBeNull();
  dispose();

  waiting.tool_calls[0]!.permission = undefined;
  const runningHost = document.createElement("div");
  const disposeRunning = render(() => <TurnBlock turn={waiting} live={() => true} />, runningHost);
  expect(runningHost.querySelector('[class*="animate-pulse"]')).not.toBeNull();
  disposeRunning();
});

test("SessionDetail mounts — the view that crashed on a forward-referenced resource", () => {
  const row: SessionRowSummary = {
    summary: { session_id: "opencode:s3", title: "s", workspace: "/tmp/ws" },
    status: "active",
  };
  const host = document.createElement("div");
  // Every resource inside fires a fetch that rejects here; the mount is what
  // is under test — a setup-time throw would escape render() and fail this.
  render(() => <SessionDetail id={row.summary.session_id} sessions={[row]} onNewSession={() => {}} />, host);
  expect(host.innerHTML.length).toBeGreaterThan(0);
});
