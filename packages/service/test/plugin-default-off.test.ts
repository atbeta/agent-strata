import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService } from "../src/index";

// Whether the memory plugin runs before the reader has asked for it.
//
// What this plugin collects is the reader's own preferences, so it ships off.
// The other half of that promise is that turning it on sticks: a restart
// must not quietly turn it back off, or the reader's choice would be a
// setting they have to make again every morning.

interface PluginRow {
  id: string;
  state: string;
}

const listPlugins = async (base: string): Promise<PluginRow[]> => {
  const body = (await (await fetch(`${base}/plugins`)).json()) as { plugins: PluginRow[] };
  return body.plugins;
};

describe("a plugin that ships off", () => {
  let desktop = "";

  beforeEach(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-default-off-"));
  });

  afterEach(() => {
    rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("does not run until the reader turns it on", async () => {
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop });
    try {
      const base = `http://127.0.0.1:${svc.port}`;
      for (let i = 0; i < 240; i++) {
        const plugins = await listPlugins(base);
        if (plugins.some((plugin) => plugin.id === "memory")) break;
        await Bun.sleep(50);
      }

      const memory = (await listPlugins(base)).find((plugin) => plugin.id === "memory");
      expect(memory?.state).toBe("disabled");

      // Nothing of it is offered to the agent.
      const table = (await (await fetch(`${base}/plugins/tools`)).json()) as {
        tools: { name: string }[];
      };
      expect(table.tools.some((tool) => tool.name.startsWith("memory_"))).toBe(false);

      // And nothing of it reaches the prompt.
      const prompt = (await (await fetch(`${base}/hooks/system-prompt?session=x`)).json()) as {
        text: string;
      };
      expect(prompt.text).not.toContain("## Saved memory");

      // It is still there to be turned on: the plugin is listed, not hidden.
      expect((await listPlugins(base)).some((plugin) => plugin.id === "memory")).toBe(true);
    } finally {
      svc.stop();
    }
  }, 60_000);

  test("stays on after a restart, because the reader chose it", async () => {
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop });
    let base = "";
    try {
      base = `http://127.0.0.1:${svc.port}`;
      for (let i = 0; i < 240; i++) {
        if ((await listPlugins(base)).some((plugin) => plugin.id === "memory")) break;
        await Bun.sleep(50);
      }

      await fetch(`${base}/plugins/memory/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "enable" }),
      });
      for (let i = 0; i < 240; i++) {
        const memory = (await listPlugins(base)).find((plugin) => plugin.id === "memory");
        if (memory?.state === "running") break;
        await Bun.sleep(50);
      }
      expect((await listPlugins(base)).find((plugin) => plugin.id === "memory")?.state).toBe("running");
    } finally {
      svc.stop();
    }

    // A second service over the same data directory: the reader's choice has
    // to be there, or the plugin would go back to off by itself.
    const again = startService({ db: ":memory:", port: 0, desktopDir: desktop });
    try {
      base = `http://127.0.0.1:${again.port}`;
      for (let i = 0; i < 240; i++) {
        const memory = (await listPlugins(base)).find((plugin) => plugin.id === "memory");
        if (memory && memory.state !== "disabled") break;
        await Bun.sleep(50);
      }
      expect((await listPlugins(base)).find((plugin) => plugin.id === "memory")?.state).toBe("running");
    } finally {
      again.stop();
    }
  }, 60_000);

  test("goes back to off when the reader turns it off again", async () => {
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop });
    let base = "";
    try {
      base = `http://127.0.0.1:${svc.port}`;
      for (let i = 0; i < 240; i++) {
        if ((await listPlugins(base)).some((plugin) => plugin.id === "memory")) break;
        await Bun.sleep(50);
      }
      await fetch(`${base}/plugins/memory/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "enable" }),
      });
      for (let i = 0; i < 240; i++) {
        const memory = (await listPlugins(base)).find((plugin) => plugin.id === "memory");
        if (memory?.state === "running") break;
        await Bun.sleep(50);
      }
      await fetch(`${base}/plugins/memory/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "disable" }),
      });
      for (let i = 0; i < 240; i++) {
        const memory = (await listPlugins(base)).find((plugin) => plugin.id === "memory");
        if (memory?.state === "disabled") break;
        await Bun.sleep(50);
      }
      expect((await listPlugins(base)).find((plugin) => plugin.id === "memory")?.state).toBe("disabled");
    } finally {
      svc.stop();
    }

    // Off means off, after a restart too.
    const again = startService({ db: ":memory:", port: 0, desktopDir: desktop });
    try {
      base = `http://127.0.0.1:${again.port}`;
      for (let i = 0; i < 240; i++) {
        if ((await listPlugins(base)).some((plugin) => plugin.id === "memory")) break;
        await Bun.sleep(50);
      }
      expect((await listPlugins(base)).find((plugin) => plugin.id === "memory")?.state).toBe("disabled");
    } finally {
      again.stop();
    }
  }, 60_000);
});
