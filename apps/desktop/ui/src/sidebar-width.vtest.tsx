import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { Sidebar } from "./sidebar";
import { NO_LENS } from "./project-view";
import { SIDEBAR_WIDTH_KEY } from "./sidebar-width";
import type { SessionListCtl } from "./use-session-list";
import type { WorkspaceCtl } from "./use-workspace";
import type { ConnectionsCtl } from "./use-connections";

let dispose: (() => void) | undefined;

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.setPointerCapture ??= () => {};
});

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  localStorage.clear();
  document.body.innerHTML = "";
});

function mountSidebar() {
  const data = Object.assign(() => ({ sessions: [], more: false }), { error: undefined });
  const list = {
    data,
    sessions: () => [],
    archived: () => [],
    groups: () => [],
    pins: () => [],
    lens: () => NO_LENS,
    lensActive: () => false,
    actionErr: () => "",
    more: () => false,
  } as unknown as SessionListCtl;
  const ws = {
    worktreeOf: () => undefined,
    repoOf: () => undefined,
    isBookmark: () => false,
    dirOpen: () => false,
    dirDraft: () => "",
  } as unknown as WorkspaceCtl;
  const connectionData = Object.assign(
    () => ({ connections: [], attempts: [] }),
    { error: undefined },
  );
  const conns = {
    conns: connectionData,
    phase: () => "idle",
    connected: () => false,
    connErr: () => "",
    syncShown: () => false,
    syncTicks: () => new Map(),
  } as unknown as ConnectionsCtl;
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <Sidebar
        list={list}
        ws={ws}
        conns={conns}
        sidebarOpen={true}
        onToggleSidebar={() => {}}
        onOpenPalette={() => {}}
        fleetActive={true}
        compareOn={false}
        compareSel={[]}
        onStartCompare={() => {}}
        onCancelCompare={() => {}}
        onOpenCompare={() => {}}
        activeId={() => undefined}
        clock={() => 0}
        onOpenSession={() => {}}
        onNewSession={() => {}}
        worktreeJob={() => undefined}
        onOpenFleet={() => {}}
        focusDir={() => undefined}
        clearFocusDir={() => {}}
      />
    ),
    host,
  );
  const aside = host.querySelector("aside")!;
  const separator = host.querySelector<HTMLElement>('[role="separator"]')!;
  return { aside, separator };
}

function pointer(type: string, clientX: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

test("arrow keys resize the real sidebar and remember the width", async () => {
  const { aside, separator } = mountSidebar();
  expect(aside.style.width).toBe("300px");

  separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await vi.waitFor(() => expect(aside.style.width).toBe("316px"));
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("316");

  separator.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }),
  );
  await vi.waitFor(() => expect(aside.style.width).toBe("268px"));
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("268");
});

test("dragging the edge resizes the sidebar and saves on release", async () => {
  const { aside, separator } = mountSidebar();

  separator.dispatchEvent(pointer("pointerdown", 300));
  separator.dispatchEvent(pointer("pointermove", 364));
  await vi.waitFor(() => expect(aside.style.width).toBe("364px"));
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBeNull();

  separator.dispatchEvent(pointer("pointerup", 364));
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("364");
});
