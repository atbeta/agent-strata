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

describe("the panel's frame stream", () => {
  test("a panel opened before the agent navigates still gets its first frame", async () => {
    // The reader clicks the Browser tab while the agent is still thinking, so
    // the cast is requested with no tab in the session. It used to give up
    // there — `screencast` returned as soon as `pages.size === 0` — and nothing
    // ever restarted it, so the panel stayed blank for the whole session while
    // browser_screenshot worked in the transcript.
    const desktop = mkdtempSync(join(tmpdir(), "strata-cast-"));
    const work = mkdtempSync(join(tmpdir(), "strata-cast-work-"));
    const page = Bun.serve({
      port: 0,
      fetch: () => new Response("<title>Cast</title><button>Go</button>", { headers: { "content-type": "text/html" } }),
    });
    const policyFile = join(desktop, "policy.json");
    writeFileSync(
      policyFile,
      JSON.stringify({ version: 1, default: "allow", rules: [{ id: "browse", effect: "allow", tool: "browser_*" }] }),
    );
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      svc.store.append([
        makeEvent({
          session_id: "opencode:ses_cast",
          type: "session.started",
          ts: "2026-01-01T00:00:00Z",
          source: { backend: "opencode" },
          data: { title: "cast", workspace: work },
        } as EventInput),
      ]);
      for (let i = 0; i < 300; i++) {
        const listing = (await (await fetch(`${base}/plugins`)).json()) as {
          plugins: { id: string; state: string }[];
        };
        if (listing.plugins.find((p) => p.id === "browser")?.state === "running") break;
        await Bun.sleep(50);
      }

      // 1) The panel asks for frames first, with nothing to show yet.
      const cast = await post("/plugins/browser/panel/cast", {
        session: "opencode:ses_cast",
        fps: 6,
        width: 700,
        height: 900,
      });
      expect(cast.status).toBe(200);

      // 2) The events stream is what the panel listens on.
      const events = await fetch(`${base}/plugins/browser/events?session=opencode%3Ases_cast`);
      expect(events.status).toBe(200);
      const reader = events.body!.getReader();
      const decoder = new TextDecoder();
      let sawFrame = "";
      const pump = (async () => {
        let buffered = "";
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !sawFrame) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const chunks = buffered.split("\n\n");
          buffered = chunks.pop() ?? "";
          for (const chunk of chunks) {
            const data = chunk.replace(/^data: /, "").trim();
            if (!data) continue;
            if (data.includes('"frame"')) sawFrame = data;
          }
        }
      })();

      // 3) Only now does the agent open a page.
      await Bun.sleep(200);
      const navigated = await post("/plugins/browser/tools/navigate", {
        session_id: "opencode:ses_cast",
        input: { url: `http://127.0.0.1:${page.port}` },
      });
      expect(navigated.status).toBe(200);

      await Promise.race([pump, Bun.sleep(16_000)]);
      await reader.cancel().catch(() => {});
      expect(sawFrame).toContain("image/jpeg");

      await post("/plugins/browser/panel/stop", { session: "opencode:ses_cast" });
    } finally {
      svc.stop();
      page.stop(true);
      rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});

describe("a session that said stop asking", () => {
  test("navigate goes through without a card, while eval still asks", async () => {
    // The reader turned the stance on and still got a prompt per navigation:
    // `navigate` declared a floor of `ask`, and a floor survives the stance by
    // design. Opening a page is how the browser is used at all, so that floor
    // was wrong — the stance has to be able to lift it. `eval` keeps its floor
    // because running script in a page is not the same act as visiting it.
    const desktop = mkdtempSync(join(tmpdir(), "strata-auto-"));
    const work = mkdtempSync(join(tmpdir(), "strata-auto-work-"));
    const page = Bun.serve({
      port: 0,
      fetch: () => new Response("<title>Auto</title><p>hi</p>", { headers: { "content-type": "text/html" } }),
    });
    const policyFile = join(desktop, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ version: 1, default: "ask", rules: [] }));
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      svc.store.append([
        makeEvent({
          session_id: "opencode:ses_auto",
          type: "session.started",
          ts: "2026-01-01T00:00:00Z",
          source: { backend: "opencode" },
          data: { title: "auto", workspace: work },
        } as EventInput),
      ]);
      for (let i = 0; i < 300; i++) {
        const listing = (await (await fetch(`${base}/plugins`)).json()) as {
          plugins: { id: string; state: string }[];
        };
        if (listing.plugins.find((p) => p.id === "browser")?.state === "running") break;
        await Bun.sleep(50);
      }

      const switched = await fetch(`${base}/sessions/opencode%3Ases_auto/policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "auto" }),
      });
      expect(switched.status).toBe(200);

      const navigated = await post("/plugins/browser/tools/navigate", {
        session_id: "opencode:ses_auto",
        input: { url: `http://127.0.0.1:${page.port}` },
      });
      expect(navigated.status).toBe(200);
      const pending = (await (await fetch(`${base}/permissions`)).json()) as {
        pending: { tool: string }[];
      };
      expect(pending.pending.some((p) => p.tool === "browser_navigate")).toBe(false);

      // eval keeps its ask floor: the stance does not turn arbitrary script in
      // a page into something that runs unattended.
      const evaluating = post("/plugins/browser/tools/eval", {
        session_id: "opencode:ses_auto",
        input: { source: "1 + 1" },
      });
      let ask: { request_id: string; tool: string } | undefined;
      for (let i = 0; i < 60 && !ask; i++) {
        const listing = (await (await fetch(`${base}/permissions`)).json()) as {
          pending: { request_id: string; tool: string }[];
        };
        ask = listing.pending.find((p) => p.tool === "browser_eval");
        if (!ask) await Bun.sleep(50);
      }
      expect(ask).toBeDefined();
      await post(`/permissions/${encodeURIComponent(ask!.request_id)}/respond`, { decision: "deny" });
      expect((await evaluating).status).toBe(403);
    } finally {
      svc.stop();
      page.stop(true);
      rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});

describe("the panel can be typed in", () => {
  test("text, a key and a drag reach the page as themselves", async () => {
    // The rail is supposed to be a browser, not a picture of one. These are
    // the three input classes the panel forwards: inserted text (including
    // what an IME composes), a key event, and a drag — which is a move the
    // page sees with the button still held.
    const desktop = mkdtempSync(join(tmpdir(), "strata-input-"));
    const work = mkdtempSync(join(tmpdir(), "strata-input-work-"));
    const page = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><title>Input</title>
           <input id=q autofocus />
           <div id=pad style="width:300px;height:200px;background:#ddd"></div>
           <script>
             window.__log = { keys: [], drags: [], text: "" };
             document.getElementById('q').addEventListener('input', (e) => { window.__log.text = e.target.value; });
             document.getElementById('q').addEventListener('keydown', (e) => { window.__log.keys.push(e.key); });
             // Document-level: the panel's coordinates are fractions of the
             // whole frame, so the gesture is not tied to one element's box.
             let down = false;
             document.addEventListener('mousedown', () => { down = true; window.__log.drags.push('down'); });
             document.addEventListener('mousemove', () => { if (down) window.__log.drags.push('move'); });
             document.addEventListener('mouseup', () => { down = false; window.__log.drags.push('up'); });
           </script>`,
          { headers: { "content-type": "text/html" } },
        ),
    });
    const policyFile = join(desktop, "policy.json");
    writeFileSync(
      policyFile,
      JSON.stringify({ version: 1, default: "allow", rules: [{ id: "browse", effect: "allow", tool: "browser_*" }] }),
    );
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const tool = async (name: string, input: Record<string, unknown> = {}) =>
      (await (await post(`/plugins/browser/tools/${name}`, { session_id: "opencode:ses_in", input })).json()) as {
        output: string;
        is_error: boolean;
      };
    const panelInput = (body: Record<string, unknown>) =>
      post("/plugins/browser/panel/input", { session: "opencode:ses_in", ...body });
    /** The page's own record of what it received. */
    const logOf = async () =>
      JSON.parse((await tool("eval", { source: "JSON.stringify(window.__log)" })).output) as {
        text: string;
        keys: string[];
        drags: string[];
      };

    try {
      svc.store.append([
        makeEvent({
          session_id: "opencode:ses_in",
          type: "session.started",
          ts: "2026-01-01T00:00:00Z",
          source: { backend: "opencode" },
          data: { title: "input", workspace: work },
        } as EventInput),
      ]);
      for (let i = 0; i < 300; i++) {
        const listing = (await (await fetch(`${base}/plugins`)).json()) as {
          plugins: { id: string; state: string }[];
        };
        if (listing.plugins.find((p) => p.id === "browser")?.state === "running") break;
        await Bun.sleep(50);
      }
      await tool("navigate", { url: `http://127.0.0.1:${page.port}` });

      // 1) Text: what the hidden field forwards, including a composed word.
      expect((await panelInput({ kind: "text", text: "你好" })).status).toBe(200);
      let typed = "";
      for (let i = 0; i < 40 && !typed.includes("你好"); i++) {
        typed = (await logOf()).text;
        if (!typed.includes("你好")) await Bun.sleep(50);
      }
      expect(typed).toBe("你好");

      // 2) A key the page has to see as a key, not as text.
      expect((await panelInput({ kind: "key", key: "Enter" })).status).toBe(200);
      let keys: string[] = [];
      for (let i = 0; i < 40 && keys.length === 0; i++) {
        keys = (await logOf()).keys;
        if (keys.length === 0) await Bun.sleep(50);
      }
      expect(keys).toContain("Enter");

      // 3) A drag: down on the pad, a move with the button held, then up.
      const spot = { x: 0.25, y: 0.5 };
      expect((await panelInput({ kind: "down", ...spot })).status).toBe(200);
      expect((await panelInput({ kind: "move", x: 0.5, y: 0.5, dragging: true })).status).toBe(200);
      expect((await panelInput({ kind: "up", ...spot })).status).toBe(200);
      let drags: string[] = [];
      for (let i = 0; i < 40 && drags.filter((d) => d === "up").length === 0; i++) {
        drags = (await logOf()).drags;
        if (drags.filter((d) => d === "up").length === 0) await Bun.sleep(50);
      }
      expect(drags[0]).toBe("down");
      expect(drags).toContain("move");
      expect(drags.at(-1)).toBe("up");
    } finally {
      svc.stop();
      page.stop(true);
      rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});

describe("an agent that sent the schema instead of the arguments", () => {
  test("is understood, instead of being told its URL was undefined", async () => {
    // Seen in the wild: `browser_navigate` arrived as
    // `{"properties": "{\"url\": \"http://localhost:4321/\"}"}` — the
    // parameter bag, JSON-encoded — and the tool answered
    // "not a URL an agent may open: undefined" before falling back to opening
    // the page in the system browser.
    const desktop = mkdtempSync(join(tmpdir(), "strata-args-"));
    const work = mkdtempSync(join(tmpdir(), "strata-args-work-"));
    const page = Bun.serve({
      port: 0,
      fetch: () => new Response("<title>Wrapped</title><p>hello</p>", { headers: { "content-type": "text/html" } }),
    });
    const policyFile = join(desktop, "policy.json");
    writeFileSync(
      policyFile,
      JSON.stringify({ version: 1, default: "allow", rules: [{ id: "browse", effect: "allow", tool: "browser_*" }] }),
    );
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      svc.store.append([
        makeEvent({
          session_id: "opencode:ses_args",
          type: "session.started",
          ts: "2026-01-01T00:00:00Z",
          source: { backend: "opencode" },
          data: { title: "args", workspace: work },
        } as EventInput),
      ]);
      for (let i = 0; i < 300; i++) {
        const listing = (await (await fetch(`${base}/plugins`)).json()) as {
          plugins: { id: string; state: string }[];
        };
        if (listing.plugins.find((p) => p.id === "browser")?.state === "running") break;
        await Bun.sleep(50);
      }
      const call = async (input: unknown) =>
        (await (await fetch(`${base}/plugins/browser/tools/navigate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "opencode:ses_args", input }),
        })).json()) as { output?: string; is_error?: boolean; error?: string };

      for (const wrapped of [
        { properties: JSON.stringify({ url: `http://127.0.0.1:${page.port}/` }) },
        { properties: { url: `http://127.0.0.1:${page.port}/` } },
      ]) {
        const res = await call(wrapped);
        expect(res.is_error).toBeFalsy();
        expect(res.output ?? "").toContain("Wrapped");
      }

      // And a call with no url at all now says so instead of blaming the URL.
      const empty = await call({});
      expect(empty.output ?? "").toContain('needs a "url" argument');
    } finally {
      svc.stop();
      page.stop(true);
      rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});

describe("the rail can wear the page's cursor", () => {
  test("a point over a link answers pointer, and a moving page updates its URL", async () => {
    const desktop = mkdtempSync(join(tmpdir(), "strata-cursor-"));
    const work = mkdtempSync(join(tmpdir(), "strata-cursor-work-"));
    const page = Bun.serve({
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/next") {
          return new Response("<title>Next</title><p>next</p>", { headers: { "content-type": "text/html" } });
        }
        return new Response(
          `<!doctype html><title>Cursor</title>
           <style>html,body{margin:0;height:100%;cursor:crosshair} a{display:block;height:400px;cursor:pointer}</style>
           <a href="/next" id=goto>go</a>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const policyFile = join(desktop, "policy.json");
    writeFileSync(
      policyFile,
      JSON.stringify({ version: 1, default: "allow", rules: [{ id: "b", effect: "allow", tool: "browser_*" }] }),
    );
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      svc.store.append([
        makeEvent({
          session_id: "opencode:ses_cur",
          type: "session.started",
          ts: "2026-01-01T00:00:00Z",
          source: { backend: "opencode" },
          data: { title: "cursor", workspace: work },
        } as EventInput),
      ]);
      for (let i = 0; i < 300; i++) {
        const listing = (await (await fetch(`${base}/plugins`)).json()) as {
          plugins: { id: string; state: string }[];
        };
        if (listing.plugins.find((p) => p.id === "browser")?.state === "running") break;
        await Bun.sleep(50);
      }
      await post("/plugins/browser/tools/navigate", {
        session_id: "opencode:ses_cur",
        input: { url: `http://127.0.0.1:${page.port}` },
      });
      // The linked block covers the top half; below it the body's crosshair.
      const over = (await (await post("/plugins/browser/panel/input", {
        session: "opencode:ses_cur",
        kind: "cursor",
        x: 0.5,
        y: 0.2,
      })).json()) as { cursor?: string | null };
      expect(over.cursor).toBe("pointer");
      const below = (await (await post("/plugins/browser/panel/input", {
        session: "opencode:ses_cur",
        kind: "cursor",
        x: 0.5,
        y: 0.9,
      })).json()) as { cursor?: string | null };
      expect(below.cursor).toBe("crosshair");

      // Clicking the link moves the page; the next frame's url must be the new
      // one, not the URL the last tool call happened to navigate to.
      await post("/plugins/browser/panel/input", { session: "opencode:ses_cur", kind: "click", x: 0.5, y: 0.2 });
      let url = "";
      for (let i = 0; i < 40 && !url.endsWith("/next"); i++) {
        await Bun.sleep(100);
        const tabs = (await (await post("/plugins/browser/tools/tabs", {
          session_id: "opencode:ses_cur",
          input: {},
        })).json()) as { output: string };
        url = /http:\/\/[^\s]+/.exec(tabs.output)?.[0] ?? "";
      }
      expect(url).toContain("/next");
    } finally {
      svc.stop();
      page.stop(true);
      rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});

describe("the wheel reaches the page", () => {
  test("scrolling moves the page, so content below the fold can be reached", async () => {
    // The rail is the only way to the page's lower half; a wheel that does not
    // scroll leaves whatever the agent opened half-unreachable.
    const desktop = mkdtempSync(join(tmpdir(), "strata-wheel-"));
    const work = mkdtempSync(join(tmpdir(), "strata-wheel-work-"));
    const page = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><title>Tall</title><style>body{margin:0} .tall{height:3000px}</style><div class=tall>x</div>`,
          { headers: { "content-type": "text/html" } },
        ),
    });
    const policyFile = join(desktop, "policy.json");
    // `browser_eval` is the plugin's own floor of "ask", so reading scrollY
    // needs a rule that says so; nothing here is a decision a person makes.
    writeFileSync(
      policyFile,
      JSON.stringify({
        version: 1,
        default: "allow",
        rules: [{ id: "eval", effect: "allow", tool: "browser_eval" }],
      }),
    );
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      svc.store.append([
        makeEvent({
          session_id: "opencode:ses_wheel",
          type: "session.started",
          ts: "2026-01-01T00:00:00Z",
          source: { backend: "opencode" },
          data: { title: "wheel", workspace: work },
        } as EventInput),
      ]);
      for (let i = 0; i < 300; i++) {
        const listing = (await (await fetch(`${base}/plugins`)).json()) as { plugins: { id: string; state: string }[] };
        if (listing.plugins.find((p) => p.id === "browser")?.state === "running") break;
        await Bun.sleep(50);
      }
      await post("/plugins/browser/tools/navigate", {
        session_id: "opencode:ses_wheel",
        input: { url: `http://127.0.0.1:${page.port}` },
      });
      await post("/plugins/browser/panel/input", { session: "opencode:ses_wheel", kind: "wheel", x: 0.5, y: 0.5, delta: 400 });
      let y = 0;
      for (let i = 0; i < 30 && y === 0; i++) {
        await Bun.sleep(100);
        const read = (await (await post("/plugins/browser/tools/eval", {
          session_id: "opencode:ses_wheel",
          input: { source: "String(scrollY)" },
        })).json()) as { output: string };
        y = Number(read.output.trim());
      }
      expect(y).toBeGreaterThan(0);
    } finally {
      svc.stop();
      page.stop(true);
      rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});

describe("a page that opens a dialog", () => {
  test("does not freeze, and the dialog is reported rather than waited on", async () => {
    // `alert()` blocks the page's renderer until something answers it. Nothing
    // in a headless panel can answer it, so the screencast stopped and every
    // later call queued behind it — the rail looked wedged.
    const desktop = mkdtempSync(join(tmpdir(), "strata-dialog-"));
    const work = mkdtempSync(join(tmpdir(), "strata-dialog-work-"));
    const page = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html><title>Dialog</title>
           <style>html,body{margin:0;height:100%}button{position:fixed;inset:0;width:100%;height:100%}</style>
           <button id=b onclick="alert('hello')">alert</button>`,
          { headers: { "content-type": "text/html" } },
        ),
    });
    const policyFile = join(desktop, "policy.json");
    writeFileSync(
      policyFile,
      JSON.stringify({
        version: 1,
        default: "allow",
        rules: [{ id: "eval", effect: "allow", tool: "browser_eval" }],
      }),
    );
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      svc.store.append([
        makeEvent({
          session_id: "opencode:ses_dlg",
          type: "session.started",
          ts: "2026-01-01T00:00:00Z",
          source: { backend: "opencode" },
          data: { title: "dialog", workspace: work },
        } as EventInput),
      ]);
      for (let i = 0; i < 300; i++) {
        const listing = (await (await fetch(`${base}/plugins`)).json()) as { plugins: { id: string; state: string }[] };
        if (listing.plugins.find((p) => p.id === "browser")?.state === "running") break;
        await Bun.sleep(50);
      }
      await post("/plugins/browser/tools/navigate", {
        session_id: "opencode:ses_dlg",
        input: { url: `http://127.0.0.1:${page.port}` },
      });
      // Click the button that opens the dialog.
      await post("/plugins/browser/panel/input", { session: "opencode:ses_dlg", kind: "click", x: 0.5, y: 0.4 });

      // The page must still answer: a page waiting on a dialog cannot run a
      // script, so this is the assertion that it was dismissed.
      let answered = "";
      for (let i = 0; i < 40 && answered !== "alive"; i++) {
        await Bun.sleep(100);
        const read = (await (await post("/plugins/browser/tools/eval", {
          session_id: "opencode:ses_dlg",
          input: { source: "String(1 + 1) === '2' ? 'alive' : 'no'" },
        })).json()) as { output: string };
        answered = read.output.trim();
      }
      expect(answered).toBe("alive");

      const log = (await (await post("/plugins/browser/tools/console", {
        session_id: "opencode:ses_dlg",
        input: {},
      })).json()) as { output: string };
      // Reported once, as a dismissed dialog — and the page kept working.
      expect(log.output).toContain("alert: hello");
    } finally {
      svc.stop();
      page.stop(true);
      rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 120_000);
});
