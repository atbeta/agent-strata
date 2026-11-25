import { describe, expect, test } from "bun:test";
import { aggregate, projectSession } from "@agent-strata/projector";
import { makeEvent, type Event, type EventInput } from "@agent-strata/schema";
import { openStore } from "@agent-strata/store";
import { listRow, mergeUsage } from "../src/session-list";

const mk = (session_id: string, backend: string, type: string, data: object): EventInput =>
  makeEvent({
    session_id,
    ts: new Date().toISOString(),
    source: { backend },
    type,
    data,
  } as EventInput);

const reply = (session_id: string, backend: string, turn: string, model: string, input: number, cost: number) => [
  mk(session_id, backend, "turn.user", { turn_id: turn, content: [] }),
  mk(session_id, backend, "turn.assistant", {
    turn_id: turn,
    content: [],
    model,
    usage: { input, output: Math.floor(input / 2) },
    cost_usd: cost,
  }),
];

describe("the session list's rows", () => {
  test("the overview's usage, put together row by row, is the usage of the whole page", () => {
    const store = openStore(":memory:");
    store.append([
      mk("a", "opencode", "session.started", { workspace: "/a" }),
      ...reply("a", "opencode", "a1", "m1", 100, 0.1),
      ...reply("a", "opencode", "a2", "m2", 40, 0.05),
      mk("b", "acp", "session.started", { workspace: "/b" }),
      ...reply("b", "acp", "b1", "m1", 10, 0.01),
      mk("c", "opencode", "session.started", { workspace: "/c" }),
    ]);
    const views = ["a", "b", "c"].map((id) => projectSession(store.read({ session_id: id }) as Event[]));
    expect(mergeUsage(views.map((view) => listRow(view).usage))).toEqual(aggregate(views));
    expect(mergeUsage([])).toEqual(aggregate([]));
    store.close();
  });

  test("a row carries what the sidebar reads, and nothing as heavy as the turns", () => {
    const store = openStore(":memory:");
    store.append([mk("a", "opencode", "session.started", { workspace: "/a" }), ...reply("a", "opencode", "a1", "m1", 1, 0)]);
    const row = listRow(projectSession(store.read({ session_id: "a" }) as Event[]));
    expect(row.workspace).toBe("/a");
    expect(row.questions).toEqual([]);
    expect(Object.keys(row)).not.toContain("turns");
    store.close();
  });
});
