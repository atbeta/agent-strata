import { describe, expect, test } from "bun:test";
import {
  rebuildEvents,
  OPENCODE_REBUILT_TYPES,
  OPENCODE_MAPPER_VERSION,
} from "../src/index";
import { openStore } from "@agent-strata/store";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { sid, snapshotFixture } from "./helpers";

describe("rebuild from OpenCode's own record", () => {
  test("a rebuild maps only rebuildable, durable events", () => {
    const evs = rebuildEvents(snapshotFixture(), "/repo");
    expect(evs.every((e) => OPENCODE_REBUILT_TYPES.includes(e.type))).toBe(true);
    expect(evs.some((e) => e.type === "turn.assistant" && (e.data as { partial?: boolean }).partial)).toBe(false);
    expect(evs.map((e): string => e.type).sort()).toEqual(
      ["session.started", "tool.call", "tool.result", "turn.assistant", "turn.user"].sort(),
    );
  });

  test("a rebuild replaces the transcript and keeps what only the live stream saw", () => {
    const store = openStore(":memory:");
    const casfId = `opencode:${sid}`;
    store.append([
      makeEvent({
        id: "opencode:pt3:tool.call",
        session_id: casfId,
        source: { backend: "opencode" },
        type: "tool.call",
        data: { turn_id: "a1", call_id: "call1", tool: "bash", input: {} },
      } as EventInput),
      makeEvent({
        id: "opencode:perm1:permission.requested",
        session_id: casfId,
        source: { backend: "opencode" },
        type: "permission.requested",
        data: { request_id: "perm1", call_id: "call1", tool: "bash", input: {} },
      } as EventInput),
    ]);
    store.replaceSession(casfId, rebuildEvents(snapshotFixture(), "/repo"), {
      replaceTypes: OPENCODE_REBUILT_TYPES,
      mapper: OPENCODE_MAPPER_VERSION,
    });
    const evs = store.read({ session_id: casfId });
    expect(evs.filter((e) => e.type === "tool.call")).toHaveLength(1);
    expect(evs.find((e) => e.type === "tool.call")!.data).toMatchObject({ input: { command: "ls" } });
    expect(evs.some((e) => e.type === "permission.requested")).toBe(true);
    expect(store.sessionMapper(casfId)).toBe(OPENCODE_MAPPER_VERSION);
    store.close();
  });

  test("a stored session puts its calls in the user's turn", () => {
    const evs = rebuildEvents(snapshotFixture(), "/repo");
    expect(evs.map((e) => e.type)).toEqual([
      "session.started",
      "turn.user",
      "tool.call",
      "tool.result",
      "turn.assistant",
    ]);
    expect(evs.find((e) => e.type === "tool.call")!.data).toMatchObject({ turn_id: "u1", msg_id: "a1" });
  });
});
