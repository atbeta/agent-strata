import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startService } from "../src/index";
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
 * An ACP session is handed its own MCP endpoint, and that endpoint serves the
 * plugin tools.
 *
 * This is the M1 acceptance criterion the design calls out explicitly: the
 * agent on the other side of ACP has to be able to *see and call* plugin
 * tools, without the adapter knowing what any of them are.
 *
 * The fixture agent echoes back what its `session/new` carried, so the shape
 * being asserted is the one that crossed the wire, not this client's idea of
 * it.
 */
const MOCK = fileURLToPath(new URL("../../adapter-acp/test/fixtures/mock-agent.ts", import.meta.url));

describe("ACP sessions and plugin tools", () => {
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

  beforeAll(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-acp-plugins-"));
    work = mkdtempSync(join(tmpdir(), "strata-acp-plugins-work-"));
    const policyFile = join(desktop, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ version: 1, default: "allow", rules: [] }));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile, plugins: echoPlugin() });
    base = `http://127.0.0.1:${svc.port}`;
  }, 30_000);

  afterAll(() => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("the session is opened with an MCP server naming this service", async () => {
    const connected = (await post("/connect", {
      backend: "acp",
      command: process.execPath,
      args: [MOCK],
      agentName: "mock",
      cwd: work,
      directory: work,
    }).then((r) => r.json())) as { id: string };

    const created = (await post("/sessions", { connection_id: connected.id, directory: work }).then((r) =>
      r.json(),
    )) as { id: string };
    expect(created.id.startsWith("acp:mock:")).toBe(true);

    // Ask the agent what it was handed. The answer lands in the transcript as
    // an assistant message.
    await post(`/sessions/${encodeURIComponent(created.id)}/prompt`, { parts: [{ type: "text", text: "mcp" }] });

    let text = "";
    for (let i = 0; i < 300 && !text.includes("strata"); i++) {
      const view = (await (await fetch(`${base}/sessions/${encodeURIComponent(created.id)}/view`)).json()) as {
        turns?: { assistant?: { content?: { type: string; text?: string }[] }[] }[];
      };
      text = (view.turns ?? [])
        .flatMap((turn) => turn.assistant ?? [])
        .flatMap((message) => message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      if (!text.includes("strata")) await Bun.sleep(100);
    }

    expect(text).toContain("/plugins/mcp");
    expect(text).toContain('"type":"http"');

    // The URL carries a ticket, not a session id: the agent holds it, and a
    // session id there would be a capability to act as that session.
    const servers = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as {
      type: string;
      name: string;
      url: string;
    }[];
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("strata");
    const ticket = new URL(servers[0]!.url).searchParams.get("session");
    expect(ticket).toBeTruthy();
    expect(ticket!.startsWith("acp:")).toBe(false);
  }, 90_000);

  test("the endpoint the agent was handed serves the plugin tool table", async () => {
    // Same path the ACP agent's MCP client would take: list, then call.
    const connected = (await post("/connect", {
      backend: "acp",
      command: process.execPath,
      args: [MOCK],
      agentName: "mock",
      cwd: work,
      directory: work,
    }).then((r) => r.json())) as { id: string };
    const created = (await post("/sessions", { connection_id: connected.id, directory: work }).then((r) =>
      r.json(),
    )) as { id: string };
    await post(`/sessions/${encodeURIComponent(created.id)}/prompt`, { parts: [{ type: "text", text: "mcp" }] });

    let url = "";
    for (let i = 0; i < 300 && !url; i++) {
      const view = (await (await fetch(`${base}/sessions/${encodeURIComponent(created.id)}/view`)).json()) as {
        turns?: { assistant?: { content?: { type: string; text?: string }[] }[] }[];
      };
      const text = (view.turns ?? [])
        .flatMap((turn) => turn.assistant ?? [])
        .flatMap((message) => message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      const match = /"url":"([^"]+)"/.exec(text);
      if (match) url = match[1]!;
      else await Bun.sleep(100);
    }
    expect(url).toContain("/plugins/mcp");

    const listed = (await (await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })).json()) as { result?: { tools: { name: string }[] } };
    const names = (listed.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("echo_say");
    expect(names).toContain("dev_start");

    // And a call through it reaches the plugin with this session attached.
    const called = (await (await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo_say", arguments: { text: "over mcp" } },
      }),
    })).json()) as { result?: { content: { text: string }[]; isError?: boolean } };
    expect(called.result?.isError).toBeFalsy();
    expect(called.result?.content[0]?.text).toBe("over mcp");
  }, 90_000);
});

/**
 * The same path with a token configured — which is every desktop launch.
 *
 * The cases above start a service without `apiToken`, so `tokenOk` answers
 * true for anything and a missing authorization hole stays invisible. That is
 * exactly how the endpoint shipped broken: a real ACP agent got the ticket URL
 * and every call was a 401, because `/plugins/mcp` was not among the paths
 * allowed to authenticate by URL.
 */
describe("the MCP endpoint when the service has a token", () => {
  const TOKEN = "s3cret-token";
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";

  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  beforeAll(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-acp-token-"));
    work = mkdtempSync(join(tmpdir(), "strata-acp-token-work-"));
    const policyFile = join(desktop, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ version: 1, default: "allow", rules: [] }));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile, apiToken: TOKEN, plugins: echoPlugin() });
    base = `http://127.0.0.1:${svc.port}`;
  }, 30_000);

  afterAll(() => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("the ticket URL works without a header, and a wrong ticket does not", async () => {
    const connected = (await post("/connect", {
      backend: "acp",
      command: process.execPath,
      args: [MOCK],
      agentName: "mock",
      cwd: work,
      directory: work,
    }, TOKEN).then((r) => r.json())) as { id: string };
    const created = (await post("/sessions", { connection_id: connected.id, directory: work }, TOKEN).then((r) =>
      r.json(),
    )) as { id: string };
    await post(`/sessions/${encodeURIComponent(created.id)}/prompt`, { parts: [{ type: "text", text: "mcp" }] }, TOKEN);

    let url = "";
    for (let i = 0; i < 300 && !url; i++) {
      const view = (await (await fetch(`${base}/sessions/${encodeURIComponent(created.id)}/view`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })).json()) as { turns?: { assistant?: { content?: { type: string; text?: string }[] }[] }[] };
      const text = (view.turns ?? [])
        .flatMap((turn) => turn.assistant ?? [])
        .flatMap((message) => message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      const match = /"url":"([^"]+)"/.exec(text);
      if (match) url = match[1]!;
      else await Bun.sleep(100);
    }
    expect(url).toContain("/plugins/mcp");

    // No `authorization` header: this is what the agent's MCP client sends.
    const listed = (await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })).json() as Promise<{ result?: { tools: { name: string }[] } }>;
    const names = ((await listed).result?.tools ?? []).map((t) => t.name);
    expect(names).toContain("echo_say");

    const called = (await (await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo_say", arguments: { text: "with a token configured" } },
      }),
    })).json()) as { result?: { content: { text: string }[]; isError?: boolean } };
    expect(called.result?.isError).toBeFalsy();
    expect(called.result?.content[0]?.text).toBe("with a token configured");

    // A ticket that is not in the registry is refused by the route, not
    // accepted because the path was exempted from the token check.
    const bogus = await fetch(url.replace(/session=[^&]+/, "session=not-a-ticket"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    expect(bogus.status).toBe(403);
  }, 120_000);
});
