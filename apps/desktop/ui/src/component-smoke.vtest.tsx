import { beforeAll, expect, test } from "vitest";
import { render } from "solid-js/web";
import { emptySessionView, type FileChangeView } from "@agent-strata/projector";
import { PlanStrip } from "./plan-strip";
import { writePlanChoice } from "./plan-progress";
import { SessionRail } from "./session-rail";
import type { DevProcesses } from "./dev-processes";

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
  vcs: () => undefined,
});

test("SessionRail mounts the session pane for a non-OpenCode backend", () => {
  const view = emptySessionView("acp:s1", "acp");
  view.files_changed.push(edit);
  const host = document.createElement("div");
  render(() => <SessionRail {...railProps(view, false)} />, host);
  expect(host.textContent).toContain("alpha.ts");
});

test("SessionRail mounts for an OpenCode session on the default source", () => {
  const view = emptySessionView("opencode:s2", "opencode");
  view.files_changed.push(edit);
  const host = document.createElement("div");
  render(() => <SessionRail {...railProps(view, true)} />, host);
  // Default source is "session": the file record renders, not a git fetch.
  expect(host.textContent).toContain("alpha.ts");
});
