import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, MemoryStoreError } from "../src/store";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "strata-memory-store-"));
  const store = new MemoryStore({ dataDir: dir, maxEntries: 3, maxEntryChars: 40 });
  return { dir, store };
}

describe("memory store", () => {
  test("a written file is readable and survives a second read", () => {
    const { dir, store } = fixture();
    try {
      store.mutate("global", undefined, (file) => {
        file.memories.push({
          id: "m_1",
          text: "User prefers Traditional Chinese.",
          enabled: true,
          source: "agent",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        });
      });
      expect(store.read("global").memories).toHaveLength(1);
      expect(store.read("global").memories[0]!.text).toBe("User prefers Traditional Chinese.");
      expect(existsSync(join(dir, "memory", "global.json"))).toBe(true);
      // The revision moves on every write, so a reader can tell it is stale.
      expect(store.read("global").revision).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file that is not valid JSON is reported and left alone", () => {
    const { dir, store } = fixture();
    try {
      store.mutate("global", undefined, (file) => {
        file.memories.push({
          id: "m_1",
          text: "keep me",
          enabled: true,
          source: "agent",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        });
      });
      const path = join(dir, "memory", "global.json");
      const broken = "{ not json";
      writeFileSync(path, broken);
      expect(() => store.read("global")).toThrow(MemoryStoreError);
      expect(() => store.read("global")).toThrow(/not valid JSON/);
      // The hand edit is still there: nothing was overwritten.
      expect(readFileSync(path, "utf8")).toBe(broken);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hand edit is picked up by the next read", () => {
    const { dir, store } = fixture();
    try {
      store.mutate("global", undefined, () => {});
      const path = join(dir, "memory", "global.json");
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      parsed.memories.push({
        id: "m_hand",
        text: "written by a person",
        enabled: true,
        source: "user",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      writeFileSync(path, JSON.stringify(parsed, null, 2));
      expect(store.read("global").memories.map((entry) => entry.id)).toEqual(["m_hand"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a write that fails does not leave the store claiming it happened", () => {
    const { dir, store } = fixture();
    try {
      store.mutate("global", undefined, (file) => {
        file.memories.push({
          id: "m_1",
          text: "keep me",
          enabled: true,
          source: "agent",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        });
      });
      const memoryDir = join(dir, "memory");

      // The disk refuses the write: the directory is not writable, so the
      // temporary file cannot be created and the rename never happens.
      chmodSync(memoryDir, 0o500);
      try {
        expect(() =>
          store.mutate("global", undefined, (file) => {
            file.memories.push({
              id: "m_2",
              text: "never landed",
              enabled: true,
              source: "agent",
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
            });
          }),
        ).toThrow();
      } finally {
        chmodSync(memoryDir, 0o700);
      }

      // A save that did not happen is not a memory. The next read must not
      // find the entry the failed write put in the cache.
      expect(store.read("global").memories.map((entry) => entry.id)).toEqual(["m_1"]);
      expect(store.read("global").revision).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an entry that cannot be understood is dropped, the rest are kept", () => {
    const { dir, store } = fixture();
    try {
      store.mutate("global", undefined, () => {});
      const path = join(dir, "memory", "global.json");
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          revision: 3,
          memories: [
            { id: "m_ok", text: "kept" },
            { text: "no id" },
            { id: "m_empty", text: "   " },
            { id: "m_extra", text: "also kept", enabled: false, key: "k" },
          ],
        }),
      );
      const file = store.read("global");
      expect(file.memories.map((entry) => entry.id)).toEqual(["m_ok", "m_extra"]);
      // A missing flag means injected, not dropped.
      expect(file.memories[0]!.enabled).toBe(true);
      expect(file.memories[1]!.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file of an unknown version is refused rather than guessed at", () => {
    const { dir, store } = fixture();
    try {
      store.mutate("global", undefined, () => {});
      writeFileSync(join(dir, "memory", "global.json"), JSON.stringify({ version: 9, memories: [] }));
      expect(() => store.read("global")).toThrow(/unknown version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the workspace index remembers the workspaces it has seen", () => {
    const { dir, store } = fixture();
    try {
      store.touchWorkspace("k1", "/work/one", "2026-01-01T00:00:00.000Z");
      store.touchWorkspace("k2", "/work/two", "2026-01-02T00:00:00.000Z");
      store.touchWorkspace("k1", "/work/one", "2026-01-03T00:00:00.000Z");
      const index = store.readIndex();
      expect(index.workspaces.map((row) => row.key)).toEqual(["k1", "k2"]);
      expect(index.workspaces[0]!.last_used).toBe("2026-01-03T00:00:00.000Z");
      store.forgetWorkspace("k2");
      expect(store.readIndex().workspaces.map((row) => row.key)).toEqual(["k1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a workspace used again straight away does not rewrite the index", () => {
    const { dir, store } = fixture();
    try {
      const now = new Date().toISOString();
      store.touchWorkspace("k1", "/work/one", now);
      const first = readFileSync(join(dir, "memory", "workspaces.json"), "utf8");
      // The system prompt is rebuilt on every model call; the index is not
      // rewritten for a workspace that was already there a moment ago.
      store.touchWorkspace("k1", "/work/one", new Date().toISOString());
      expect(readFileSync(join(dir, "memory", "workspaces.json"), "utf8")).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a workspace scope without a key is refused", () => {
    const { store } = fixture();
    expect(() => store.read("workspace", undefined)).toThrow(/workspace key/);
  });
});
