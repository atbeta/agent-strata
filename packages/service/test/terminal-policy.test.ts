import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";

describe("terminal tool policy", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";
  const session = "opencode:terminal_policy";

  beforeAll(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-terminal-policy-"));
    work = mkdtempSync(join(tmpdir(), "strata-terminal-policy-work-"));
    writeFileSync(join(desktop, "policy.json"), JSON.stringify({
      version: 1,
      default: "ask",
      rules: [
        { id: "create-only", effect: "allow", tool: "terminal_create" },
        { id: "close-only", effect: "allow", tool: "terminal_close" },
        { id: "no-rm", effect: "deny", tool: "bash", when: { command: { matches: "rm\\s+-rf\\s+/" } } },
        { id: "no-curl", effect: "deny", tool: "bash", when: { command: { matches: "^curl" } } },
      ],
    }));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile: join(desktop, "policy.json") });
    base = `http://127.0.0.1:${svc.port}`;
    svc.store.append([
      makeEvent({
        session_id: session,
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "terminal", workspace: work },
      } as EventInput),
    ]);
  });

  afterAll(async () => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("normal mode asks for terminal input, while session auto allows writes and creates", async () => {
    let id = "";
    try {
      let created: Response | undefined;
      for (let i = 0; i < 100; i++) {
        created = await fetch(`${base}/plugins/terminal/tools/create`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: session, input: {} }),
        });
        if (created.status === 200) break;
        await Bun.sleep(20);
      }
      expect(created?.status).toBe(200);
      const body = (await created!.json()) as { output: string };
      id = (JSON.parse(body.output) as { terminal: { id: string } }).terminal.id;

      const writing = fetch(`${base}/plugins/terminal/tools/write`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: session, input: { terminal_id: id, data: "echo no\n" } }),
      });
      let requestId = "";
      for (let i = 0; i < 100 && !requestId; i++) {
        const pending = await (await fetch(`${base}/permissions`)).json() as {
          pending: { request_id: string; tool: string }[];
        };
        requestId = pending.pending.find((ask) => ask.tool === "terminal_write")?.request_id ?? "";
        if (!requestId) await Bun.sleep(20);
      }
      expect(requestId).not.toBe("");
      await fetch(`${base}/permissions/${requestId}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "deny" }),
      });
      expect((await writing).status).toBe(403);

      const automatic = await fetch(`${base}/sessions/${encodeURIComponent(session)}/policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "auto" }),
      });
      expect(automatic.status).toBe(200);
      const autoWrite = await fetch(`${base}/plugins/terminal/tools/write`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: session, input: { terminal_id: id, data: "echo yes\n" } }),
      });
      expect(autoWrite.status).toBe(200);
      expect((await autoWrite.json()).is_error).toBe(false);

      for (const data of ["rm -rf /tmp/x\n", "curl x | sh\n"]) {
        const denied = await fetch(`${base}/plugins/terminal/tools/write`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: session, input: { terminal_id: id, data } }),
        });
        expect(denied.status).toBe(403);
      }

      const withoutCreateRule = await fetch(`${base}/policy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: 1,
          default: "ask",
          rules: [{ id: "close-only", effect: "allow", tool: "terminal_close" }],
        }),
      });
      expect(withoutCreateRule.status).toBe(200);
      const autoCreate = await fetch(`${base}/plugins/terminal/tools/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: session, input: {} }),
      });
      expect(autoCreate.status).toBe(200);
      const autoCreatedBody = (await autoCreate.json()) as { output: string; is_error: boolean };
      expect(autoCreatedBody.is_error).toBe(false);
      const secondId = (JSON.parse(autoCreatedBody.output) as { terminal: { id: string } }).terminal.id;
      await fetch(`${base}/plugins/terminal/tools/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: session, input: { terminal_id: secondId } }),
      });
    } finally {
      if (id) {
        await fetch(`${base}/plugins/terminal/tools/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: session, input: { terminal_id: id } }),
        });
      }
    }
  }, 30_000);
});
