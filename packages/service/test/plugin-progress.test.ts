import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";
import { manifest as echoManifest, createEchoPlugin } from "@agent-strata/plugin-echo";

/** The reference plugin, asked for explicitly — it is not a builtin. */
const echoPlugin = () => [{ manifest: echoManifest, create: () => createEchoPlugin() }];

/**
 * Progress is live-only.
 *
 * The design's constraint is that adding a progress event must not make old
 * logs unreadable: it is in the schema, it is in `EVENT_DATA_CLASS` so the
 * tables stay exhaustive, and it never reaches the store. These cases check
 * the two halves that can be observed: the store refuses it, and a plugin's
 * `progress()` reaches `/stream` with the join key attached.
 */
describe("tool progress", () => {
  let svc: ReturnType<typeof startService>;
  let desktop = "";
  let work = "";

  beforeAll(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-progress-"));
    work = mkdtempSync(join(tmpdir(), "strata-progress-work-"));
    const policyFile = join(desktop, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ version: 1, default: "allow", rules: [] }));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile, plugins: echoPlugin() });
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

  test("the store drops a progress event instead of writing it", () => {
    const before = svc.store.lastSeq("opencode:ses_p");
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_p",
        type: "tool.progress",
        source: { backend: "desktop" },
        data: { call_id: "c1", message: "halfway", percent: 50 },
      } as EventInput),
    ]);
    expect(svc.store.lastSeq("opencode:ses_p")).toBe(before);
  }, 30_000);

  test("a plugin's progress reaches the stream, with the call it belongs to", async () => {
    // The echo plugin's `note` tool emits one event; the host turns it into a
    // frame on the plugin's stream. The service-level guarantee under test is
    // narrower: `onProgress` is wired and reaches subscribers.
    const events: { type?: string; message?: string; call_id?: string }[] = [];
    const { PluginHost } = await import("../src/plugins/host");
    const host = new PluginHost({
      dataDir: desktop,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      workspaceOf: () => work,
      resolveSession: (id) => id,
      onProgress: (progress) => events.push({ type: "tool.progress", message: progress.message, call_id: progress.call_id }),
    });
    const { createEchoPlugin, manifest } = await import("@agent-strata/plugin-echo");
    // Wrap the plugin so one call reports progress before answering.
    const base = createEchoPlugin();
    host.register({
      manifest,
      create: () => ({
        ...base,
        async callTool(req) {
          req.progress?.({ message: "working", percent: 40 });
          return base.callTool(req);
        },
      }),
    });
    await host.enable("echo");
    const result = await host.callTool("echo", "say", {
      callId: "call-1",
      sessionId: "opencode:ses_p",
      input: { text: "hi" },
      signal: new AbortController().signal,
    });
    expect(result.output).toBe("hi");
    expect(events).toEqual([{ type: "tool.progress", message: "working", call_id: "call-1" }]);
    await host.stopAll();
  }, 30_000);

  test("a timeout aborts the call and reports it as interrupted", async () => {
    const { PluginHost } = await import("../src/plugins/host");
    const host = new PluginHost({
      dataDir: desktop,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      workspaceOf: () => work,
      resolveSession: (id) => id,
    });
    host.register({
      manifest: {
        id: "slow",
        name: "Slow",
        version: "1.0.0",
        entry: { kind: "builtin" },
        provides: ["tools"],
        permissions: {},
        tools: [
          {
            name: "wait",
            description: "waits",
            input: { type: "object", properties: {} },
            timeout_ms: 120,
          },
        ],
        resources: [],
      },
      create: () => ({
        async initialize() {},
        listTools: () => [{ name: "wait", description: "waits", input: { type: "object" } }],
        async callTool(req) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          void req.signal;
          return { output: "finished" };
        },
        async shutdown() {},
      }),
    });
    await host.enable("slow");
    const started = Date.now();
    let message = "";
    try {
      await host.callTool("slow", "wait", {
        sessionId: "opencode:ses_p",
        input: {},
        signal: new AbortController().signal,
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/timed out after 120ms/);
    expect(Date.now() - started).toBeLessThan(4_000);
    await host.stopAll();
  }, 30_000);

  test("a caller's abort reaches the plugin as a signal", async () => {
    const { PluginHost } = await import("../src/plugins/host");
    const host = new PluginHost({
      dataDir: desktop,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      workspaceOf: () => work,
      resolveSession: (id) => id,
    });
    let sawAbort = false;
    host.register({
      manifest: {
        id: "listener",
        name: "Listener",
        version: "1.0.0",
        entry: { kind: "builtin" },
        provides: ["tools"],
        permissions: {},
        tools: [{ name: "listen", description: "listens", input: { type: "object", properties: {} } }],
        resources: [],
      },
      create: () => ({
        async initialize() {},
        listTools: () => [{ name: "listen", description: "listens", input: { type: "object" } }],
        async callTool(req) {
          await new Promise<void>((resolve) => {
            req.signal.addEventListener("abort", () => {
              sawAbort = true;
              resolve();
            });
          });
          return { output: "cancelled" };
        },
        async shutdown() {},
      }),
    });
    await host.enable("listener");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    // Cancellation is reported to the caller as an interruption; the plugin
    // sees the same abort through its signal, which is what this case checks.
    let message = "";
    try {
      await host.callTool("listener", "listen", {
        sessionId: "opencode:ses_p",
        input: {},
        signal: controller.signal,
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toBe("interrupted");
    expect(sawAbort).toBe(true);
    await host.stopAll();
  }, 30_000);
});
