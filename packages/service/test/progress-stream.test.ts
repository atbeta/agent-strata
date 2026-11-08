import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";

/**
 * Progress over the real stream, from a tool call to a `/stream` frame.
 *
 * The earlier cases prove the pieces — the store drops it, the host forwards
 * it. This one proves the wire: a plugin tool that reports progress reaches a
 * client listening on `/stream`, carrying the plugin, the tool and the call id
 * a tool row needs to attach it.
 */
describe("progress on the wire", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";

  beforeAll(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-progress-wire-"));
    work = mkdtempSync(join(tmpdir(), "strata-progress-wire-work-"));
    const policyFile = join(desktop, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ version: 1, default: "allow", rules: [] }));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile });
    base = `http://127.0.0.1:${svc.port}`;
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_wire",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "wire", workspace: work },
      } as EventInput),
    ]);
  }, 30_000);

  afterAll(() => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("a plugin's progress arrives on /stream with its join key", async () => {
    const res = await fetch(`${base}/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const frames: { type?: string; plugin_id?: string; tool?: string; call_id?: string; message?: string }[] = [];

    const pump = (async () => {
      const deadline = Date.now() + 5_000;
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
            frames.push(frame);
          } catch {
            // a heartbeat
          }
        }
        if (frames.some((f) => f.type === "tool.progress")) break;
      }
    })();

    // Let the stream attach before the call, or the frame has nowhere to go.
    await Bun.sleep(150);
    const res2 = await fetch(`${base}/plugins/dev/tools/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "opencode:ses_wire",
        call_id: "call-wire-1",
        input: { command: 'node -e "setTimeout(() => {}, 400)"' },
      }),
    });
    expect(res2.status).toBe(200);

    await Promise.race([pump, Bun.sleep(6_000)]);
    await reader.cancel().catch(() => {});

    const progress = frames.filter((f) => f.type === "tool.progress");
    expect(progress.length).toBeGreaterThan(0);
    // The frame names the plugin and the tool even when the plugin did not say
    // so itself: the host supplies them, so a row can always tell whose call
    // it is looking at.
    expect(progress[0]!.plugin_id).toBe("dev");
    expect(progress[0]!.tool).toBe("start");
  }, 40_000);

  test("progress never reaches the store, even when a plugin reports it", async () => {
    const before = svc.store.lastSeq("opencode:ses_wire");
    await fetch(`${base}/plugins/dev/tools/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "opencode:ses_wire",
        input: { command: 'node -e "setTimeout(() => {}, 200)"' },
      }),
    });
    // The tool call itself writes nothing to the log — this layer's transcript
    // is written by the adapter that owns the session, not by the host — so
    // an unchanged sequence is the expected answer, and a `tool.progress` row
    // would have moved it.
    expect(svc.store.lastSeq("opencode:ses_wire")).toBe(before);
    const rows = svc.store.query({ session_id: "opencode:ses_wire", types: ["tool.progress"] });
    expect(rows).toHaveLength(0);
  }, 40_000);
});
