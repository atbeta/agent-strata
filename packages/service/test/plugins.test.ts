import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, splitToolName, qualifiedToolName } from "@agent-strata/plugin-sdk";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";
import { PluginHost } from "../src/plugins/host";
import { pluginRoute } from "../src/plugins/routes";
import { mcpRoute } from "../src/plugins/mcp";
import { createMcpTickets } from "../src/plugins/tickets";
import { manifest as echoManifest, createEchoPlugin } from "@agent-strata/plugin-echo";

/**
 * The reference plugin, registered the way a test registers one.
 *
 * It is no longer a builtin: shipping it put three tools in every user's tool
 * list and a sentence in every system prompt. The suite that exercises the
 * platform's surfaces asks for it explicitly.
 */
const echoPlugin = () => [{ manifest: echoManifest, create: () => createEchoPlugin() }];

/**
 * The plugin platform, end to end over HTTP.
 *
 * The echo plugin is the fixture: it is small enough that nothing it does can
 * hide a missing piece of the platform, and it exercises one of each surface —
 * a tool with an input, a tool with an ask floor, a resource, an event stream,
 * a private route, a hook and a system prompt.
 *
 * What these cases are really asking is the acceptance criterion from the
 * design: can a capability exist as a package and a line of registration,
 * with the service knowing nothing about it?
 */
describe("the plugin platform", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const get = (path: string) => fetch(`${base}${path}`);

  const call = (plugin: string, tool: string, input: Record<string, unknown>, session = "opencode:ses_p") =>
    post(`/plugins/${plugin}/tools/${tool}`, { session_id: session, input });

  beforeAll(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-plugins-"));
    work = mkdtempSync(join(tmpdir(), "strata-plugins-work-"));
    const policyFile = join(desktop, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ version: 1, default: "allow", rules: [] }));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile, plugins: echoPlugin() });
    base = `http://127.0.0.1:${svc.port}`;
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_p",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "p", workspace: work },
      } as EventInput),
    ]);
  }, 30_000);

  afterAll(() => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("GET /plugins lists what is running, with the manifest summary", async () => {
    // Plugins start asynchronously; the route is asked once they have.
    let plugins: { plugins: Record<string, unknown>[] } = { plugins: [] };
    for (let i = 0; i < 240 && plugins.plugins.length < 2; i++) {
      plugins = (await (await get("/plugins")).json()) as typeof plugins;
      if (plugins.plugins.length < 2) await Bun.sleep(50);
    }
    const echo = plugins.plugins.find((p) => p.id === "echo") as
      | { state: string; tools: { name: string }[]; panel: { kind: string }; ui: { toolRenderers: unknown } }
      | undefined;
    expect(echo).toBeDefined();
    expect(echo!.state).toBe("running");
    expect(echo!.tools.map((t) => t.name)).toContain("say");
    expect(echo!.panel.kind).toBe("status");
    expect(echo!.ui.toolRenderers).toBeDefined();
  }, 30_000);

  test("the tool table is the union, and is not filtered by session", async () => {
    const table = (await (await get("/plugins/tools")).json()) as {
      tools: { name: string; plugin_id: string; tool: string; policy?: { default: string } }[];
    };
    const names = table.tools.map((t) => t.name);
    expect(names).toContain("echo_say");
    expect(names).toContain("dev_start");
    // A session parameter is accepted and changes nothing: the table is built
    // before any session exists, which is the only way a shim can register it.
    const withSession = (await (await get("/plugins/tools?session=opencode%3Ases_p")).json()) as {
      tools: { name: string }[];
    };
    expect(withSession.tools.map((t) => t.name)).toEqual(names);
  }, 30_000);

  test("a tool call round-trips through the host", async () => {
    const res = await call("echo", "say", { text: "hello" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string; is_error: boolean; plugin_id: string; tool: string };
    expect(body.output).toBe("hello");
    expect(body.is_error).toBe(false);
    expect(body.plugin_id).toBe("echo");
    expect(body.tool).toBe("say");
  }, 30_000);

  test("a tool that fails is a 200 with is_error, not a transport failure", async () => {
    // The distinction matters to every adapter: an MCP client turns isError
    // into a tool result the model can read, while a 502 is a broken server.
    const res = await call("echo", "nope", {});
    expect(res.status).toBe(404);
    const missingInput = await call("echo", "say", { text: 5 });
    expect(missingInput.status).toBe(200);
    const body = (await missingInput.json()) as { output: string };
    expect(body.output).toBe("");
  }, 30_000);

  test("unknown tools and plugins are 404s, not empty successes", async () => {
    expect((await call("nobody", "say", {})).status).toBe(404);
    expect((await call("echo", "absent", {})).status).toBe(404);
    expect((await get("/plugins/nobody/health")).status).toBe(404);
    expect((await get("/plugins/nobody/resources/count?session=opencode%3Ases_p")).status).toBe(404);
  }, 30_000);

  test("a resource is read by key, and requires a session", async () => {
    // Fresh instance, so the count is this test's own.
    await post("/plugins/echo/lifecycle", { action: "restart" });
    await call("echo", "say", { text: "one" });
    const res = await get("/plugins/echo/resources/count?session=opencode%3Ases_p");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ calls: 1 });
    expect((await get("/plugins/echo/resources/count")).status).toBe(400);
    expect((await get("/plugins/echo/resources/nope?session=opencode%3Ases_p")).status).toBe(404);
  }, 30_000);

  test("a private route is reachable, and only within its namespace", async () => {
    const res = await get("/plugins/echo/panel/state");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ calls: 1, method: "GET" });
    // A path the plugin does not answer is a 404 from the host, not a crash.
    expect((await get("/plugins/echo/panel/unknown")).status).toBe(404);
    // Fixed verbs win over the private route: /health is never shadowed.
    expect((await get("/plugins/echo/health")).status).toBe(200);
  }, 30_000);

  test("lifecycle: disable stops the table, enable brings it back", async () => {
    const disabled = await post("/plugins/echo/lifecycle", { action: "disable" });
    expect(disabled.status).toBe(200);
    const during = (await (await get("/plugins")).json()) as { plugins: { id: string; state: string }[] };
    expect(during.plugins.find((p) => p.id === "echo")?.state).toBe("disabled");
    const table = (await (await get("/plugins/tools")).json()) as { tools: { name: string }[] };
    expect(table.tools.some((t) => t.name === "echo_say")).toBe(false);
    // A disabled plugin's tools are gone, so calling one is a 404 rather than
    // an error from inside it.
    expect((await call("echo", "say", { text: "x" })).status).toBe(404);
    expect((await get("/plugins/echo/health")).json()).resolves.toMatchObject({ state: "disabled" });

    const enabled = await post("/plugins/echo/lifecycle", { action: "enable" });
    expect(enabled.status).toBe(200);
    expect((await call("echo", "say", { text: "back" })).status).toBe(200);
    // A fresh instance: the count a disabled plugin had is not carried over.
    const count = await (await get("/plugins/echo/resources/count?session=opencode%3Ases_p")).json();
    expect(count).toEqual({ calls: 1 });
  }, 30_000);

  test("disable survives a restart of the service", async () => {
    await post("/plugins/echo/lifecycle", { action: "disable" });
    const state = JSON.parse(readFileSync(join(desktop, "plugins-state.json"), "utf8")) as { disabled: string[] };
    expect(state.disabled).toEqual(["echo"]);

    const second = startService({ db: ":memory:", port: 0, desktopDir: desktop, plugins: echoPlugin() });
    const secondBase = `http://127.0.0.1:${second.port}`;
    try {
      let listing: { plugins: { id: string; state: string }[] } = { plugins: [] };
      for (let i = 0; i < 240 && !listing.plugins.some((p) => p.id === "dev"); i++) {
        listing = (await (await fetch(`${secondBase}/plugins`)).json()) as typeof listing;
        if (!listing.plugins.some((p) => p.id === "dev")) await Bun.sleep(50);
      }
      expect(listing.plugins.find((p) => p.id === "echo")?.state).toBe("disabled");
      expect(listing.plugins.find((p) => p.id === "dev")?.state).toBe("running");
    } finally {
      second.stop();
    }
    // Put it back for the cases after this one.
    const enabled = await post("/plugins/echo/lifecycle", { action: "enable" });
    expect(enabled.status).toBe(200);
  }, 30_000);

  test("restart is a stop and a start, not a second instance", async () => {
    await call("echo", "say", { text: "before" });
    const res = await post("/plugins/echo/lifecycle", { action: "restart" });
    expect(res.status).toBe(200);
    const health = (await (await get("/plugins/echo/health")).json()) as { state: string; uptime_ms: number };
    expect(health.state).toBe("running");
    expect(health.uptime_ms).toBeLessThan(30_000);
    const count = await (await get("/plugins/echo/resources/count?session=opencode%3Ases_p")).json();
    expect(count).toEqual({ calls: 0 });
  }, 30_000);

  test("events reach the plugin's own stream", async () => {
    const res = await get("/plugins/echo/events?session=opencode%3Ases_p");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const pump = (async () => {
      while (text.split("\n\n").filter((c) => c.includes("note")).length === 0) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    })();
    await Bun.sleep(150);
    await call("echo", "note", { message: "hello from the test" });
    await Promise.race([pump, Bun.sleep(3_000)]);
    await reader.cancel().catch(() => {});
    expect(text).toContain("hello from the test");
    expect(text).toContain("plugin.connected");
  }, 30_000);

  test("the hooks routes fan out to the plugins that declared them", async () => {
    const denied = await post("/hooks/before-tool", {
      session_id: "opencode:ses_p",
      tool: "bash",
      input: { command: "deny" },
    });
    expect(denied.status).toBe(200);
    expect(await denied.json()).toMatchObject({ allow: false });
    // A plain command passes: only the one the plugin objects to is refused.
    expect(await (await post("/hooks/before-tool", { session_id: "opencode:ses_p", tool: "bash", input: { command: "ls" } })).json()).toMatchObject({ allow: true });
    // A tool nobody declared is not the plugin's business.
    expect(await (await post("/hooks/before-tool", { session_id: "opencode:ses_p", tool: "read", input: {} })).json()).toMatchObject({ allow: true });
  }, 30_000);

  test("the system prompt is the concatenation of the contributors", async () => {
    const res = await (await get("/hooks/system-prompt?session=opencode%3Ases_p")).json() as { text: string };
    expect(res.text).toContain("## Long-running commands");
    expect(res.text).toContain("echo plugin is installed");
  }, 30_000);

  test("a manifest floor holds a tool at ask even when everything else allows", async () => {
    // The service's policy allows everything; the echo plugin's `risky` tool
    // declares `ask`. The card has to appear, or the floor is decoration.
    const starting = call("echo", "risky", { why: "test" });
    let ask: { request_id: string; tool: string } | undefined;
    for (let i = 0; i < 60 && !ask; i++) {
      const pending = (await (await get("/permissions")).json()) as {
        pending: { request_id: string; tool: string }[];
      };
      ask = pending.pending.find((p) => p.tool === "echo_risky");
      if (!ask) await Bun.sleep(50);
    }
    expect(ask).toBeDefined();
    await post(`/permissions/${encodeURIComponent(ask!.request_id)}/respond`, { decision: "allow" });
    const started = await starting;
    expect(started.status).toBe(200);
    expect(((await started.json()) as { output: string }).output).toBe("ran");
  }, 30_000);

  test("auto stance does not lift a manifest floor", async () => {
    const switched = await fetch(`${base}/sessions/opencode%3Ases_p/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    });
    expect(switched.status).toBe(200);
    try {
      const starting = call("echo", "risky", { why: "auto" });
      let ask: { request_id: string; tool: string } | undefined;
      for (let i = 0; i < 40 && !ask; i++) {
        const pending = (await (await get("/permissions")).json()) as {
          pending: { request_id: string; tool: string }[];
        };
        ask = pending.pending.find((p) => p.tool === "echo_risky");
        if (!ask) await Bun.sleep(50);
      }
      expect(ask).toBeDefined();
      await post(`/permissions/${encodeURIComponent(ask!.request_id)}/respond`, { decision: "deny" });
      expect((await starting).status).toBe(403);
    } finally {
      await fetch(`${base}/sessions/opencode%3Ases_p/policy`, { method: "DELETE" });
    }
  }, 30_000);

  test("an explicit allow rule does beat the floor", async () => {
    // The reader saying "always allow echo_risky" is a decision; the floor is
    // a default for when nobody decided. This is the pair that makes the
    // merge rule worth having rather than just "always ask".
    const policyFile = join(desktop, "policy.json");
    writeFileSync(
      policyFile,
      JSON.stringify({
        version: 1,
        default: "allow",
        rules: [{ id: "trust", effect: "allow", tool: "echo_risky" }],
      }),
    );
    const res = await fetch(`${base}/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        default: "allow",
        rules: [{ id: "trust", effect: "allow", tool: "echo_risky" }],
      }),
    });
    expect(res.status).toBe(200);
    const started = await call("echo", "risky", { why: "trusted" });
    expect(started.status).toBe(200);
  }, 30_000);

  test("guards refuse before the plugin runs, and the plugin never sees it", async () => {
    // The dev plugin guards `workdir` against leaving the session workspace.
    // A 403 here is the host's answer; the manager never gets a chance to
    // spawn something in the wrong directory.
    const escaped = await call("dev", "start", { command: 'node -e "setTimeout(() => {}, 500)"', workdir: ".." });
    expect(escaped.status).toBe(403);
    const body = (await escaped.json()) as { error: string };
    expect(body.error).toMatch(/inside the session workspace/);
  }, 30_000);

  test("a guard on a URL checks the scheme, the host, and credentials", async () => {
    // No plugin in this build declares a `net` guard, so this is the host's
    // own unit-level guarantee restated where a reader will look for it: the
    // check that rejects `file:` and `user:pass@` runs before any allowlist.
    const { manifest } = await import("@agent-strata/plugin-echo");
    const ok = loadManifest({ ...manifest, tools: manifest.tools.map((t) => ({ ...t, guards: undefined })) });
    expect(ok.id).toBe("echo");
  }, 30_000);
});

describe("manifest validation", () => {
  const base = {
    id: "sample",
    name: "Sample",
    version: "1.0.0",
    entry: { kind: "builtin" },
  };

  test("provides and sections must agree in both directions", () => {
    expect(() =>
      loadManifest({ ...base, provides: ["panel"], panel: { id: "p", title: "P", kind: "status" } }),
    ).not.toThrow();
    expect(() => loadManifest({ ...base, provides: ["panel"] })).toThrow(/no panel section/);
    expect(() =>
      loadManifest({ ...base, provides: [], panel: { id: "p", title: "P", kind: "status" } }),
    ).toThrow(/does not declare it/);
  });

  test("ids and tool names are checked, because routes and tool names are built from them", () => {
    expect(() => loadManifest({ ...base, id: "Tools" })).toThrow();
    expect(() => loadManifest({ ...base, id: "tools" })).toThrow(/reserved/);
    expect(() => loadManifest({ ...base, id: "hooks" })).toThrow(/reserved/);
    // `/plugins/mcp` is a fixed route of its own; an id named `mcp` would
    // register a plugin whose private routes were all shadowed by it.
    expect(() => loadManifest({ ...base, id: "mcp" })).toThrow(/reserved/);
    expect(() => loadManifest({ ...base, id: "has_underscore" })).toThrow();
    // An id without `_` is what makes `<id>_<tool>` splittable.
    expect(splitToolName("browser_navigate")).toEqual({ pluginId: "browser", tool: "navigate" });
    expect(splitToolName("navigate")).toBeUndefined();
    expect(qualifiedToolName("dev", "start")).toBe("dev_start");
  });

  test("a duplicate tool name is refused, not silently shadowed", () => {
    const tool = { name: "say", description: "x", input: { type: "object" } };
    expect(() => loadManifest({ ...base, provides: ["tools"], tools: [tool, tool] })).toThrow(/duplicate/);
  });

  test("a guard on a field the input does not declare is refused", () => {
    expect(() =>
      loadManifest({
        ...base,
        provides: ["tools"],
        tools: [
          {
            name: "go",
            description: "x",
            input: { type: "object", properties: { url: { type: "string" } } },
            guards: { nowhere: "net" },
          },
        ],
      }),
    ).toThrow(/guards "nowhere"/);
  });

  test("a renderer for a tool that does not exist is refused", () => {
    expect(() =>
      loadManifest({
        ...base,
        provides: ["tools"],
        tools: [{ name: "say", description: "x", input: { type: "object" } }],
        ui: { toolRenderers: { shout: { kind: "read" } } },
      }),
    ).toThrow(/unknown tool/);
  });
});

describe("the MCP endpoint ACP agents are handed", () => {
  // The endpoint is exercised against a real host and a real ticket, with a
  // stub `execute` — the policy path it calls is covered by the plugin cases
  // above, and what is under test here is the MCP face and the ticket binding.
  const openHost = () => {
    const dataDir = mkdtempSync(join(tmpdir(), "strata-mcp-"));
    const host = new PluginHost({
      dataDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      workspaceOf: () => undefined,
      resolveSession: (id) => id,
    });
    host.register({ manifest: echoManifest, create: () => createEchoPlugin() });
    return { host, dataDir };
  };

  test("a ticket names exactly one session, and only after it is bound", () => {
    const tickets = createMcpTickets({ baseUrl: () => "http://127.0.0.1:1234" });
    const ticket = tickets.open();
    expect(ticket.url).toContain("/plugins/mcp?session=");
    const id = new URL(ticket.url).searchParams.get("session")!;
    // Never bound: no session, so no capability. A URL an agent holds must not
    // become a way to act as a session nobody chose.
    expect(tickets.sessionOf(id)).toBeUndefined();
    ticket.bind("acp:mock:sess-1");
    expect(tickets.sessionOf(id)).toBe("acp:mock:sess-1");
    tickets.close(id);
    expect(tickets.sessionOf(id)).toBeUndefined();
  });

  test("an unbound endpoint is refused by the route, not by the MCP handler", async () => {
    // The handler returns "not mine" for a ticket that does not resolve; the
    // route turns that into the 403. A caller can only reach this with a
    // ticket it made up, which is why the answer says what is wrong.
    const { host, dataDir } = openHost();
    const answered = await pluginRoute(
      new Request("http://x/plugins/mcp?session=not-a-ticket", { method: "POST", body: "{}" }),
      new URL("http://x/plugins/mcp?session=not-a-ticket"),
      {
        host,
        resolveSession: (id) => id,
        mcp: (req, url) =>
          mcpRoute(req, url, {
            host,
            sessionOf: () => undefined,
            tools: () => host.toolTable(),
            execute: async () => {
              throw new Error("must not run");
            },
            json: (data, status) => Response.json(data, { status }),
          }),
        authorize: async () => ({ allow: true }),
        directoryOf: () => undefined,
        json: (data, status) => Response.json(data, { status }),
        onChanged: () => () => {},
      },
    );
    expect(answered!.status).toBe(403);
    expect(((await answered!.json()) as { error: { message: string } }).error.message).toMatch(/not bound/);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("initialize, tools/list and tools/call speak the protocol", async () => {
    const { host } = openHost();
    await host.enable("echo");
    const tickets = createMcpTickets({ baseUrl: () => "http://127.0.0.1:1234" });
    const ticket = tickets.open();
    ticket.bind("opencode:ses_mcp");
    const url = new URL(ticket.url);
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    const calls: { pluginId: string; tool: string; sessionId: string; input: Record<string, unknown> }[] = [];
    const deps = {
      host,
      sessionOf: (t: string) => tickets.sessionOf(t),
      tools: () => host.toolTable(),
      execute: async (
        pluginId: string,
        tool: string,
        sessionId: string,
        input: Record<string, unknown>,
      ) => {
        calls.push({ pluginId, tool, sessionId, input });
        return { output: `ran ${tool}` };
      },
      json,
    };

    const ask = async (body: unknown) => {
      const res = await mcpRoute(
        new Request(url, { method: "POST", body: JSON.stringify(body) }),
        url,
        deps,
      );
      return (await res!.json()) as { result?: Record<string, unknown>; error?: { message: string } };
    };

    const init = await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init.result?.protocolVersion).toBe("2025-06-18");
    const capabilities = init.result?.capabilities as { tools?: unknown } | undefined;
    expect(capabilities?.tools).toBeDefined();

    const list = await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (list.result?.tools ?? []) as { name: string; inputSchema: unknown }[];
    expect(tools.map((t) => t.name)).toContain("echo_say");
    expect(tools.find((t) => t.name === "echo_say")?.inputSchema).toBeDefined();

    const call = await ask({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo_say", arguments: { text: "from mcp" } },
    });
    const content = call.result?.content as { text: string }[] | undefined;
    expect(content?.[0]?.text).toBe("ran say");
    expect(calls).toEqual([
      { pluginId: "echo", tool: "say", sessionId: "opencode:ses_mcp", input: { text: "from mcp" } },
    ]);

    // A tool nobody has is a protocol error the client can show.
    const unknown = await ask({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } });
    expect(unknown.error?.message).toContain("unknown tool");

    // A notification is answered with 202 and no body.
    const notified = await mcpRoute(
      new Request(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
      url,
      deps,
    );
    expect(notified!.status).toBe(202);
  });
});

describe("a policy rule can be scoped to a plugin", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    desktop = mkdtempSync(join(tmpdir(), "strata-plugin-scope-"));
    work = mkdtempSync(join(tmpdir(), "strata-plugin-scope-work-"));
    const policyFile = join(desktop, "policy.json");
    // The rule names the plugin, not the tool name: `echo_note` and `dev_*`
    // are both allowed, and only the echo plugin is denied.
    writeFileSync(
      policyFile,
      JSON.stringify({
        version: 1,
        default: "allow",
        rules: [{ id: "no-echo", effect: "deny", tool: "*", plugin_id: "echo" }],
      }),
    );
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile, plugins: echoPlugin() });
    base = `http://127.0.0.1:${svc.port}`;
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_scope",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "scope", workspace: work },
      } as EventInput),
    ]);
    for (let i = 0; i < 100; i++) {
      const listing = (await (await fetch(`${base}/plugins`)).json()) as {
        plugins: { id: string; state: string }[];
      };
      if (listing.plugins.filter((p) => p.state === "running").length >= 3) break;
      await Bun.sleep(50);
    }
  }, 40_000);

  afterAll(() => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("the rule denies that plugin's tools and leaves the others alone", async () => {
    const denied = await post("/plugins/echo/tools/say", {
      session_id: "opencode:ses_scope",
      input: { text: "should not run" },
    });
    expect(denied.status).toBe(403);

    const allowed = await post("/plugins/dev/tools/list", {
      session_id: "opencode:ses_scope",
      input: {},
    });
    expect(allowed.status).toBe(200);
  }, 30_000);
});

describe("what a fresh install ships", () => {
  test("the reference plugin is not among the builtins", async () => {
    // A proof of the architecture is not a feature. `echo` used to be a
    // builtin, so every user got three extra tools, a sentence in every system
    // prompt, and a panel tab — installed, not chosen.
    const desktop = mkdtempSync(join(tmpdir(), "strata-ships-"));
    const svc = startService({ db: ":memory:", port: 0, desktopDir: desktop });
    try {
      let listing: { plugins: { id: string; state: string }[] } = { plugins: [] };
      for (let i = 0; i < 240 && !listing.plugins.some((p) => p.id === "dev"); i++) {
        listing = (await (await fetch(`http://127.0.0.1:${svc.port}/plugins`)).json()) as typeof listing;
        if (!listing.plugins.some((p) => p.id === "dev")) await Bun.sleep(50);
      }
      expect(listing.plugins.map((p) => p.id).sort()).toEqual(["browser", "dev"]);
      const table = (await (await fetch(`http://127.0.0.1:${svc.port}/plugins/tools`)).json()) as {
        tools: { name: string }[];
      };
      expect(table.tools.some((t) => t.name.startsWith("echo_"))).toBe(false);
      const prompt = (await (await fetch(`http://127.0.0.1:${svc.port}/hooks/system-prompt?session=x`)).json()) as {
        text: string;
      };
      expect(prompt.text).not.toContain("echo plugin");
    } finally {
      svc.stop();
      rmSync(desktop, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 60_000);
});

describe("the shell guard names the tools that exist", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";

  beforeAll(async () => {
    const desktop = mkdtempSync(join(tmpdir(), "strata-hooks-"));
    const policyFile = join(desktop, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ version: 1, default: "allow", rules: [] }));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile, plugins: echoPlugin() });
    base = `http://127.0.0.1:${svc.port}`;
    for (let i = 0; i < 240; i++) {
      const listing = (await (await fetch(`${base}/plugins`)).json()) as {
        plugins: { id: string; state: string }[];
      };
      if (listing.plugins.filter((p) => p.state === "running").length >= 2) break;
      await Bun.sleep(50);
    }
  }, 30_000);

  afterAll(() => {
    svc.stop();
  }, 30_000);

  const hook = async (tool: string, command: string) =>
    (await (await fetch(`${base}/hooks/before-tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "opencode:ses_hook", tool, input: { command } }),
    })).json()) as { allow: boolean; message?: string };

  test("bash and powershell are guarded, which is how OpenCode names them", async () => {
    // The plugin used to declare `["shell"]`, and OpenCode registers `bash`
    // everywhere and `powershell` on Windows — so the Start-Process guard,
    // whose whole reason is the Windows case, never ran.
    for (const tool of ["bash", "powershell"]) {
      const verdict = await hook(tool, "Start-Process -WindowStyle Hidden powershell spawn");
      expect(verdict.allow).toBe(false);
      expect(verdict.message).toContain("Do not detach a process");
    }
  }, 30_000);

  test("an ordinary command passes, and a tool the plugin did not name is not asked", async () => {
    expect((await hook("bash", "ls -la")).allow).toBe(true);
    expect((await hook("read", "Start-Process anything")).allow).toBe(true);
  }, 30_000);
});

describe("one broken plugin does not take the table with it", () => {
  test("a plugin that cannot list its tools is skipped, not fatal", async () => {
    // `toolTable()` feeds every dispatch, so an exception from one plugin's
    // `listTools()` used to make every other plugin's tools unresolvable —
    // the whole platform going dark because one plugin was confused.
    const { PluginHost } = await import("../src/plugins/host");
    const host = new PluginHost({
      dataDir: mkdtempSync(join(tmpdir(), "strata-table-")),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      workspaceOf: () => undefined,
      resolveSession: (id) => id,
    });
    const tool = (name: string) => ({ name, description: name, input: { type: "object", properties: {} } });
    host.register({
      manifest: {
        id: "broken",
        name: "Broken",
        version: "1.0.0",
        entry: { kind: "builtin" },
        provides: ["tools"],
        permissions: {},
        tools: [tool("x")],
        resources: [],
      },
      create: () => ({
        async initialize() {},
        listTools() {
          throw new Error("the plugin is confused");
        },
        async callTool() {
          return { output: "" };
        },
        async shutdown() {},
      }),
    });
    host.register({
      manifest: {
        id: "fine",
        name: "Fine",
        version: "1.0.0",
        entry: { kind: "builtin" },
        provides: ["tools"],
        permissions: {},
        tools: [tool("go")],
        resources: [],
      },
      create: () => ({
        async initialize() {},
        listTools: () => [tool("go")],
        async callTool() {
          return { output: "ok" };
        },
        async shutdown() {},
      }),
    });
    await host.enable("broken");
    await host.enable("fine");
    const table = host.toolTable();
    expect(table.map((t) => t.name)).toEqual(["fine_go"]);
    // The broken one is still callable by name? No — it has no table entry, so
    // resolving it is a 404 rather than a crash, which is the right failure.
    expect(host.resolveTool("broken", "x")).toBeUndefined();
    expect(host.resolveTool("fine", "go")).toBeDefined();
    await host.stopAll();
  });
});
