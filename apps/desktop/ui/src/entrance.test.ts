import { describe, expect, test } from "bun:test";
import { createEntranceLedger } from "./entrance";

/**
 * The entrance has to mean "this arrived while you were already here", and every
 * one of these is a way the transcript did something that is not arriving.
 */
describe("which turns may play the entrance", () => {
  test("a conversation the reader walked in on paints still", () => {
    const l = createEntranceLedger();
    // Opening a session builds the whole column in one pass.
    expect(l.arriving("a", ["t1", "t2", "t3"]).size).toBe(0);
  });

  test("switching to another conversation animates nothing", () => {
    const l = createEntranceLedger();
    l.arriving("a", ["t1", "t2"]);
    // The reader changes conversation. Everything on screen is a different
    // column, built in one pass — a page, not news.
    expect(l.arriving("b", ["x1", "x2", "x3"]).size).toBe(0);
    // And going back does not replay the first one either.
    expect(l.arriving("a", ["t1", "t2"]).size).toBe(0);
  });

  test("a turn that arrives while the reader is here does move in", () => {
    const l = createEntranceLedger();
    l.arriving("a", ["t1", "t2"]);
    const arriving = l.arriving("a", ["t1", "t2", "t3"]);
    expect([...arriving]).toEqual(["t3"]);
  });

  test("it keeps its answer while the turn streams in", () => {
    const l = createEntranceLedger();
    l.arriving("a", ["t1"]);
    const first = l.arriving("a", ["t1", "t2"]);
    // A reply streams far faster than a 160ms entrance lasts. A ledger that
    // answered "what is new since last paint" would revoke the class on the
    // next chunk and the reader would see a twitch, not a turn arriving.
    expect(l.arriving("a", ["t1", "t2"]).has("t2")).toBe(true);
    expect(first.has("t2")).toBe(true);
  });

  test("scrolling a long conversation back into view animates nothing", () => {
    const l = createEntranceLedger();
    l.arriving("a", ["t1", "t2", "t3", "t4", "t5"]);
    expect([...l.arriving("a", ["t1", "t2", "t3", "t4", "t5", "t6"])]).toEqual(["t6"]);
    // The window unmounts the top of the column and mounts it again on the way
    // back up. Those are new elements, and they are not new turns: the only
    // turn allowed to move in is still the one that really did arrive.
    expect([...l.arriving("a", ["t1", "t2", "t3"])]).toEqual(["t6"]);
  });

  test("a session that is still loading does not announce its history", () => {
    const l = createEntranceLedger();
    // Not yet loaded: nothing on screen.
    expect(l.arriving("a", []).size).toBe(0);
    // Now it is. This is the reader arriving, not twenty turns arriving.
    expect(l.arriving("a", ["t1", "t2", "t3"]).size).toBe(0);
  });

  test("a switch that lands on an empty column is still a switch", () => {
    const l = createEntranceLedger();
    l.arriving("a", ["t1", "t2"]);
    l.arriving("b", []);
    expect(l.arriving("b", ["x1"]).size).toBe(0);
  });

  test("the answer is the same set while nothing new arrives", () => {
    // Identity matters: the turn reads it as the rows are built, and a fresh
    // set each paint would churn every mounted turn for no reason.
    const l = createEntranceLedger();
    l.arriving("a", ["t1"]);
    const once = l.arriving("a", ["t1", "t2"]);
    expect(l.arriving("a", ["t1", "t2"])).toBe(once);
  });

  test("it cannot tell a stale column from a new one", () => {
    // Kept as a warning about the caller, not a rule the ledger can enforce:
    // handed the outgoing column under the incoming session, it takes that as
    // the baseline and calls the whole real column newly arrived. This is why
    // the session key has to travel *with* the column, and why the transcripts
    // key on the view's own `session_id` rather than on `props.id`, which
    // changes a beat before the data does.
    const l = createEntranceLedger();
    l.arriving("a", ["a1"]);
    l.arriving("b", ["a1"]);
    expect([...l.arriving("b", ["b1"])]).toEqual(["b1"]);
  });
});
