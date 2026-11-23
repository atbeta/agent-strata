import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { workspaceKey } from "@agent-strata/plugin-memory";
import { startService } from "../src/index";

// What a plugin leaves behind when it is switched off.
//
// Disabling is not forgetting. The plugin stops reading, stops offering its
// tools and answers no route — but the notes it wrote are still on disk, and
// they come back the moment it is switched on again. The reader has to be
// able to tell those two apart, and has to be able to forget without finding
// the data directory by hand.

const SESSION = "opencode:ses_memory_disable";

describe("the memory plugin when it is disabled", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";
  const lifecycle = async (action: "enable" | "disable" | "restart"): Promise<Response> =>
    fetch(`${base}/plugins/memory/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });

  const waitForState = async (state: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${base}/plugins`);
      const body = (await res.json()) as { plugins: { id: string; state: string }[] };
      if (body.plugins.some((plugin) => plugin.id === "memory" && plugin.state === state)) return;
      await Bun.sleep(20);
    }
    throw new Error(`memory plugin did not reach ${state}`);
  };

  beforeAll(async () => {
    desktop = mkdtempSync(join(tmpdir(), "strata-memory-disable-"));
    work = mkdtempSync(join(tmpdir(), "strata-memory-disable-work-"));
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
        data: { title: "disable", workspace: work },
      } as EventInput),
    ]);
    // The plugin ships off; this file is about what happens once the reader
    // has turned it on, so turn it on.
    await lifecycle("enable");
    await waitForState("running");
  }, 30_000);

  afterAll(async () => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("a disabled plugin offers no tools, no prompt and no routes", async () => {
    await fetch(`${base}/plugins/memory/memories?scope=global`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "A fact that outlives the plugin being off." }),
    });

    await lifecycle("disable");
    await waitForState("disabled");

    // The tools are gone from the table the agent draws from.
    const tools = (await (await fetch(`${base}/plugins/tools`)).json()) as {
      tools: { name: string }[];
    };
    expect(tools.tools.filter((tool) => tool.name.startsWith("memory_"))).toHaveLength(0);

    // The system prompt no longer carries the memory.
    const prompt = (await (
      await fetch(`${base}/hooks/system-prompt?session=${encodeURIComponent(SESSION)}`)
    ).json()) as { text: string };
    expect(prompt.text).not.toContain("## Saved memory");
    expect(prompt.text).not.toContain("A fact that outlives the plugin being off.");

    // The route answers nothing, so a page showing this plugin's entries has
    // nothing to show and must say so rather than fail.
    const listed = await fetch(`${base}/plugins/memory/memories?scope=global`);
    expect(listed.status).toBe(404);
  }, 30_000);

  test("the summary still names the plugin, and says it is off", async () => {
    // A surface that shows the plugin's settings has to know whether the
    // plugin can act at all; offering controls to a plugin that answers no
    // route would be offering controls that cannot work.
    const res = await fetch(`${base}/plugins`);
    const body = (await res.json()) as { plugins: { id: string; state: string }[] };
    const memory = body.plugins.find((plugin) => plugin.id === "memory");
    expect(memory).toBeTruthy();
    expect(memory?.state).toBe("disabled");
  }, 30_000);

  test("the notes are still on disk, and they come back", async () => {
    await lifecycle("enable");
    await waitForState("running");

    const listed = await fetch(`${base}/plugins/memory/memories?scope=global`);
    const body = (await listed.json()) as { memories: { text: string }[] };
    expect(body.memories.map((entry) => entry.text)).toContain(
      "A fact that outlives the plugin being off.",
    );

    const prompt = (await (
      await fetch(`${base}/hooks/system-prompt?session=${encodeURIComponent(SESSION)}`)
    ).json()) as { text: string };
    expect(prompt.text).toContain("A fact that outlives the plugin being off.");
  }, 30_000);

  test("forgetting every memory is a different act from disabling the plugin", async () => {
    const query = new URLSearchParams({ scope: "global" });
    const cleared = await fetch(`${base}/plugins/memory/memories?${query}`, { method: "DELETE" });
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as { forgotten: number };
    expect(body.forgotten).toBeGreaterThan(0);

    const listed = await fetch(`${base}/plugins/memory/memories?${query}`);
    const after = (await listed.json()) as { memories: unknown[] };
    expect(after.memories).toHaveLength(0);

    // The file is emptied, not deleted: the reader's own data directory keeps
    // its shape, and only what the agent remembered is gone.
    const file = await Bun.file(
      join(desktop, "plugins", "memory", "memory", "global.json"),
    ).text();
    expect(JSON.parse(file).memories).toHaveLength(0);
  }, 30_000);

  test("forgetting everything reaches every workspace, not just the current one", async () => {
    const other = mkdtempSync(join(tmpdir(), "strata-memory-disable-other-"));
    try {
      const query = new URLSearchParams({ scope: "workspace", workspace: workspaceKey(work) });
      await fetch(`${base}/plugins/memory/memories?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "A workspace note." }),
      });

      const cleared = await fetch(`${base}/plugins/memory/memories?scope=all`, {
        method: "DELETE",
      });
      expect(cleared.status).toBe(200);

      const after = (await (
        await fetch(`${base}/plugins/memory/memories?${query}`)
      ).json()) as { memories: unknown[] };
      expect(after.memories).toHaveLength(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 30_000);
});
