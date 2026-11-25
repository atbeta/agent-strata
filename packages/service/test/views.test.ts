import { describe, expect, test } from "bun:test";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { openStore } from "@agent-strata/store";
import { ViewCache } from "../src/views";

const mk = (session_id: string, type: string, data: object): EventInput =>
  makeEvent({
    session_id,
    ts: new Date().toISOString(),
    source: { backend: "test" },
    type,
    data,
  } as EventInput);

describe("view body cache", () => {
  test("the serialized settled view is reused until the session moves", () => {
    const store = openStore(":memory:");
    store.append([
      mk("a", "session.started", { workspace: "/a" }),
      mk("a", "turn.user", { turn_id: "t1", content: [] }),
    ]);
    const cache = new ViewCache(store);
    const held = cache.view("a");
    const first = cache.viewBody("a");
    held.title = "mutated";
    // A second read returns the bytes from before the mutation. Serializing
    // again would have picked the title up.
    expect(JSON.parse(cache.viewBody("a")).title).toBeUndefined();
    expect(JSON.parse(first).turns).toHaveLength(1);

    store.append([mk("a", "turn.user", { turn_id: "t2", content: [] })]);
    const next = cache.viewBody("a");
    expect(JSON.parse(next).turns).toHaveLength(2);
    expect(JSON.parse(next).title).toBeUndefined();

    cache.drop("a");
    cache.view("a").title = "rebuilt";
    expect(JSON.parse(cache.viewBody("a")).title).toBe("rebuilt");
    store.close();
  });

  test("a cold read loads every page", () => {
    const store = openStore(":memory:");
    store.append(Array.from({ length: 20_001 }, (_, i) =>
      mk("a", "turn.user", { turn_id: `t${i}`, content: [] }),
    ));
    const cache = new ViewCache(store);

    expect(cache.events("a")).toHaveLength(20_001);
    expect(JSON.parse(cache.viewBody("a")).turns).toHaveLength(20_001);
    store.close();
  });

  test("a peek reads a session without pushing a cached one out", () => {
    const store = openStore(":memory:");
    for (const id of ["a", "b", "c"]) store.append([mk(id, "turn.user", { turn_id: `${id}1`, content: [] })]);
    let reads = 0;
    const counted = { ...store, read: (opts: Parameters<typeof store.read>[0]) => (reads++, store.read(opts)) };
    const cache = new ViewCache(counted, 2);
    cache.view("a");
    cache.view("b");

    expect(cache.peek("c").turns).toHaveLength(1);
    reads = 0;
    cache.view("a");
    cache.view("b");
    expect(reads).toBe(0);

    store.append([mk("a", "turn.user", { turn_id: "a2", content: [] })]);
    expect(cache.peek("a").turns).toHaveLength(2);
    store.close();
  });

  test("a summary outlives the view cache and is recomputed once its session moves", () => {
    const store = openStore(":memory:");
    for (const id of ["a", "b", "c"]) store.append([mk(id, "turn.user", { turn_id: `${id}1`, content: [] })]);
    const cache = new ViewCache(store, 1);
    let derived = 0;
    const turns = (id: string) =>
      cache.summary(id, "turns", (view) => {
        derived++;
        return view.turns.length;
      });

    for (const id of ["a", "b", "c"]) turns(id);
    for (const id of ["a", "b", "c"]) turns(id);
    expect(derived).toBe(3);

    store.append([mk("a", "turn.user", { turn_id: "a2", content: [] })]);
    expect(turns("a")).toBe(2);
    expect(derived).toBe(4);
    expect(cache.summary("a", "other", () => "fresh")).toBe("fresh");

    cache.drop("b");
    turns("b");
    expect(derived).toBe(5);
    store.close();
  });

  test("summaries under different keys keep each other", () => {
    const store = openStore(":memory:");
    for (const id of ["a", "b"]) store.append([mk(id, "turn.user", { turn_id: `${id}1`, content: [] })]);
    let reads = 0;
    const counted = { ...store, read: (opts: Parameters<typeof store.read>[0]) => (reads++, store.read(opts)) };
    const cache = new ViewCache(counted, 1);
    const pass = () => {
      for (const id of ["a", "b"]) {
        cache.summary(id, "list-row", (view) => view.turns.length);
        cache.summary(id, "usage:UTC", (view) => view.totals.cost_usd);
      }
    };
    pass();
    reads = 0;
    // The usage pass and the list pass take turns over the same sessions.
    pass();
    pass();
    expect(reads).toBe(0);
    store.close();
  });

  test("a page of sessions larger than the view cache is read once, not on every request", () => {
    const store = openStore(":memory:");
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    for (const id of ids) store.append([mk(id, "turn.user", { turn_id: `${id}t`, content: [] })]);
    let reads = 0;
    const counted = { ...store, read: (opts: Parameters<typeof store.read>[0]) => (reads++, store.read(opts)) };
    const cache = new ViewCache(counted, 4);
    cache.view("s0");
    for (const id of ids) cache.summary(id, "list-row", (view) => view.turns.length);
    reads = 0;
    for (const id of ids) cache.summary(id, "list-row", (view) => view.turns.length);
    expect(reads).toBe(0);
    // And the transcript the reader had open is still held.
    cache.view("s0");
    expect(reads).toBe(0);
    store.close();
  });

  test("a bulk append invalidates the cached view and reads every page", () => {
    const store = openStore(":memory:");
    store.append([mk("a", "turn.user", { turn_id: "t0", content: [] })]);
    const cache = new ViewCache(store);
    expect(JSON.parse(cache.viewBody("a")).turns).toHaveLength(1);

    store.append(Array.from({ length: 20_001 }, (_, i) =>
      mk("a", "turn.user", { turn_id: `t${i + 1}`, content: [] }),
    ));

    expect(cache.events("a")).toHaveLength(20_002);
    expect(JSON.parse(cache.viewBody("a")).turns).toHaveLength(20_002);
    store.close();
  });
});
