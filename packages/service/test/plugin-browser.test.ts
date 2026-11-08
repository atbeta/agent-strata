import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";

/**
 * The browser plugin over the service's own routes.
 *
 * The manager is tested against a real Chrome in its own package; what this
 * file asks is whether the platform carries it: does the tool table expose
 * `browser_*`, does a call reach the plugin with the right session, does a
 * guard refuse a URL the plugin's allowlist excludes, and does the panel's
 * private route answer.
 *
 * Chrome is launched headless by setting `BROWSER_HEADLESS`: the shipped
 * default is a visible window, and a test suite that leaves windows behind is
 * one nobody runs twice.
 */
const hasChrome = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";

describe.skipIf(!hasChrome)("browser tools through the service", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";
  let server: ReturnType<typeof Bun.serve>;
  let origin = "";

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const call = (tool: string, input: Record<string, unknown> = {}, session = "opencode:ses_b") =>
    post(`/plugins/browser/tools/${tool}`, { session_id: session, input });

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          `<!doctype html><html><head><title>Fixture</title></head><body>
             <button onclick="document.title='Pushed'">Push</button>
             <input placeholder="query" />
             <p>hello from the fixture</p>
           </body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    origin = `http://127.0.0.1:${server.port}`;

    desktop = mkdtempSync(join(tmpdir(), "strata-browser-svc-"));
    work = mkdtempSync(join(tmpdir(), "strata-browser-work-"));
    const policyFile = join(desktop, "policy.json");
    // The browser's tools declare `ask` for navigation and eval; an explicit
    // rule is the reader's decision and wins, which is what the merge rule is
    // for. Everything else in the manifest already allows.
    writeFileSync(
      policyFile,
      JSON.stringify({
        version: 1,
        default: "allow",
        rules: [
          { id: "browse-here", effect: "allow", tool: "browser_navigate" },
          { id: "inspect", effect: "allow", tool: "browser_eval" },
        ],
      }),
    );
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile });
    base = `http://127.0.0.1:${svc.port}`;
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_b",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "browser", workspace: work },
      } as EventInput),
    ]);
    // The plugin starts asynchronously; wait for it to be running.
    for (let i = 0; i < 300; i++) {
      const listing = (await (await fetch(`${base}/plugins`)).json()) as {
        plugins: { id: string; state: string }[];
      };
      if (listing.plugins.find((p) => p.id === "browser")?.state === "running") break;
      await Bun.sleep(50);
    }
  }, 60_000);

  afterAll(async () => {
    await call("close").catch(() => {});
    svc?.stop();
    server?.stop(true);
    rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 60_000);

  test("the tool table carries browser_* without the service knowing them", async () => {
    const table = (await (await fetch(`${base}/plugins/tools`)).json()) as { tools: { name: string }[] };
    const names = table.tools.map((t) => t.name);
    for (const name of [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_screenshot",
      "browser_tabs",
    ]) {
      expect(names).toContain(name);
    }
  }, 30_000);

  test("navigate opens a page, and the snapshot lists its controls", async () => {
    const res = await call("navigate", { url: origin });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string; is_error: boolean };
    expect(body.is_error).toBe(false);
    expect(body.output).toContain("Fixture");
    expect(body.output).toMatch(/e\d+ button "Push"/);
  }, 60_000);

  test("a click by ref gets a fresh snapshot, and the page moved", async () => {
    const snap = (await (await call("snapshot")).json()) as { output: string };
    const ref = /(e\d+) button "Push"/.exec(snap.output)?.[1];
    expect(ref).toBeDefined();
    const after = (await (await call("click", { ref })).json()) as { output: string; is_error: boolean };
    expect(after.is_error).toBe(false);
    expect(after.output).toContain("Pushed");
  }, 60_000);

  test("a bare host:port passes the guard, because the tool says it may", async () => {
    // The description says "http(s) URL, or host:port", and opening a local dev
    // server is the most common thing this tool does. The host guard used to
    // parse with `new URL(raw)` and refuse these as `localhost:` — before the
    // plugin, which would have normalized them, ever ran.
    const bare = `127.0.0.1:${new URL(origin).port}`;
    const res = await call("navigate", { url: bare });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string; is_error: boolean };
    expect(body.is_error).toBe(false);
    expect(body.output).toContain("Fixture");

    // A name with nothing listening is the other shape a model types. The
    // point is who answers: a 403 would be the guard refusing before the
    // plugin ran; a 200 with a snapshot is the plugin having tried and found
    // an error page, which is a page.
    const named = await call("navigate", { url: "localhost:1" });
    expect(named.status).toBe(200);
    const answer = (await named.json()) as { output: string };
    // Chrome's own error page, which is still a page: the guard did not stop
    // the call, and the plugin did what it was asked.
    expect(answer.output).toContain("localhost");
  }, 60_000);

  test("a guard refuses a URL outside the plugin's allowlist, before the plugin runs", async () => {
    // The manifest allows every host (`net: ["*"]`), so the host's own scheme
    // check is what refuses this: `file:` is not a page an agent may open.
    const res = await call("navigate", { url: "file:///etc/passwd" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/must be a URL|unsupported scheme|not a valid URL/);
  }, 30_000);

  test("a screenshot comes back as an image attachment", async () => {
    const res = await call("screenshot");
    const body = (await res.json()) as { attachments?: { type: string; mime: string; data: string }[] };
    expect(body.attachments?.[0]?.mime).toBe("image/png");
    expect(Buffer.from(body.attachments![0]!.data, "base64").subarray(0, 4).toString("hex")).toBe("89504e47");
  }, 60_000);

  test("the panel's state route answers, and the input route refuses an unknown kind", async () => {
    const state = await fetch(`${base}/plugins/browser/panel/state?session=opencode%3Ases_b`);
    expect(state.status).toBe(200);
    const body = (await state.json()) as { targets: { id: string }[] };
    expect(body.targets.length).toBeGreaterThan(0);

    const bad = await post("/plugins/browser/panel/input", {
      session: "opencode:ses_b",
      kind: "teleport",
      x: 0.5,
      y: 0.5,
    });
    expect(bad.status).toBe(400);
  }, 30_000);

  test("one session cannot drive another's tab", async () => {
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_c",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "other", workspace: work },
      } as EventInput),
    ]);
    const mine = (await (await call("tabs")).json()) as { output: string };
    // The other session holds nothing, even though the same Chrome is up.
    expect(mine.output).toContain("pg1");
    const theirs = (await (await call("tabs", {}, "opencode:ses_c")).json()) as { output: string };
    expect(theirs.output).toContain("No tabs in this session");
  }, 60_000);

  test("closing a session's tabs leaves the browser up for the next one", async () => {
    const closed = (await (await call("close")).json()) as { output: string };
    expect(closed.output).toMatch(/Closed \d+ tab/);
    const after = (await (await call("tabs")).json()) as { output: string };
    expect(after.output).toContain("No tabs in this session");
  }, 60_000);
});
