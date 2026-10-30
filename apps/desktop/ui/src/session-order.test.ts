import { describe, expect, test } from "bun:test";
import {
  compareProjectRows,
  rememberBusySince,
  type SessionOrderRow,
} from "./session-order";

function row(id: string, lastTs: string, busy = false): SessionOrderRow {
  return { summary: { session_id: id, last_ts: lastTs }, busy };
}

function order(rows: readonly SessionOrderRow[], busySince: ReadonlyMap<string, string>): string[] {
  return [...rows]
    .sort((a, b) => compareProjectRows(a, b, busySince))
    .map((row) => row.summary.session_id);
}

describe("project session order", () => {
  test("keeps initially running A and B stable while their events advance", () => {
    const busySince = new Map<string, string>();
    const initial = [
      row("a", "2026-10-30T10:00:00.000Z", true),
      row("b", "2026-10-30T11:00:00.000Z", true),
    ];
    rememberBusySince(busySince, initial);
    expect(order(initial, busySince)).toEqual(["b", "a"]);

    const next = [
      row("a", "2026-10-30T13:00:00.000Z", true),
      row("b", "2026-10-30T12:00:00.000Z", true),
    ];
    rememberBusySince(busySince, next);
    expect(order(next, busySince)).toEqual(["b", "a"]);
    expect([...busySince]).toEqual([
      ["a", "2026-10-30T10:00:00.000Z"],
      ["b", "2026-10-30T11:00:00.000Z"],
    ]);
  });

  test("moves newly running C up once, then keeps it stable", () => {
    const busySince = new Map<string, string>();
    const initial = [
      row("a", "2026-10-30T10:00:00.000Z", true),
      row("b", "2026-10-30T11:00:00.000Z", true),
      row("c", "2026-10-30T12:00:00.000Z"),
    ];
    rememberBusySince(busySince, initial);
    expect(order(initial, busySince)).toEqual(["b", "a", "c"]);

    const started = [
      row("a", "2026-10-30T10:30:00.000Z", true),
      row("b", "2026-10-30T11:30:00.000Z", true),
      row("c", "2026-10-30T12:30:00.000Z", true),
    ];
    rememberBusySince(busySince, started);
    expect(order(started, busySince)).toEqual(["c", "b", "a"]);

    const next = [
      row("a", "2026-10-30T15:00:00.000Z", true),
      row("b", "2026-10-30T14:00:00.000Z", true),
      row("c", "2026-10-30T13:00:00.000Z", true),
    ];
    rememberBusySince(busySince, next);
    expect(order(next, busySince)).toEqual(["c", "b", "a"]);
  });

  test("clears an idle session and reorders it when it runs again", () => {
    const busySince = new Map<string, string>();
    const running = [
      row("a", "2026-10-30T12:00:00.000Z", true),
      row("b", "2026-10-30T11:00:00.000Z", true),
    ];
    rememberBusySince(busySince, running);
    expect(order(running, busySince)).toEqual(["a", "b"]);

    const idle = [row("a", "2026-10-30T13:00:00.000Z"), running[1]!];
    rememberBusySince(busySince, idle);
    expect(busySince.has("a")).toBe(false);
    expect(order(idle, busySince)).toEqual(["b", "a"]);

    const restarted = [
      row("a", "2026-10-30T10:00:00.000Z", true),
      row("b", "2026-10-30T14:00:00.000Z", true),
    ];
    rememberBusySince(busySince, restarted);
    expect(order(restarted, busySince)).toEqual(["b", "a"]);
    expect(busySince.get("a")).toBe("2026-10-30T10:00:00.000Z");
  });

  test("uses session id as the deterministic tie-breaker", () => {
    const busySince = new Map<string, string>();
    const running = [
      row("b", "2026-10-30T12:00:00.000Z", true),
      row("a", "2026-10-30T12:00:00.000Z", true),
    ];
    rememberBusySince(busySince, running);
    expect(order(running, busySince)).toEqual(["a", "b"]);

    const idle = [row("b", "2026-10-30T12:00:00.000Z"), row("a", "2026-10-30T12:00:00.000Z")];
    expect(order(idle, busySince)).toEqual(["a", "b"]);
  });
});
