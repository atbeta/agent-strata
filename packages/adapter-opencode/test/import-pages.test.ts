import { describe, expect, test } from "bun:test";
import type { OpencodeClient, Session } from "@opencode-ai/sdk/v2";
import { createSessionImport, listRootSessions, ROOT_FURTHER_PAGES, ROOT_PAGE } from "../src/import";

/**
 * One root, newest-first pages are what the experimental session list returns.
 * Only `id` and `time.updated` are read by the pager; the rest of the session
 * doc is not.
 */
function root(id: string, updated: number): Session {
  return { id, directory: "/repo", time: { created: 1, updated } } as Session;
}

/** `count` roots whose update times run down from `newest`. */
function page(count: number, newest: number, prefix: string): Session[] {
  return Array.from({ length: count }, (_, i) => root(`${prefix}-${newest - i}`, newest - i));
}

type ListQuery = {
  directory?: string;
  cursor?: number;
  roots?: boolean;
  limit?: number;
  archived?: boolean;
};

function pager(opts: {
  first: Session[];
  older?: (cursor: number) => Session[];
  fail?: boolean;
}) {
  const calls: ListQuery[] = [];
  const client = {
    session: {
      list: async () => {
        throw new Error("the scoped session list must not be used");
      },
    },
    experimental: {
      session: {
        list: async (query: ListQuery) => {
          calls.push(query);
          if (query.cursor === undefined) return { data: opts.first };
          if (opts.fail) throw new Error("experimental session list missing");
          return { data: opts.older?.(query.cursor) ?? [] };
        },
      },
    },
  } as unknown as OpencodeClient;
  return { client, calls };
}

describe("listRootSessions", () => {
  test("a short default page comes from the global experimental list", async () => {
    const { client, calls } = pager({ first: page(3, 30, "s") });
    const roots = await listRootSessions(client, undefined);
    expect(roots.map((r) => r.id)).toEqual(["s-30", "s-29", "s-28"]);
    expect(calls).toEqual([
      { directory: undefined, cursor: undefined, roots: true, limit: ROOT_PAGE, archived: true },
    ]);
  });

  test("a full page continues from the oldest update time", async () => {
    // The oldest row is not last, so the cursor has to be the minimum, not
    // the final element.
    const first = page(ROOT_PAGE, 1_000, "new");
    const oldest = first[10]!;
    oldest.time = { created: 1, updated: 50 };
    const { client, calls } = pager({
      first,
      older: () => page(2, 40, "old"),
    });
    const roots = await listRootSessions(client, "/repo");
    expect(calls).toEqual([
      { directory: "/repo", cursor: undefined, roots: true, limit: ROOT_PAGE, archived: true },
      { directory: "/repo", cursor: 50, roots: true, limit: ROOT_PAGE, archived: true },
    ]);
    expect(roots.some((r) => r.id === "old-40")).toBe(true);
    expect(roots.some((r) => r.id === "old-39")).toBe(true);
    expect(roots).toHaveLength(ROOT_PAGE + 2);
  });

  test("a page the server repeats does not loop", async () => {
    const first = page(ROOT_PAGE, 500, "same");
    const { client, calls } = pager({ first, older: () => first });
    const roots = await listRootSessions(client, "/repo");
    expect(calls).toHaveLength(2);
    expect(roots).toHaveLength(ROOT_PAGE);
  });

  test("a failed further page keeps the roots already listed", async () => {
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const { client } = pager({ first: page(ROOT_PAGE, 100, "kept"), fail: true });
      const roots = await listRootSessions(client, "/repo");
      expect(roots).toHaveLength(ROOT_PAGE);
      expect(errors.some((line) => String(line[0]).includes("page failed"))).toBe(true);
    } finally {
      console.error = orig;
    }
  });

  test("further pages stop at the cap while a full page is still coming back", async () => {
    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const { client, calls } = pager({
        first: page(ROOT_PAGE, 100_000, "p0"),
        older: (cursor) => page(ROOT_PAGE, cursor - 1, `p${cursor}`),
      });
      const roots = await listRootSessions(client, "/repo");
      expect(calls).toHaveLength(ROOT_FURTHER_PAGES + 1);
      expect(roots).toHaveLength(ROOT_PAGE * (ROOT_FURTHER_PAGES + 1));
      expect(errors.some((line) => String(line[0]).includes("capped"))).toBe(true);
    } finally {
      console.error = orig;
    }
  });
});

describe("refreshSessions", () => {
  test("a root past the first page is imported with the rest", async () => {
    const first = page(ROOT_PAGE, 1_000, "new");
    // The suffix is the update time, so a stored revision can match it and
    // the sync skips the transcript read.
    const older = root("old-1", 1);
    const seen: string[] = [];
    const children: string[] = [];
    const client = {
      project: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      session: {
        children: async (query: { sessionID: string }) => {
          children.push(query.sessionID);
          return { data: [] };
        },
        get: async () => ({ data: undefined }),
        messages: async () => ({ data: [] }),
        todo: async () => ({ data: [] }),
      },
      experimental: {
        session: {
          list: async (query: ListQuery) => ({ data: query.cursor === undefined ? first : [older] }),
        },
      },
    } as unknown as OpencodeClient;
    const importer = createSessionImport({
      client,
      directory: "/repo",
      sink: {
        append: () => [],
        sessionRevision: (id) => Number(id.slice(id.lastIndexOf("-") + 1)),
        markRevision: () => {},
      },
      ingestor: {
        handle: (evt) => {
          const id = (evt as { properties?: { sessionID?: string } }).properties?.sessionID;
          if (id) seen.push(id);
        },
        handleBatch: () => {},
      },
    });
    await importer.refreshSessions();
    const indexed = await importer.indexSessions();
    expect(seen).toContain("old-1");
    expect(indexed).toContain("old-1");
    expect(children).toContain("old-1");
  });
});
