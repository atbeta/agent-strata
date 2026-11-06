import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // These cases are about process management, not permissions. Give the
    // service an explicit allow policy so no card is waiting for an answer;
    // the policy cases below start their own services.
    const policyFile = join(desktop, "policy.json");
    writeFileSync(policyFile, JSON.stringify({ version: 1, default: "allow", rules: [] }));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile });
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

  test("a finished record can be deleted, a running one cannot", async () => {
    const finished = await post("/dev", {
      session_id: "opencode:ses_x",
      command: "node -e \"setTimeout(() => {}, 500)\"",
    });
    const info = (await finished.json()) as { id: string };
    await post(`/dev/${info.id}/stop`, {});
    const removed = await fetch(`${base}/dev/${info.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    // The id is gone; a second delete cannot pretend otherwise.
    expect((await fetch(`${base}/dev/${info.id}`, { method: "DELETE" })).status).toBe(404);

    const running = await post("/dev", {
      session_id: "opencode:ses_x",
      command: "node -e \"setTimeout(() => {}, 30000)\"",
    });
    const live = (await running.json()) as { id: string };
    try {
      const refused = await fetch(`${base}/dev/${live.id}`, { method: "DELETE" });
      expect(refused.status).toBe(400);
      // The record is the only handle that can stop the process; dropping it
      // while the process is alive would leave a server on a port with no name.
      expect(((await refused.json()) as { error: string }).error).toMatch(/still running/);
    } finally {
      await post(`/dev/${live.id}/stop`, {});
    }
  }, 30_000);

  test("the workspace is the session's, whatever the caller says", async () => {
    // A caller that could name a directory would be a caller that could
    // leave the project. The path in the body is ignored: the session's
    // workspace is the answer.
    const elsewhere = mkdtempSync(join(tmpdir(), "strata-devsvc-elsewhere-"));
    try {
      const started = await post("/dev", {
        session_id: "opencode:ses_x",
        command: "node -e \"setTimeout(() => {}, 500)\"",
        cwd: elsewhere,
      });
      expect(started.status).toBe(200);
      const info = (await started.json()) as { id: string; cwd: string };
      expect(info.cwd).toBe(work);

      const stopped = await post(`/dev/${info.id}/stop`, {});
      expect(stopped.status).toBe(200);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 30_000);

  test("workdir runs inside the workspace and cannot leave it", async () => {
    const child = join(work, "web");
    mkdirSync(child);
    const started = await post("/dev", {
      session_id: "opencode:ses_x",
      command: "node -e \"setTimeout(() => {}, 500)\"",
      workdir: "web",
    });
    expect(started.status).toBe(200);
    const info = (await started.json()) as { id: string; cwd: string };
    expect(info.cwd).toBe(child);
    await post(`/dev/${info.id}/stop`, {});

    const escaped = await post("/dev", {
      session_id: "opencode:ses_x",
      command: "node -e \"setTimeout(() => {}, 500)\"",
      workdir: "..",
    });
    expect(escaped.status).toBe(400);
    const body = (await escaped.json()) as { error: string };
    expect(body.error).toMatch(/inside the session workspace/);
  }, 30_000);

  test("logs take an offset, and restart keeps the id", async () => {
    const started = await post("/dev", {
      session_id: "opencode:ses_x",
      command: "node -e \"console.log('one'); setTimeout(() => {}, 30000)\"",
    });
    expect(started.status).toBe(200);
    const info = (await started.json()) as { id: string; pid: number };
    let page = (await (await get(`/dev/${info.id}/logs?offset=0`)).json()) as {
      lines: { seq: number; text: string }[];
      next_offset: number;
    };
    for (let i = 0; i < 40 && !page.lines.some((line) => line.text === "one"); i++) {
      await Bun.sleep(50);
      page = (await (await get(`/dev/${info.id}/logs?offset=0`)).json()) as typeof page;
    }
    expect(page.lines.some((line) => line.text === "one")).toBe(true);
    const next = (await (await get(`/dev/${info.id}/logs?offset=${page.next_offset}`)).json()) as {
      lines: { text: string }[];
      next_offset: number;
    };
    expect(next.lines.filter((line) => line.text === "one")).toEqual([]);

    const again = await post(`/dev/${info.id}/restart`, {});
    expect(again.status).toBe(200);
    const restarted = (await again.json()) as { id: string; pid: number; state: string };
    expect(restarted.id).toBe(info.id);
    expect(restarted.pid).not.toBe(info.pid);
    expect(restarted.state).toBe("running");
    const listed = (await (await get("/dev?session=opencode%3Ases_x")).json()) as {
      processes: { id: string }[];
    };
    expect(listed.processes.filter((row) => row.id === info.id)).toHaveLength(1);
    await post(`/dev/${info.id}/stop`, {});
  }, 30_000);
});

describe("dev command policy", () => {
  let desktop = "";
  let work = "";

  const policyService = (policy: unknown) => {
    const file = join(desktop, `policy-${crypto.randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(policy));
    const service = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile: file });
    service.store.append([
      makeEvent({
        session_id: "opencode:ses_policy",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "policy", workspace: work },
      } as EventInput),
    ]);
    return service;
  };

  const start = (base: string, command: string) =>
    fetch(`${base}/dev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "opencode:ses_policy", command }),
    });

  beforeAll(() => {
    desktop = mkdtempSync(join(tmpdir(), "strata-devpolicy-"));
    work = mkdtempSync(join(tmpdir(), "strata-devpolicy-work-"));
  }, 30_000);

  afterAll(() => {
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("a bash deny rule stops the command before it spawns", async () => {
    const service = policyService({
      version: 1,
      default: "allow",
      rules: [{ id: "no-sleep", effect: "deny", tool: "bash", when: { command: { matches: "^sleep" } } }],
    });
    const base = `http://127.0.0.1:${service.port}`;
    try {
      const denied = await start(base, "sleep 30");
      expect(denied.status).toBe(403);
      const listed = (await (await fetch(`${base}/dev?session=opencode%3Ases_policy`)).json()) as {
        processes: unknown[];
      };
      expect(listed.processes).toHaveLength(0);
    } finally {
      service.stop();
    }
  }, 30_000);

  test("an ask waits for the permission card before the command starts", async () => {
    const service = policyService({ version: 1, default: "ask", rules: [] });
    const base = `http://127.0.0.1:${service.port}`;
    try {
      const starting = start(base, "sleep 30");
      let ask: { request_id: string; tool: string; input: { command?: string } } | undefined;
      for (let i = 0; i < 100 && !ask; i++) {
        const pending = (await (await fetch(`${base}/permissions`)).json()) as {
          pending: { request_id: string; tool: string; input: { command?: string } }[];
        };
        ask = pending.pending.find((p) => p.tool === "dev_start" && p.input.command === "sleep 30");
        if (!ask) await Bun.sleep(50);
      }
      expect(ask).toBeDefined();

      const answer = await fetch(`${base}/permissions/${encodeURIComponent(ask!.request_id)}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow" }),
      });
      expect(answer.status).toBe(200);

      const started = await starting;
      expect(started.status).toBe(200);
      const info = (await started.json()) as { id: string };
      await fetch(`${base}/dev/${info.id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    } finally {
      service.stop();
    }
  }, 30_000);
});
