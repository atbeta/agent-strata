import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";

/**
 * The dev commands a session leaves running, over the wire.
 *
 * The report these answers came from was not about the manager: it was about
 * what the agent was told. A stop that says "stopped" while the port is still
 * held is the worst answer there is — the next command collides with it and
 * nobody knows why — so the stop route has to report what is left, and the
 * list route has to keep the record of a command that is long gone.
 */
describe("dev commands over the service", () => {
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

  beforeAll(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-devsvc-"));
    work = mkdtempSync(join(tmpdir(), "strata-devsvc-work-"));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop });
    base = `http://127.0.0.1:${svc.port}`;
    // The command runs in the session's workspace, so the session needs one.
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_x",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "x", workspace: work },
      } as EventInput),
    ]);
  }, 30_000);

  afterAll(() => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("a started command is listed, its logs are readable, and its port answers", async () => {
    const script = join(work, "server.cjs");
    writeFileSync(
      script,
      `const http = require("http");\n` +
        `http.createServer((q, s) => s.end("ok")).listen(45991, "::1");\n` +
        `console.log("listening on 45991");\n`,
    );

    const started = await post("/dev", {
      session_id: "opencode:ses_x",
      command: `node "${script}"`,
      port: 45991,
      wait_ms: 20_000,
    });
    expect(started.status).toBe(200);
    const info = (await started.json()) as { id: string; state: string; ready: string; port: number };
    expect(info.state).toBe("running");
    // The port answered, and the answer says how long it took.
    expect(info.ready).toBe("yes");
    expect(info.port).toBe(45991);

    // The list has it, as running.
    const list = (await (await get("/dev?session=opencode%3Ases_x")).json()) as {
      processes: { id: string; state: string }[];
    };
    expect(list.processes.find((p) => p.id === info.id)?.state).toBe("running");

    // The logs are readable.
    const logs = (await (await get(`/dev/${info.id}/logs`)).json()) as { lines: { text: string }[] };
    expect(logs.lines.some((l) => l.text.includes("listening on 45991"))).toBe(true);

    // A second command on the same port is refused, with a reason.
    const second = await post("/dev", {
      session_id: "opencode:ses_x",
      command: `node "${script}"`,
      port: 45991,
    });
    expect(second.status).toBe(400);
    const refusal = (await second.json()) as { error: string };
    expect(refusal.error).toMatch(/already/);

    // The stop says what is true: the tree is gone and the port is free.
    const stopped = await post(`/dev/${info.id}/stop`, {});
    expect(stopped.status).toBe(200);
    const verdict = (await stopped.json()) as {
      ok: boolean;
      clean: boolean;
      residual: number[];
      port: number;
      port_free: boolean;
    };
    expect(verdict.ok).toBe(true);
    expect(verdict.clean).toBe(true);
    expect(verdict.residual).toEqual([]);
    expect(verdict.port_free).toBe(true);

    // The record stays, and says it was stopped.
    const after = (await (await get("/dev?session=opencode%3Ases_x")).json()) as {
      processes: { id: string; state: string }[];
    };
    expect(after.processes.find((p) => p.id === info.id)?.state).toBe("stopped");
  }, 30_000);

  test("the table of what ran survives the service that ran it", () => {
    // The service writes down what it is running, because a service that is
    // killed outright cannot run its own cleanup. The file is the only thing
    // the next run has to work from.
    const file = join(desktop, "dev-processes.json");
    const table = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      processes: { id: string; state: string }[];
    };
    expect(table.version).toBe(2);
    expect(table.processes.length).toBeGreaterThan(0);
    expect(table.processes.some((row) => row.state === "stopped")).toBe(true);
  }, 30_000);

  test("a stop for a command nobody knows is not a success", async () => {
    const stopped = await post("/dev/dev_missing/stop", {});
    expect(stopped.status).toBe(404);
  }, 30_000);
});
