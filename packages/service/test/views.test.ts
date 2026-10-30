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
