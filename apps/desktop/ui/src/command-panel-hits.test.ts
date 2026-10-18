import { describe, expect, test } from "bun:test";
import {
  actionable,
  actionableIndexAt,
  buildPanelHits,
  type PanelHit,
} from "./command-panel-hits";
import type { AppCommand } from "./commands";
import type { SessionRow, StrataEvent } from "./api";

const cmd = (id: string, title: string): AppCommand => ({
  id,
  title: () => title,
  run: () => {},
});

const commands = [
  cmd("app.newSession", "新建会话"),
  cmd("app.settings", "打开设置"),
  cmd("session.panel", "改动与文件"),
  cmd("pane.splitRight", "向右拆分窗格"),
];

const sessions = [
  {
    summary: { session_id: "s1", title: "查询开机时间", workspace: "D:\\Code\\lector" },
    title: "查询开机时间",
    workspace: "D:\\Code\\lector",
    status: "idle",
  },
  {
    summary: { session_id: "s2", title: "缓存失效排查", workspace: "C:\\Users\\Beta" },
    title: "缓存失效排查",
    workspace: "C:\\Users\\Beta",
    status: "idle",
  },
] as unknown as SessionRow[];

const events = [
  {
    id: "e1",
    session_id: "s1",
    backend: "opencode",
    seq: 1,
    type: "tool.call",
    ts: "2026-10-18T10:00:00.000Z",
    data: { content: [{ type: "text", text: "缓存没命中，重试" }] },
  },
] as unknown as StrataEvent[];

const build = (query: string, evs: StrataEvent[] | undefined = events) =>
  buildPanelHits({
    query,
    commands,
    sessions,
    events: evs,
    label: (g) => g,
    commandGroupLabel: (id) => id.split(".")[0] ?? "command",
  });

const kinds = (hits: PanelHit[]) => hits.map((h) => (h.kind === "heading" ? `#${h.key}` : h.kind));
const titles = (hits: PanelHit[]) =>
  hits.filter((h) => h.kind !== "heading").map((h) =>
    h.kind === "command" ? h.cmd.title() : h.kind === "session" ? h.title : h.type,
  );

/**
 * One panel for commands, sessions and transcript.
 *
 * They were two: `Ctrl K` searched sessions and transcript, `Ctrl Shift P`
 * listed commands. Both were a centred dialog with an input and a list, and
 * both could find a session — so one of the two was always the panel you did
 * not mean to open. They are one now, and the reader types a word without
 * having to know which kind it will land on.
 */
describe("the panel searches three things at once", () => {
  test("an empty query shows the commands and nothing else", () => {
    // A page of transcript hits for a search nobody typed is noise. Commands
    // are what the panel is for when it is opened rather than aimed.
    const hits = build("");
    expect(kinds(hits)).toEqual([
      "#app",
      "command",
      "command",
      "#session",
      "command",
      "#pane",
      "command",
    ]);
    expect(titles(hits)).toEqual(["新建会话", "打开设置", "改动与文件", "向右拆分窗格"]);
  });

  test("a query finds commands, sessions and transcript together", () => {
    // At that point the reader is looking for one of them, and the other two
    // cost nothing but two headings.
    const hits = build("缓存");
    expect(kinds(hits)).toContain("session");
    expect(kinds(hits)).toContain("event");
    expect(titles(hits)).toContain("缓存失效排查");
  });

  test("a session matches on its project as well as its title", () => {
    // The project is half of what identifies a session in a fleet, and it is
    // the half a title never carries.
    expect(titles(build("lector"))).toContain("查询开机时间");
  });

  test("a transcript hit carries the line it matched, not where to look for it", () => {
    const hit = build("缓存").find((h) => h.kind === "event") as Extract<PanelHit, { kind: "event" }>;
    expect(hit.when).toBe("2026-10-18 10:00");
    expect(hit.preview.match).toBe("缓存");
  });

  test("a group with nothing in it contributes no heading", () => {
    // Three headings over empty runs is worse than the flat list it replaced.
    // Transcript hits are passed already filtered, so this query gets none.
    const hits = buildPanelHits({
      query: "向右拆分",
      commands,
      sessions,
      events: [],
      label: (g) => g,
      commandGroupLabel: (id) => id.split(".")[0] ?? "command",
    });
    expect(kinds(hits)).toEqual(["#pane", "command"]);
  });
});

describe("the cursor never lands on a heading", () => {
  test("a heading you can select is a row that does nothing when you press Enter", () => {
    const hits = build("");
    expect(actionable(hits)).toHaveLength(hits.length - 3);
    expect(actionable(hits).every((h) => h.kind !== "heading")).toBe(true);
  });

  test("the highlight counts the rows the cursor counts", () => {
    // Two different indices would light a line one off the line Enter runs.
    const hits = build("");
    const rows = actionable(hits);
    const firstRowIndex = hits.findIndex((h) => h.kind !== "heading");
    expect(actionableIndexAt(hits, firstRowIndex)).toBe(0);
    // The second command sits after a heading, so its index is 1 and not 2.
    const second = hits.findIndex((h, i) => i > firstRowIndex && h.kind !== "heading");
    expect(actionableIndexAt(hits, second)).toBe(1);
    expect(rows).toHaveLength(4);
  });
});
