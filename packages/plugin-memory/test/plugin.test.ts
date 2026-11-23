import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, ToolCallRequest } from "@agent-strata/plugin-sdk";
import { createMemoryPlugin } from "../src/index";
import { MemoryStore } from "../src/store";
import { workspaceKey } from "../src/workspace";

function fixture(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "strata-memory-plugin-"));
  const store = new MemoryStore({
    dataDir: dir,
    maxEntries: Number(config.maxEntries ?? 200),
    maxEntryChars: Number(config.maxEntryChars ?? 2000),
  });
  const context: PluginContext = {
    pluginId: "memory",
    resolveSession: (id: string) => id,
    dataDir: dir,
    config,
    logger: { info() {}, warn() {}, error() {} },
    emit() {},
  };
  const workspaces: Record<string, string> = {
    "opencode:one": join(dir, "work-one"),
    "opencode:two": join(dir, "work-two"),
  };
  const plugin = createMemoryPlugin({
    store,
    workspaceOf: (sessionId: string) => workspaces[sessionId],
  });
  return { dir, plugin, context, store };
}

async function call(
  plugin: ReturnType<typeof createMemoryPlugin>,
  tool: string,
  sessionId: string,
  input: Record<string, unknown> = {},
) {
  const req: ToolCallRequest = {
    tool,
    sessionId,
    input,
    signal: new AbortController().signal,
  };
  const result = await plugin.callTool!(req);
  return {
    isError: result.isError === true,
    output: result.output,
    json: () => JSON.parse(result.output) as Record<string, unknown>,
  };
}

describe("memory plugin", () => {
  test("a memory added in a workspace is not visible in another one", async () => {
    const { dir, plugin, context } = fixture();
    try {
      await plugin.initialize!(context);
      const added = await call(plugin, "add", "opencode:one", { text: "This repo deploys with make deploy." });
      expect(added.isError).toBe(false);

      const one = await call(plugin, "list", "opencode:one");
      expect((one.json().memories as unknown[]).length).toBe(1);

      const two = await call(plugin, "list", "opencode:two");
      expect((two.json().memories as unknown[]).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a global memory is visible everywhere, and a workspace one is not", async () => {
    const { dir, plugin, context } = fixture();
    try {
      await plugin.initialize!(context);
      await call(plugin, "add", "opencode:one", { text: "User prefers Traditional Chinese.", scope: "global" });
      await call(plugin, "add", "opencode:one", { text: "This repo deploys with make deploy." });

      const other = await call(plugin, "list", "opencode:two", { scope: "global" });
      expect((other.json().memories as unknown[]).length).toBe(1);

      // A session in another workspace sees the global one and its own.
      const prompt = await plugin.systemPrompt!("opencode:two");
      expect(prompt).toContain("User prefers Traditional Chinese.");
      expect(prompt).not.toContain("make deploy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same key replaces the fact instead of piling up beside it", async () => {
    const { dir, plugin, context } = fixture();
    try {
      await plugin.initialize!(context);
      await call(plugin, "add", "opencode:one", { text: "Deploy uses make deploy.", key: "deploy" });
      await call(plugin, "add", "opencode:one", { text: "Deploy uses make ship.", key: "deploy" });
      const listed = await call(plugin, "list", "opencode:one");
      const memories = listed.json().memories as { text: string }[];
      expect(memories).toHaveLength(1);
      expect(memories[0]!.text).toBe("Deploy uses make ship.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a scope at its limit refuses a new entry and says what to do", async () => {
    const { dir, plugin, context } = fixture({ maxEntries: 2 });
    try {
      await plugin.initialize!(context);
      await call(plugin, "add", "opencode:one", { text: "one" });
      await call(plugin, "add", "opencode:one", { text: "two" });
      const third = await call(plugin, "add", "opencode:one", { text: "three" });
      expect(third.isError).toBe(true);
      expect(third.output).toContain("already holds 2 memories");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an entry too long for its budget of characters is refused", async () => {
    const { dir, plugin, context } = fixture({ maxEntryChars: 20 });
    try {
      await plugin.initialize!(context);
      const long = await call(plugin, "add", "opencode:one", { text: "x".repeat(21) });
      expect(long.isError).toBe(true);
      expect(long.output).toContain("at most 20 characters");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an entry that is off is not turned back on by the agent repeating itself", async () => {
    const { dir, plugin, context } = fixture();
    try {
      await plugin.initialize!(context);
      await call(plugin, "add", "opencode:one", { text: "Deploy uses make deploy.", key: "deploy" });
      const id = (
        (await call(plugin, "list", "opencode:one")).json().memories as { id: string }[]
      )[0]!.id;
      await call(plugin, "update", "opencode:one", { id, enabled: false });

      // The same words again are not a new claim.
      const same = await call(plugin, "add", "opencode:one", { text: "Deploy uses make deploy.", key: "deploy" });
      expect((same.json().memory as { enabled: boolean }).enabled).toBe(false);

      // Different words under the same key are a new version of the fact.
      const changed = await call(plugin, "add", "opencode:one", { text: "Deploy uses make ship.", key: "deploy" });
      expect((changed.json().memory as { enabled: boolean }).enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an entry that is off is kept in the file but not in the prompt", async () => {
    const { dir, plugin, context } = fixture();
    try {
      await plugin.initialize!(context);
      const added = await call(plugin, "add", "opencode:one", { text: "temporary" });
      const id = (added.json().memory as { id: string }).id;

      const updated = await call(plugin, "update", "opencode:one", { id, enabled: false });
      expect(updated.isError).toBe(false);

      const listed = await call(plugin, "list", "opencode:one");
      expect((listed.json().memories as unknown[]).length).toBe(1);
      const prompt = await plugin.systemPrompt!("opencode:one");
      // Nothing enabled means nothing said: the file keeps the entry, the
      // prompt does not.
      expect(prompt).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an entry can be found by a word and taken back out", async () => {
    const { dir, plugin, context } = fixture();
    try {
      await plugin.initialize!(context);
      const added = await call(plugin, "add", "opencode:one", { text: "The staging database is on port 5433." });
      const id = (added.json().memory as { id: string }).id;

      const found = await call(plugin, "search", "opencode:one", { query: "5433" });
      expect((found.json().memories as unknown[]).length).toBe(1);

      const missing = await call(plugin, "search", "opencode:one", { query: "nothing here" });
      expect((missing.json().memories as unknown[]).length).toBe(0);

      const removed = await call(plugin, "remove", "opencode:one", { id });
      expect(removed.isError).toBe(false);
      const gone = await call(plugin, "search", "opencode:one", { query: "5433" });
      expect((gone.json().memories as unknown[]).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an entry of another workspace cannot be read or changed by id", async () => {
    const { dir, plugin, context } = fixture();
    try {
      await plugin.initialize!(context);
      const added = await call(plugin, "add", "opencode:one", { text: "private to one" });
      const id = (added.json().memory as { id: string }).id;
      const removed = await call(plugin, "remove", "opencode:two", { id });
      expect(removed.isError).toBe(true);
      const listed = await call(plugin, "list", "opencode:one");
      expect((listed.json().memories as unknown[]).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the prompt carries the memory and the way to change it", async () => {
    const { dir, plugin, context } = fixture();
    try {
      await plugin.initialize!(context);
      await call(plugin, "add", "opencode:one", { text: "User prefers Traditional Chinese." });
      const prompt = await plugin.systemPrompt!("opencode:one");
      expect(prompt).toContain("## Saved memory");
      expect(prompt).toContain("User prefers Traditional Chinese.");
      expect(prompt).toContain("memory_update");
      expect(prompt).toContain("memory_add");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the settings page can list, edit, disable and remove through the plugin's route", async () => {
    const { dir, plugin, context } = fixture();
    try {
      await plugin.initialize!(context);
      await call(plugin, "add", "opencode:one", { text: "written by the agent" });

      const key = workspaceKey(join(dir, "work-one"));
      const listed = await plugin.route!(
        new Request(`http://local/plugins/memory/memories?scope=workspace&workspace=${key}`),
        "/memories",
      );
      expect(listed?.status).toBe(200);
      const body = (await listed!.json()) as { memories: { id: string }[] };
      expect(body.memories).toHaveLength(1);

      const id = body.memories[0]!.id;
      const patched = await plugin.route!(
        new Request(`http://local/plugins/memory/memories/${id}?scope=workspace&workspace=${key}`, {
          method: "PATCH",
          body: JSON.stringify({ text: "written by the reader", enabled: false }),
        }),
        `/memories/${id}`,
      );
      expect(patched?.status).toBe(200);
      const changed = (await patched!.json()) as { memory: { text: string; enabled: boolean; source: string } };
      expect(changed.memory.text).toBe("written by the reader");
      expect(changed.memory.enabled).toBe(false);
      expect(changed.memory.source).toBe("user");

      const removed = await plugin.route!(
        new Request(`http://local/plugins/memory/memories/${id}?scope=workspace&workspace=${key}`, {
          method: "DELETE",
        }),
        `/memories/${id}`,
      );
      expect(removed?.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a workspace scope without a key is refused by the route", async () => {
    const { dir, plugin, context } = fixture();
    try {
      await plugin.initialize!(context);
      const listed = await plugin.route!(
        new Request("http://local/plugins/memory/memories?scope=workspace"),
        "/memories",
      );
      expect(listed?.status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
