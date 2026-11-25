import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import type { SessionRow } from "./api";
import { useSessionList, type SessionListCtl } from "./use-session-list";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
  location.hash = "";
  document.body.innerHTML = "";
});

const row: SessionRow = {
  summary: {
    session_id: "opencode:a",
    backend: "opencode",
    workspace: "/repo",
    title: "A",
    started_at: "2026-01-01T00:00:00Z",
    last_ts: "2026-01-01T00:00:00Z",
    last_seq: 1,
  },
  status: "idle",
  totals: { input: 0, output: 0, cost_usd: 0, tool_calls: 0, cache_read: 0, cache_write: 0 },
};

function mountController(
  activeId?: string,
  leave?: () => void,
): { ctl: SessionListCtl; requests: () => number } {
  let requests = 0;
  vi.stubGlobal("fetch", () => {
    requests += 1;
    return Promise.resolve(
      Response.json({ sessions: [row], aggregate: { total: { cost_usd: 0, input: 0, output: 0 } } }),
    );
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  let ctl: SessionListCtl | undefined;
  dispose = render(() => {
    ctl = useSessionList({ extraDirs: () => [], clock: () => 0, activeId: () => activeId, leave });
    return <></>;
  }, host);
  return { ctl: ctl!, requests: () => requests };
}

test("a background delete keeps the pending row visible until it succeeds", async () => {
  const { ctl, requests } = mountController("opencode:a");
  await vi.waitFor(() => expect(ctl.sessions()).toHaveLength(1));
  let finish: (() => void) | undefined;
  const pending = ctl.runDelete("opencode:a", () => new Promise<void>((resolve) => {
    finish = resolve;
  }));

  expect(ctl.isDeleting("opencode:a")).toBe(true);
  expect(ctl.sessions()).toHaveLength(1);
  expect(location.hash).toBe("#/");

  finish!();
  await pending;
  expect(ctl.isDeleting("opencode:a")).toBe(false);
  expect(ctl.sessions()).toHaveLength(0);
  expect(requests()).toBe(1);
});

test("deleting the open session leaves through the window, in the same frame as the confirm", async () => {
  const leave = vi.fn();
  const { ctl } = mountController("opencode:a", leave);
  await vi.waitFor(() => expect(ctl.sessions()).toHaveLength(1));
  const pending = ctl.runDelete("opencode:a", () => new Promise<void>(() => {}));
  // Before the delete is even sent: the screen moves now, not on the next hashchange.
  expect(leave).toHaveBeenCalledTimes(1);
  void pending;
});

test("a failed background delete restores the row without another list request", async () => {
  const { ctl, requests } = mountController();
  await vi.waitFor(() => expect(ctl.sessions()).toHaveLength(1));

  await ctl.runDelete("opencode:a", () => Promise.reject(new Error("backend refused")));

  expect(ctl.isDeleting("opencode:a")).toBe(false);
  expect(ctl.sessions()).toHaveLength(1);
  expect(ctl.actionErr()).toBe("backend refused");
  expect(requests()).toBe(1);
});
