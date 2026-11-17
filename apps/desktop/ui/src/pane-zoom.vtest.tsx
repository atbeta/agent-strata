import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { beforeAll, expect, test } from "vitest";
import { PaneStage } from "./pane-stage";
import type { PaneWorkspaceState } from "./pane-tree";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});

function workspace(zoomedPaneId: string | null): PaneWorkspaceState {
  return {
    mode: "multiplex",
    focusedPaneId: "pane-2",
    zoomedPaneId,
    root: {
      kind: "split",
      id: "split-1",
      dir: "row",
      ratio: 0.5,
      a: { kind: "leaf", id: "pane-1", sessionId: "s1" },
      b: { kind: "leaf", id: "pane-2", sessionId: "s2" },
    },
  };
}

test("zooming keeps one transcript per pane", () => {
  const host = document.createElement("div");
  const counts = new Map<string, number>();
  const [ws, setWs] = createSignal(workspace(null));
  render(
    () => (
      <PaneStage
        workspace={ws()}
        sessions={[]}
        renderFocusedTranscript={() => <div />}
        renderTranscript={(sessionId, paneId) => {
          const key = `${sessionId}@${paneId}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return <div data-transcript={key} />;
        }}
        onFocusPane={() => {}}
        onSelectPaneSession={() => {}}
        onSplitPane={() => {}}
        onClosePane={() => {}}
        onToggleZoom={() => {}}
        onResizeSplit={() => {}}
      />
    ),
    host,
  );

  const mounted = () => [...counts.entries()].sort();
  expect(mounted()).toEqual([
    ["s1@pane-1", 1],
    ["s2@pane-2", 1],
  ]);

  setWs(workspace("pane-2"));
  expect(mounted()).toEqual([
    ["s1@pane-1", 1],
    ["s2@pane-2", 1],
  ]);
  const classes = (id: string) => host.querySelector(`[data-pane-id="${id}"]`)?.classList;
  expect(classes("pane-2")?.contains("absolute")).toBe(true);
  expect(classes("pane-1")?.contains("hidden")).toBe(true);
  expect(host.querySelectorAll("[data-pane-id]")).toHaveLength(2);

  setWs(workspace(null));
  expect(mounted()).toEqual([
    ["s1@pane-1", 1],
    ["s2@pane-2", 1],
  ]);
  expect(classes("pane-2")?.contains("absolute")).toBe(false);
  expect(classes("pane-1")?.contains("hidden")).toBe(false);
});
