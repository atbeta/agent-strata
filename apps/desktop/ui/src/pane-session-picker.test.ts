import { describe, expect, test } from "bun:test";
import {
  isGeneratedTitle,
  pickPaneSessions,
  pickerTruncated,
} from "./pane-session-picker";
import type { SessionRowSummary } from "./pane-stage";

const s = (id: string, title: string | null, workspace: string | null = null) =>
  ({
    summary: { session_id: id, title, workspace },
    title,
    workspace,
    status: "idle",
  }) as SessionRowSummary;

const UNNAMED = "未命名";
const UNTITLED = "Untitled";

/**
 * The pane session switcher used to be `props.sessions.slice(0, 30)`.
 *
 * The cap was a performance guard and it did its job — the node count is the
 * same for thirty sessions or three thousand. But it cut the list with nothing
 * on screen saying it had, so a picker holding three thousand sessions showed
 * you thirty and let you believe that was all of them.
 */
describe("a pane session picker that admits what it is showing", () => {
  test("the cap holds however large the library gets", () => {
    // The reason the cap exists at all. Three thousand rows in a dropdown is
    // the thing that would actually hang the menu.
    const many = Array.from({ length: 3000 }, (_, i) => s(`s${i}`, `session ${i}`));
    expect(pickPaneSessions(many, "", 30, UNNAMED)).toHaveLength(30);
    // And it holds under a query that matches everything, which is the case
    // that would reintroduce the cost if the filter ran after the cut.
    expect(pickPaneSessions(many, "session", 30, UNNAMED)).toHaveLength(30);
  });

  test("the cut happens after the filter, not before it", () => {
    // The bug a search would otherwise inherit: cut first, then filter the
    // thirty that survived. The session you typed for sits at position forty
    // and never appears however well you spell it.
    const sessions = [
      ...Array.from({ length: 40 }, (_, i) => s(`noise${i}`, `noise ${i}`)),
      s("target", "the one you want"),
    ];
    expect(pickPaneSessions(sessions, "the one", 30, UNNAMED).map((r) => r.summary.session_id))
      .toEqual(["target"]);
  });

  test("it says so when the cap is hiding something", () => {
    const sessions = Array.from({ length: 31 }, (_, i) => s(`s${i}`, `session ${i}`));
    expect(pickerTruncated(sessions, "", 30, UNNAMED)).toBe(true);
    expect(pickerTruncated(sessions.slice(0, 30), "", 30, UNNAMED)).toBe(false);
    // A search that narrowed it back under the cap is no longer hiding
    // anything, and must not claim that it is.
    expect(pickerTruncated(sessions, "session 7", 30, UNNAMED)).toBe(false);
  });

  test("the backend's own name for an unnamed session is recognised", () => {
    // A column of these is indistinguishable at a glance and fills the front of
    // the list. The pattern is narrow on purpose: only the exact shape the
    // backend generates, never a title a person happened to write.
    expect(isGeneratedTitle("New session - 2026-10-14T14:48:58.578Z")).toBe(true);
    expect(isGeneratedTitle("new session - 2026-10-14T14:48:58.578Z")).toBe(true);
    expect(isGeneratedTitle("New session - 2026-10-14")).toBe(false);
    expect(isGeneratedTitle("New session notes")).toBe(false);
    expect(isGeneratedTitle("修复分屏切换")).toBe(false);
  });

  test("generated names go to the back, real ones keep their order", () => {
    // They are real sessions and stay selectable — they are often the ones you
    // just made and have not typed into yet. They just stop occupying the front
    // of a list you are trying to scan for the one you recognise.
    //
    // The title is written to both fields here because that is what the backend
    // does, and the first version of the ordering keyed off a *missing* title
    // instead — which meant it never fired on a single real row.
    const sessions = [
      s("g1", "New session - 2026-10-14T14:48:58.578Z"),
      s("real1", "修复分屏切换"),
      s("g2", "New session - 2026-10-14T14:01:44.676Z"),
      s("real2", "终端 shell 选择"),
      s("real3", "图标来源"),
    ];
    expect(pickPaneSessions(sessions, "", 30, UNNAMED).map((r) => r.summary.session_id))
      .toEqual(["real1", "real2", "real3", "g1", "g2"]);
  });

  test("a generated name still matches a search for what it says", () => {
    // Sorting them back must not make them unfindable — the cap only helps if
    // everything remains reachable.
    const sessions = [
      ...Array.from({ length: 5 }, (_, i) => s(`g${i}`, `New session - 2026-10-1${i}T10:00:00.000Z`)),
      s("g9", "New session - 2026-10-19T22:00:00.000Z"),
    ];
    expect(pickPaneSessions(sessions, "2026-10-19", 30, UNNAMED).map((r) => r.summary.session_id))
      .toEqual(["g9"]);
  });

  test("search matches the two fields the global search matches", () => {
    // Title and workspace. A session you can only find by remembering which
    // project it was in is not findable here.
    const sessions = [s("a", "缓存失效排查", "D:\\Code\\agent-strata"), s("b", "别的事", "D:\\other")];
    expect(pickPaneSessions(sessions, "agent-strata", 30, UNNAMED).map((r) => r.summary.session_id))
      .toEqual(["a"]);
    expect(pickPaneSessions(sessions, "缓存", 30, UNNAMED).map((r) => r.summary.session_id))
      .toEqual(["a"]);
    expect(pickPaneSessions(sessions, "NOMATCH", 30, UNNAMED)).toEqual([]);
  });

  test("a session with no title at all is not mistaken for a generated one", () => {
    // No title and no generated name — a genuinely blank row. It has no name to
    // match the backend's pattern, so it belongs with the named rows rather
    // than at the back with the auto-named ones.
    const sessions = [s("blank", null), s("g", "New session - 2026-10-14T14:48:58.578Z")];
    expect(pickPaneSessions(sessions, "", 30, UNTITLED).map((r) => r.summary.session_id))
      .toEqual(["blank", "g"]);
  });
});
