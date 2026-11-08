import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import type { PluginManifest } from "@agent-strata/plugin-sdk";
import { startService } from "../src/index";

/**
 * The fallback join the design asks for (§4.3).
 *
 * An adapter that cannot name the backend's call id — the OpenCode shim on a
 * release whose tool context has no id — still expects its progress to land on
 * the row the reader is watching. The host resolves the session's pending call
 * before dispatching, so a progress event that arrives with no `call_id` still
 * reaches the UI attached to the right row.
 *
 * Without this the UI had nothing to key on and dropped the event, so "tool
 * rows show progress" was true only on backends that happen to name their
 * call ids.
 */
const manifest: PluginManifest = {
  id: "talker",
  name: "Talker",
  version: "1.0.0",
  entry: { kind: "builtin" },
  provides: ["tools"],
  permissions: {},
  tools: [{ name: "go", description: "goes", input: { type: "object", properties: {} } }],
  resources: [],
};

describe("progress without a call id", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";

  beforeAll(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-join-"));
    work = mkdtempSync(join(tmpdir(), "strata-join-work-"));
    const policyFile = join(desktop, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ version: 1, default: "allow", rules: [] }));
    svc = startService({
      db: ":memory:",
      port: 0,
      desktopDir: desktop,
      policyFile,
      plugins: [
        {
          manifest,
          create: () => ({
            async initialize() {},
            listTools: () => [{ name: "go", description: "goes", input: { type: "object" } }],
            async callTool(req) {
              req.progress?.({ message: "working", percent: 50 });
              return { output: "done" };
            },
            async shutdown() {},
          }),
        },
      ],
    });
    base = `http://127.0.0.1:${svc.port}`;
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_join",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "join", workspace: work },
      } as EventInput),
      // The call the agent is waiting on, written by the adapter as usual.
      makeEvent({
        session_id: "opencode:ses_join",
        type: "tool.call",
        ts: "2026-01-01T00:00:01Z",
        source: { backend: "opencode" },
        data: { turn_id: "t1", call_id: "call-from-backend", tool: "talker_go", input: {} },
      } as EventInput),
    ]);
  }, 30_000);

  afterAll(() => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  const collectProgress = async (during: () => Promise<void>, budgetMs = 5_000) => {
    const frames: { type?: string; call_id?: string; tool?: string; message?: string }[] = [];
    const res = await fetch(`${base}/stream`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const pump = (async () => {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const chunks = buffered.split("\n\n");
        buffered = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const data = chunk.replace(/^data: /, "").trim();
          if (!data) continue;
          try {
            const frame = JSON.parse(data) as (typeof frames)[number];
            if (frame.type === "tool.progress") frames.push(frame);
          } catch {
            // a heartbeat
          }
        }
        if (frames.length > 0) break;
      }
    })();
    // Let the stream attach before the call, or the frame has nowhere to go.
    await Bun.sleep(150);
    await during();
    await Promise.race([pump, Bun.sleep(budgetMs)]);
    await reader.cancel().catch(() => {});
    return frames;
  };

  test("the frame carries the session's pending call, not nothing", async () => {
    const frames = await collectProgress(async () => {
      const called = await fetch(`${base}/plugins/talker/tools/go`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // No `call_id`: the shape the shim produces on a backend without one.
        body: JSON.stringify({ session_id: "opencode:ses_join", input: {} }),
      });
      expect(called.status).toBe(200);
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.call_id).toBe("call-from-backend");
    expect(frames[0]!.tool).toBe("go");
    expect(frames[0]!.message).toBe("working");
  }, 40_000);

  test("an explicit call id wins over the fallback", async () => {
    // A backend that does name its call must not be overridden by whatever
    // else happens to be pending in the session.
    const frames = await collectProgress(async () => {
      await fetch(`${base}/plugins/talker/tools/go`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "opencode:ses_join", call_id: "explicit-call", input: {} }),
      });
    });
    expect(frames[0]!.call_id).toBe("explicit-call");
  }, 40_000);

  test("with no pending call the event is still sent, just unjoined", async () => {
    // A tool with no call row (a retry, a session the adapter has not written
    // for yet) must not make progress fail; it simply has no row to attach to.
    const frames = await collectProgress(async () => {
      await fetch(`${base}/plugins/talker/tools/go`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: "opencode:ses_other", input: {} }),
      });
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.call_id).toBeUndefined();
  }, 40_000);
});
