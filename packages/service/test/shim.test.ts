import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
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
 * The shim is plain JavaScript on purpose — it is installed where
 * `@opencode-ai/plugin` and `zod` do not resolve, so it imports nothing and
 * declares nothing. That makes it untyped from here, and the honest place to
 * say what it is is one boundary rather than an `any` per call site.
 */
interface Tool {
  description: string;
  args: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    context: { sessionID: string; abort?: AbortSignal },
  ): Promise<string | { output: string }>;
}

interface ShimPlugin {
  tool: Record<string, Tool>;
  "tool.execute.before": (
    input: { tool: string; sessionID: string },
    output: { args?: Record<string, unknown> },
  ) => Promise<void>;
  "experimental.chat.system.transform": (
    input: { sessionID?: string },
    output: { system: string[] },
  ) => Promise<void>;
}

async function loadShim(): Promise<ShimPlugin> {
  // The path is built at run time so the compiler does not try to include a
  // file outside this project — it is JavaScript that is not part of this
  // build, and the interface above is the contract the test holds it to.
  const specifier = ["..", "..", "..", "plugins", "strata-shim.ts"].join("/");
  const module = (await import(/* @vite-ignore */ specifier)) as { default: () => Promise<ShimPlugin> };
  return module.default();
}

/**
 * The OpenCode shim, loaded the way OpenCode loads it.
 *
 * This file is the boundary the whole design rests on: every OpenCode on the
 * machine runs it, including ones that never heard of this app. So the two
 * properties that matter are tested against the real module rather than a
 * copy of its logic — it registers nothing without a service, and with one it
 * is a pure forwarder.
 */
type Shim = ShimPlugin;

const originalUrl = process.env.STRATA_SERVICE_URL;
const originalToken = process.env.STRATA_API_TOKEN;

/** Drop the environment the shim reads, so the "no shell" path is the real one. */
function withoutService() {
  delete process.env.STRATA_SERVICE_URL;
  delete process.env.STRATA_API_TOKEN;
}

function withService(url: string, token?: string) {
  process.env.STRATA_SERVICE_URL = url;
  if (token) process.env.STRATA_API_TOKEN = token;
  else delete process.env.STRATA_API_TOKEN;
}

describe("the shim without a service", () => {
  test("registers no tools and stands out of the way", async () => {
    withoutService();
    const plugin: Shim = await loadShim();

    // No table, no tools. A tool that answers "the shell is not running" is
    // worse than no tool: the model learns a name that never works.
    expect(Object.keys(plugin.tool)).toEqual([]);

    // A guard with nothing to offer would block work the reader asked for.
    const args = { command: "Start-Process -WindowStyle Hidden foo" };
    await expect(
      plugin["tool.execute.before"]({ tool: "shell", sessionID: "ses_x" }, { args }),
    ).resolves.toBeUndefined();

    // Nothing contributed, nothing appended.
    const system: string[] = [];
    await plugin["experimental.chat.system.transform"]({ sessionID: "ses_x" }, { system });
    expect(system).toEqual([]);
  }, 30_000);
});

describe("the shim with a service", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";

  beforeAll(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-shim-"));
    work = mkdtempSync(join(tmpdir(), "strata-shim-work-"));
    const policyFile = join(desktop, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ version: 1, default: "allow", rules: [] }));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile, plugins: echoPlugin() });
    base = `http://127.0.0.1:${svc.port}`;
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_shim",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "shim", workspace: work },
      } as EventInput),
    ]);
  }, 30_000);

  afterAll(() => {
    svc.stop();
    if (originalUrl === undefined) delete process.env.STRATA_SERVICE_URL;
    else process.env.STRATA_SERVICE_URL = originalUrl;
    if (originalToken === undefined) delete process.env.STRATA_API_TOKEN;
    else process.env.STRATA_API_TOKEN = originalToken;
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("the tool table arrives as OpenCode tools, one per plugin tool", async () => {
    // The plugin set starts asynchronously; wait for it, because a table read
    // that raced the start is exactly the empty table the shim must tolerate.
    for (let i = 0; i < 300; i++) {
      const listing = (await (await fetch(`${base}/plugins`)).json()) as {
        plugins: { id: string; state: string }[];
      };
      if (listing.plugins.filter((p) => p.state === "running").length >= 3) break;
      await Bun.sleep(50);
    }
    withService(base);
    const plugin: Shim = await loadShim();
    const names = Object.keys(plugin.tool);
    expect(names).toContain("dev_start");
    expect(names).toContain("echo_say");
    expect(names).toContain("browser_navigate");
    // Every registered tool carries a description OpenCode can show and an
    // args object it can validate against.
    for (const name of names) {
      const tool = plugin.tool[name]!;
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.args).toBe("object");
    }
  }, 60_000);

  test("execute forwards the session and the input, and returns the plugin's text", async () => {
    withService(base);
    const plugin: Shim = await loadShim();
    const say = plugin.tool["echo_say"]!;
    const answer = await say.execute({ text: "through the shim" }, { sessionID: "opencode:ses_shim" });
    expect(answer).toBe("through the shim");
  }, 60_000);

  test("a tool that fails comes back as the plugin's message, not a crash", async () => {
    withService(base);
    const plugin: Shim = await loadShim();
    const start = plugin.tool["dev_start"]!;
    // A session with no workspace cannot run a command; the reason is what the
    // model needs to read, and it must arrive as a string.
    const answer = await start.execute({ command: "true" }, { sessionID: "opencode:no-workspace" });
    expect(typeof answer).toBe("string");
    expect(answer).toMatch(/workspace/);
  }, 60_000);

  test("the before-tool hook forwards the plugin's refusal", async () => {
    withService(base);
    const plugin: Shim = await loadShim();
    const before = plugin["tool.execute.before"];

    // The echo plugin refuses a shell command literally called "deny".
    let message = "";
    try {
      await before({ tool: "bash", sessionID: "opencode:ses_shim" }, { args: { command: "deny" } });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/echo plugin refused/);

    // And an ordinary command passes.
    await expect(
      before({ tool: "bash", sessionID: "opencode:ses_shim" }, { args: { command: "ls" } }),
    ).resolves.toBeUndefined();
  }, 60_000);

  test("the system prompt is appended once, not once per call", async () => {
    withService(base);
    const plugin: Shim = await loadShim();
    const system: string[] = [];
    await plugin["experimental.chat.system.transform"]({ sessionID: "opencode:ses_shim" }, { system });
    expect(system.join("\n")).toContain("## Long-running commands");

    const afterFirst = [...system];
    await plugin["experimental.chat.system.transform"]({ sessionID: "opencode:ses_shim" }, { system });
    // A transform that runs twice in one request must not double the guidance.
    expect(system).toEqual(afterFirst);
  }, 60_000);

  test("a service that cannot answer fails open on the hook", async () => {
    // Between the check and the call the service can go away. The call itself
    // will report that; the guard must not turn it into a confusing refusal.
    withService("http://127.0.0.1:1");
    const plugin: Shim = await loadShim();
    await expect(
      plugin["tool.execute.before"]({ tool: "bash", sessionID: "opencode:ses_shim" }, { args: { command: "deny" } }),
    ).resolves.toBeUndefined();
  }, 30_000);
});
