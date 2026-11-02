import { describe, expect, test } from "bun:test";
import type { ToolCallView, Turn } from "./api";
import { attributionOf } from "./turn-attribution";

const call = (id: string, msgId?: string): ToolCallView =>
  ({ call_id: id, tool: "bash", input: {}, status: "ok", msg_id: msgId } as unknown as ToolCallView);

const turn = (assistant: { msg_id?: string }[], tool_calls: ToolCallView[]): Turn =>
  ({ turn_id: "t1", assistant, tool_calls } as unknown as Turn);

describe("which call belongs to which message", () => {
  test("a call is placed under the message that made it", () => {
    const t = turn(
      [{ msg_id: "m0" }, { msg_id: "m1" }],
      [call("c0", "m0"), call("c1", "m1"), call("c2", "m1")],
    );
    const { byMessage, loose } = attributionOf(t);
    expect(byMessage.get(0)!.map((c) => c.call_id)).toEqual(["c0"]);
    expect(byMessage.get(1)!.map((c) => c.call_id)).toEqual(["c1", "c2"]);
    expect(loose).toEqual([]);
  });

  test("a call the backend never attributed stays loose", () => {
    const t = turn([{ msg_id: "m0" }], [call("c0", "m0"), call("c9")]);
    const { byMessage, loose } = attributionOf(t);
    expect(byMessage.get(0)!.map((c) => c.call_id)).toEqual(["c0"]);
    expect(loose.map((c) => c.call_id)).toEqual(["c9"]);
  });

  test("a call naming a message the turn does not have is loose", () => {
    const t = turn([{ msg_id: "m0" }], [call("c0", "gone")]);
    expect(attributionOf(t).loose.map((c) => c.call_id)).toEqual(["c0"]);
  });

  test("the segments of one turn share one attribution", () => {
    // A turn mounted in segments asks for the attribution once per segment.
    // The turn has two hundred messages and seventeen segments, so walking
    // the whole turn per segment was seventeen times the work for one slice.
    const assistant = Array.from({ length: 200 }, (_, i) => ({ msg_id: `m${i}` }));
    const calls = assistant.map((_, i) => call(`c${i}`, `m${i}`));
    const t = turn(assistant, calls);
    const first = attributionOf(t);
    expect(attributionOf(t)).toBe(first);
    expect(first.byMessage.size).toBe(200);
  });

  test("a turn that changed is attributed again", () => {
    const a = turn([{ msg_id: "m0" }], [call("c0", "m0")]);
    const b = { ...a, tool_calls: [call("c0", "m0"), call("c1", "m0")] } as unknown as Turn;
    expect(attributionOf(a).byMessage.get(0)!.length).toBe(1);
    expect(attributionOf(b).byMessage.get(0)!.length).toBe(2);
  });
});
