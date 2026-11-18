import { describe, expect, test } from "bun:test";
import {
  createFreshSessions,
  FRESH_SESSIONS_KEY,
  freshVerdict,
  markFresh,
  readFresh,
} from "./fresh-session";
import type { SessionRow } from "./api";

const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  summary: {
    session_id: id,
    backend: "opencode",
    workspace: "/repo",
    title: "New session - 2026-01-01T00:00:00Z",
    started_at: "2026-01-01T00:00:00Z",
    last_ts: "2026-01-01T00:00:00Z",
    last_seq: 1,
  },
  status: "idle",
  totals: { input: 0, output: 0, cost_usd: 0, tool_calls: 0, cache_read: 0, cache_write: 0 },
  ...extra,
});

const memStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
};

type Deps = Parameters<typeof createFreshSessions>[0];

const setup = (over: Partial<Deps> = {}, rows: SessionRow[] = []) => {
  const storage = memStorage();
  const fetches: { path: string; init?: RequestInit }[] = [];
  const fetcher =
    over.fetcher ??
    (async (path: string, init?: RequestInit) => {
      fetches.push({ path, init });
      return Response.json({ ok: true });
    });
  const fs = createFreshSessions({
    rows: () => rows,
    onScreen: () => false,
    storage,
    draft: () => "",
    queued: () => [],
    pins: () => [],
    ...over,
    fetcher,
  });
  return { fs, storage, fetches };
};

describe("fresh session marks", () => {
  test("mark and unmark round-trip through storage", () => {
    const storage = memStorage();
    markFresh("a", { dir: "/repo" }, storage);
    markFresh("b", { dir: "/repo/wt", worktreeOf: "/repo" }, storage);
    expect(Object.keys(readFresh(storage)).sort()).toEqual(["a", "b"]);
    expect(readFresh(storage).b).toEqual({ dir: "/repo/wt", worktreeOf: "/repo" });
    const fs = setup({ storage }).fs;
    fs.unmark("a");
    expect(Object.keys(readFresh(storage))).toEqual(["b"]);
    fs.unmark("b");
    expect(storage.map.has(FRESH_SESSIONS_KEY)).toBe(false);
  });

  test("corrupt or foreign content reads as no marks", () => {
    const storage = memStorage();
    storage.map.set(FRESH_SESSIONS_KEY, "not json");
    expect(readFresh(storage)).toEqual({});
    storage.map.set(FRESH_SESSIONS_KEY, JSON.stringify({ a: "nope", b: { dir: "/x" } }));
    expect(readFresh(storage)).toEqual({ b: { dir: "/x" } });
  });
});

describe("freshVerdict", () => {
  const base = { pinned: false, titled: false, draft: "", queued: 0, onScreen: false };
  test("free when nothing holds it", () => {
    expect(freshVerdict(base)).toBe("free");
  });
  test("keep on a pin, a typed title, or an archive", () => {
    expect(freshVerdict({ ...base, pinned: true })).toBe("keep");
    expect(freshVerdict({ ...base, titled: true })).toBe("keep");
    expect(freshVerdict({ ...base, archived: true })).toBe("keep");
  });
  test("wait on a draft, a queue, a run, or the session still showing", () => {
    expect(freshVerdict({ ...base, draft: " half a thought" })).toBe("wait");
    expect(freshVerdict({ ...base, queued: 2 })).toBe("wait");
    expect(freshVerdict({ ...base, busy: true })).toBe("wait");
    expect(freshVerdict({ ...base, onScreen: true })).toBe("wait");
  });
});

describe("prune", () => {
  test("an unmarked session is left alone", async () => {
    const { fs, fetches } = setup({}, [row("a")]);
    expect(await fs.prune("a")).toBe("kept");
    expect(fetches).toHaveLength(0);
  });

  test("unsent input keeps the session and the mark", async () => {
    const { fs, fetches, storage } = setup({ draft: () => "typed" }, [row("a")]);
    fs.mark("a", { dir: "/repo" });
    expect(await fs.prune("a")).toBe("waiting");
    expect(fetches).toHaveLength(0);
    expect(readFresh(storage).a).toBeDefined();
  });

  test("a still-visible session waits", async () => {
    const { fs, fetches } = setup({ onScreen: (id) => id === "a" }, [row("a")]);
    fs.mark("a", {});
    expect(await fs.prune("a")).toBe("waiting");
    expect(fetches).toHaveLength(0);
  });

  test("a pinned or renamed session is kept and the watch ends", async () => {
    const pinned = setup({ pins: () => ["a"] }, [row("a")]);
    pinned.fs.mark("a", {});
    expect(await pinned.fs.prune("a")).toBe("kept");
    expect(readFresh(pinned.storage).a).toBeUndefined();
    expect(pinned.fetches).toHaveLength(0);

    const titled = setup({}, [row("a", { title: "named by hand" })]);
    titled.fs.mark("a", {});
    expect(await titled.fs.prune("a")).toBe("kept");
    expect(readFresh(titled.storage).a).toBeUndefined();
  });

  test("a generated title does not count as a typed one", async () => {
    const { fs, fetches } = setup({}, [row("a")]);
    fs.mark("a", {});
    expect(await fs.prune("a")).toBe("deleted");
    expect(fetches[0]?.path).toBe(`/sessions/${encodeURIComponent("a")}?if_empty=1`);
    expect(fetches[0]?.init?.method).toBe("DELETE");
  });

  test("a pristine session is deleted through the service and unmarked", async () => {
    const { fs, storage } = setup({}, [row("a")]);
    fs.mark("a", {});
    expect(await fs.prune("a")).toBe("deleted");
    expect(readFresh(storage).a).toBeUndefined();
  });

  test("the worktree checkout goes back with the session", async () => {
    const removed: string[] = [];
    const remembered: string[] = [];
    const { fs } = setup(
      {
        removeWorktree: async (dir) => void removed.push(dir),
        lastDir: () => "/repo/wt",
        rememberDir: (dir) => void remembered.push(dir),
      },
      [row("a")],
    );
    fs.mark("a", { dir: "/repo/wt", worktreeOf: "/repo" });
    expect(await fs.prune("a")).toBe("deleted");
    expect(removed).toEqual(["/repo/wt"]);
    expect(remembered).toEqual(["/repo"]);
  });

  test("the aim is not repaired when it moved elsewhere", async () => {
    const remembered: string[] = [];
    const { fs } = setup(
      {
        removeWorktree: async () => "ok",
        lastDir: () => "/other",
        rememberDir: (dir) => void remembered.push(dir),
      },
      [row("a")],
    );
    fs.mark("a", { dir: "/repo/wt", worktreeOf: "/repo" });
    await fs.prune("a");
    expect(remembered).toEqual([]);
  });

  test("a not-empty answer keeps the session and ends the watch", async () => {
    const { fs, storage } = setup(
      { fetcher: async () => Response.json({ not_empty: true }, { status: 409 }) },
      [row("a")],
    );
    fs.mark("a", {});
    expect(await fs.prune("a")).toBe("kept");
    expect(readFresh(storage).a).toBeUndefined();
  });

  test("a backend that cannot delete keeps the mark for a later try", async () => {
    const { fs, storage } = setup(
      { fetcher: async () => Response.json({ local_only: true }, { status: 409 }) },
      [row("a")],
    );
    fs.mark("a", {});
    expect(await fs.prune("a")).toBe("waiting");
    expect(readFresh(storage).a?.tries).toBe(1);
  });

  test("a missing row still goes through the conditional delete", async () => {
    const { fs, fetches, storage } = setup({}, []);
    fs.mark("a", {});
    expect(await fs.prune("a")).toBe("deleted");
    expect(fetches).toHaveLength(1);
    expect(readFresh(storage).a).toBeUndefined();
  });

  test("a failing delete counts a try; enough misses give the watch up", async () => {
    const { fs, storage } = setup({ fetcher: async () => Response.json({}, { status: 502 }) }, [row("a")]);
    fs.mark("a", {});
    for (let i = 1; i <= 4; i++) {
      expect(await fs.prune("a")).toBe("waiting");
      expect(readFresh(storage).a?.tries).toBe(i);
    }
    expect(await fs.prune("a")).toBe("waiting");
    expect(readFresh(storage).a).toBeUndefined();
  });

  test("two asks in flight share one delete and one worktree return", async () => {
    let calls = 0;
    const removed: string[] = [];
    let release!: (res: Response) => void;
    const { fs } = setup(
      {
        fetcher: () => {
          calls++;
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        },
        removeWorktree: async (dir) => void removed.push(dir),
      },
      [row("a")],
    );
    fs.mark("a", { dir: "/repo/wt", worktreeOf: "/repo" });
    const first = fs.prune("a");
    const second = fs.prune("a");
    release(Response.json({ ok: true }));
    expect(await first).toBe("deleted");
    expect(await second).toBe("deleted");
    expect(calls).toBe(1);
    expect(removed).toEqual(["/repo/wt"]);
  });

  test("an archived session is kept without asking the service", async () => {
    const { fs, fetches, storage } = setup({ archived: (id) => id === "a" }, [row("a")]);
    fs.mark("a", {});
    expect(await fs.prune("a")).toBe("kept");
    expect(fetches).toHaveLength(0);
    expect(readFresh(storage).a).toBeUndefined();
  });
});
