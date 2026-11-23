import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { workspaceKey } from "@agent-strata/plugin-memory";
import { startService } from "../src/index";

const SESSION = "opencode:ses_memory_plugin";

interface ToolReply {
  output: string;
  is_error: boolean;
}

describe("memory plugin over the service", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";

  const call = async (tool: string, input: Record<string, unknown>): Promise<ToolReply> => {
    const res = await fetch(`${base}/plugins/memory/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: SESSION, input }),
    });
    return (await res.json()) as ToolReply;
  };

  beforeAll(async () => {
    desktop = mkdtempSync(join(tmpdir(), "strata-memory-service-"));
    work = mkdtempSync(join(tmpdir(), "strata-memory-service-work-"));
    writeFileSync(
      join(desktop, "policy.json"),
      JSON.stringify({
        version: 1,
        default: "ask",
        rules: [{ id: "memory", effect: "allow", tool: "memory_*" }],
      }),
    );
    svc = startService({
      db: ":memory:",
      port: 0,
      desktopDir: desktop,
      policyFile: join(desktop, "policy.json"),
    });
    base = `http://127.0.0.1:${svc.port}`;
    svc.store.append([
      makeEvent({
        session_id: SESSION,
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "memory", workspace: work },
      } as EventInput),
    ]);
    // The plugin ships off; this file is about how it works once the reader
    // has turned it on, so turn it on.
    await fetch(`${base}/plugins/memory/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "enable" }),
    });
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${base}/plugins`);
      const body = (await res.json()) as { plugins: { id: string; state: string }[] };
      if (body.plugins.some((plugin) => plugin.id === "memory" && plugin.state === "running")) return;
      await Bun.sleep(20);
    }
    throw new Error("memory plugin did not start");
  }, 30_000);

  afterAll(async () => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("the plugin runs and exposes its tools under the memory namespace", async () => {
    const res = await fetch(`${base}/plugins/tools`);
    const body = (await res.json()) as { tools: { name: string }[] };
    const names = body.tools.map((tool) => tool.name).filter((name) => name.startsWith("memory_"));
    expect(names.sort()).toEqual([
      "memory_add",
      "memory_list",
      "memory_remove",
      "memory_search",
      "memory_update",
    ]);
  });

  test("a saved memory comes back in the contributed system prompt", async () => {
    const added = await call("add", { text: "User prefers Traditional Chinese." });
    expect(added.is_error).toBe(false);

    const res = await fetch(`${base}/hooks/system-prompt?session=${encodeURIComponent(SESSION)}`);
    const body = (await res.json()) as { text: string };
    expect(body.text).toContain("## Saved memory");
    expect(body.text).toContain("User prefers Traditional Chinese.");
  });

  test("the memory the agent saved is the one the reader can manage", async () => {
    const added = await call("add", { text: "This repo deploys with make deploy." });
    const id = (JSON.parse(added.output) as { memory: { id: string } }).memory.id;

    const query = new URLSearchParams({ scope: "workspace", workspace: workspaceKey(work) });
    const listed = await fetch(`${base}/plugins/memory/memories?${query}`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { memories: { id: string; text: string }[] };
    const found = body.memories.find((entry) => entry.id === id);
    expect(found?.text).toBe("This repo deploys with make deploy.");

    const removed = await fetch(`${base}/plugins/memory/memories/${id}?${query}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
  });

  test("the reader's own policy decides whether saving asks", async () => {
    // The rule above allows every memory tool, so this call is not a question.
    const allowed = await call("add", { text: "A fact the reader's rule already allows." });
    expect(allowed.is_error).toBe(false);

    // With the rule gone the document default asks, and a denied ask is a 403.
    await fetch(`${base}/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, default: "ask", rules: [] }),
    });
    const asked = fetch(`${base}/plugins/memory/tools/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: SESSION, input: { text: "A fact nobody allowed yet." } }),
    });
    let requestId = "";
    for (let i = 0; i < 100 && !requestId; i++) {
      const pending = (await (await fetch(`${base}/permissions`)).json()) as {
        pending: { request_id: string; tool: string }[];
      };
      requestId = pending.pending.find((ask) => ask.tool === "memory_add")?.request_id ?? "";
      if (!requestId) await Bun.sleep(20);
    }
    expect(requestId).not.toBe("");
    await fetch(`${base}/permissions/${requestId}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "deny" }),
    });
    expect((await asked).status).toBe(403);
  }, 30_000);
});
