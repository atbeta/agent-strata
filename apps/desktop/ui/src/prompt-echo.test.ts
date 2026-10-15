import { describe, expect, test } from "bun:test";
import type { Turn } from "./api";
import { ECHO_TURN_ID, withEcho } from "./prompt-echo";

/**
 * The reader's own sentence used to appear only after POST, the agent SDK, its
 * event stream, SSE back, and a second request for the tail — against an empty
 * column, which reads as a hang. `withEcho` puts it on screen at Enter. These
 * tests hold the one rule that makes that safe: the echo never survives the
 * real turn, so the same sentence is never on screen twice.
 */

const turn = (id: string): Turn => ({
  turn_id: id,
  user: [{ type: "text", text: `sent ${id}` }],
  assistant: [],
  tool_calls: [],
});

describe("prompt echo", () => {
  test("nothing in flight means nothing added", () => {
    expect(withEcho([turn("a")], undefined)).toHaveLength(1);
  });

  test("the echoed turn reads back exactly what the composer held", () => {
    const out = withEcho([], { base: 0, text: "改一下这个函数" });
    expect(out).toHaveLength(1);
    expect(out[0]!.user).toEqual([{ type: "text", text: "改一下这个函数" }]);
    expect(out[0]!.assistant).toEqual([]);
    expect(out[0]!.tool_calls).toEqual([]);
  });

  test("it goes on the end, after the turns that were already there", () => {
    const out = withEcho([turn("a"), turn("b")], { base: 2, text: "next" });
    expect(out.map((t) => t.turn_id)).toEqual(["a", "b", ECHO_TURN_ID]);
  });

  test("it is gone the moment the real turn lands", () => {
    // The rule that stops the sentence appearing twice: the baseline was 2, so
    // a third real turn means the backend's own copy is already in hand.
    const out = withEcho([turn("a"), turn("b"), turn("c")], { base: 2, text: "next" });
    expect(out.map((t) => t.turn_id)).toEqual(["a", "b", "c"]);
    expect(out.some((t) => t.turn_id === ECHO_TURN_ID)).toBe(false);
  });

  test("an attachment-only send still gets a turn to be replaced by", () => {
    // No prose, but the backend makes a turn regardless. Without the echo there
    // would be nothing on screen until it did.
    const out = withEcho([], { base: 0, text: "" });
    expect(out).toHaveLength(1);
    expect(out[0]!.user).toBeUndefined();
  });

  test("a real turn is never filtered out to make room for the echo", () => {
    // The turn count decides whether the echo draws, never its id. Filtering
    // by id would let one stored turn mistaken for the echo be dropped from a
    // transcript — a far worse failure than a duplicate id in a state the
    // backends here cannot reach, since every one of them mints a ULID.
    const stored = [turn("a"), turn(ECHO_TURN_ID)];
    expect(withEcho(stored, { base: 2, text: "next" }).map((t) => t.turn_id)).toEqual([
      "a",
      ECHO_TURN_ID,
      ECHO_TURN_ID,
    ]);
    expect(withEcho(stored, { base: 1, text: "next" }).map((t) => t.turn_id)).toEqual([
      "a",
      ECHO_TURN_ID,
    ]);
  });

  test("the input array is never mutated", () => {
    // The list is the Virtual scroller's array; appending to it in place would
    // hide a row from `<For>`'s own diffing.
    const real = [turn("a")];
    withEcho(real, { base: 1, text: "next" });
    expect(real).toHaveLength(1);
  });
});
