import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";

/**
 * Browser lifecycle: the parts the design's acceptance criteria name.
 *
 * - a session ending takes its tabs with it, and only its tabs;
 * - disabling the plugin closes what it owns;
 * - a restarted service adopts the window that is still running instead of
 *   opening a second one.
 *
 * The last one is the interesting case, and it is why the manager writes a
 * port to a state file: the adoption is the difference between a restart that
 * keeps the reader's logins and one that leaves an orphaned Chrome behind.
 */
const hasChrome = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";

describe.skipIf(!hasChrome)("the browser's lifecycle", () => {
  /**
   * Each case gets its own data directory.
   *
   * `plugins-state.json` is where a disable is remembered, which is a property
   * worth having — and it means a suite that shared one directory would start
   * its next service with the plugin the previous case turned off.
   */
  let desktop = "";
  let work = "";
  let server: ReturnType<typeof Bun.serve>;
  let origin = "";

  const policyFile = () => join(desktop, "policy.json");

  /**
   * A new data directory for one case.
   *
   * `plugins-state.json` remembers a disable, which is a property worth
   * having and means a shared directory would start the next service with the
   * plugin the previous case turned off. The previous directory is removed
   * first: `stop()` hands plugins their shutdown asynchronously, so a Chrome
   * may still be closing, and deleting the profile underneath it is the race
   * that leaves a process behind.
   */
  const freshDesktop = () => {
    if (desktop) rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    desktop = mkdtempSync(join(tmpdir(), "strata-browser-life-"));
    writeFileSync(
      policyFile(),
      JSON.stringify({ version: 1, default: "allow", rules: [{ id: "browse", effect: "allow", tool: "browser_*" }] }),
    );
    return desktop;
  };

  const start = () =>
    startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile: policyFile() });

  /**
   * Wait for a plugin to be up.
   *
   * The budget is generous on purpose: this waits for a browser launch, and a
   * machine running the rest of the suite in parallel can take seconds to get
   * a Chrome window to its DevTools port. A tighter number turns a slow
   * machine into a failed case.
   */
  const waitRunning = async (svc: ReturnType<typeof startService>, id: string) => {
    for (let i = 0; i < 400; i++) {
      const listing = (await (await fetch(`http://127.0.0.1:${svc.port}/plugins`)).json()) as {
        plugins: { id: string; state: string; error?: string }[];
      };
      const row = listing.plugins.find((p) => p.id === id);
      if (row?.state === "running") return;
      if (row?.state === "failed") throw new Error(`plugin ${id} failed: ${row.error}`);
      await Bun.sleep(50);
    }
    throw new Error(`plugin ${id} never started`);
  };

  const call = async (
    svc: ReturnType<typeof startService>,
    tool: string,
    input: Record<string, unknown> = {},
    session = "opencode:ses_life",
  ) => {
    const res = await fetch(`http://127.0.0.1:${svc.port}/plugins/browser/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: session, input }),
    });
    return { status: res.status, body: (await res.json()) as { output?: string; is_error?: boolean; error?: string } };
  };

  const session = (svc: ReturnType<typeof startService>, id: string) =>
    svc.store.append([
      makeEvent({
        session_id: id,
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: id, workspace: work },
      } as EventInput),
    ]);

  beforeAll(() => {
    freshDesktop();
    work = mkdtempSync(join(tmpdir(), "strata-browser-life-work-"));
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("<title>Life</title><button>One</button>", { headers: { "content-type": "text/html" } });
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
  }, 30_000);

  afterAll(() => {
    server?.stop(true);
    // Each case replaced `desktop`, so only the last one is left to remove;
    // the earlier ones were removed when the next case started from scratch.
    rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);


  test("deleting a session closes its tabs and leaves the other session alone", async () => {
    freshDesktop();
    const svc = start();
    try {
      await waitRunning(svc, "browser");
      session(svc, "opencode:ses_life");
      session(svc, "opencode:ses_keep");
      expect((await call(svc, "navigate", { url: origin })).status).toBe(200);
      expect((await call(svc, "navigate", { url: `${origin}/two` }, "opencode:ses_keep")).status).toBe(200);

      // `local=1`: there is no connected backend in this test, and the point
      // is the plugin cleanup, not the backend's own delete.
      const deleted = await fetch(
        `http://127.0.0.1:${svc.port}/sessions/${encodeURIComponent("opencode:ses_life")}?local=1`,
        { method: "DELETE" },
      );
      expect(deleted.status).toBe(200);

      // The plugin is told, asynchronously; give it a beat to close the tab.
      let gone = false;
      for (let i = 0; i < 60 && !gone; i++) {
        const tabs = (await call(svc, "tabs")).body.output ?? "";
        gone = tabs.includes("No tabs in this session");
        if (!gone) await Bun.sleep(50);
      }
      expect(gone).toBe(true);

      // The other session still has its tab: cleanup is per session, not global.
      const kept = (await call(svc, "tabs", {}, "opencode:ses_keep")).body.output ?? "";
      expect(kept).toContain("pg");
      expect(kept).not.toContain("No tabs");
    } finally {
      svc.stop();
    }
  }, 120_000);

  test("disabling the plugin closes the tabs it owns", async () => {
    freshDesktop();
    const svc = start();
    try {
      await waitRunning(svc, "browser");
      session(svc, "opencode:ses_life");
      await call(svc, "navigate", { url: origin });

      const disabled = await fetch(`http://127.0.0.1:${svc.port}/plugins/browser/lifecycle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "disable" }),
      });
      expect(disabled.status).toBe(200);
      // Its tools are gone from the table, which is the observable half of
      // "the instance released everything".
      const table = (await (await fetch(`http://127.0.0.1:${svc.port}/plugins/tools`)).json()) as {
        tools: { name: string }[];
      };
      expect(table.tools.some((t) => t.name.startsWith("browser_"))).toBe(false);
    } finally {
      svc.stop();
    }
  }, 120_000);

  test("a clean shutdown closes the window and forgets the port", async () => {
    // Adoption only means something after a crash; a shutdown that left the
    // state file behind would make the next launch adopt a window this one
    // deliberately closed. The crash case is the manager's own test — it is
    // the only place a process can be left running on purpose.
    freshDesktop();
    const svc = start();
    try {
      await waitRunning(svc, "browser");
      session(svc, "opencode:ses_life");
      expect((await call(svc, "navigate", { url: origin })).status).toBe(200);
      expect(existsSync(join(desktop, "plugins", "browser", "browser-state.json"))).toBe(true);
    } finally {
      svc.stop();
    }
    // The service asked the plugin to stop, so both the window and the note
    // naming it are gone.
    for (let i = 0; i < 40 && existsSync(join(desktop, "plugins", "browser", "browser-state.json")); i++) {
      await Bun.sleep(50);
    }
    expect(existsSync(join(desktop, "plugins", "browser", "browser-state.json"))).toBe(false);
  }, 120_000);
});
