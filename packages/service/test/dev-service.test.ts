import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";

/**
 * dev commands, now that they are a plugin.
 *
 * The route moved from `/dev` to the dev plugin's private namespace, but the
 * question these cases ask is unchanged: does the table survive, does a stop
 * say what is left, can a workdir leave the workspace. Keeping the old cases
 * and changing only the URL is deliberate — if the migration changed an
 * answer, this file should fail.
 *
 * Two surfaces belong to the new shape and both are exercised: the tool
 * routes (`/plugins/dev/tools/*`) are what the agent sees, and the private
 * routes (`/plugins/dev/processes/*`) are what the background panel sees.
 * They are different callers of the same manager, and they answer differently
 * on purpose — a model gets a sentence, a panel gets a page.
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

  const panel = (path: string) => `/plugins/dev${path}`;

  /** Start through the tool surface, the way the agent does. */
  const startTool = (command: string, extra: Record<string, unknown> = {}) =>
    post(panel("/tools/start"), {
      session_id: "opencode:ses_x",
      input: { command, ...extra },
    });

  const startedID = (output: string): string => {
    const id = /Started (dev_\w+)/.exec(output)?.[1];
    if (!id) throw new Error(`no process id in: ${output}`);
    return id;
  };

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

    const started = await startTool(`node "${script}"`, { port: 45991 });
    expect(started.status).toBe(200);
    const body = (await started.json()) as { output: string; is_error: boolean };
    expect(body.is_error).toBe(false);
    expect(body.output).toContain("Started dev_");
    expect(body.output).toContain("accepts connections");

    const id = startedID(body.output);

    // The panel's list has it, as running.
    const list = (await (await get(panel("/processes?session=opencode%3Ases_x"))).json()) as {
      processes: { id: string; state: string }[];
    };
    expect(list.processes.find((p) => p.id === id)?.state).toBe("running");

    // The logs are readable, through the panel route and through the tool.
    const logs = (await (await get(panel(`/processes/${id}/logs`))).json()) as { lines: { text: string }[] };
    expect(logs.lines.some((l) => l.text.includes("listening on 45991"))).toBe(true);

    const toolLogs = (await post(panel("/tools/logs"), {
      session_id: "opencode:ses_x",
      input: { process_id: id },
    }).then((r) => r.json())) as { output: string };
    expect(toolLogs.output).toContain("listening on 45991");

    // A second command on the same port is refused, with a reason.
    const second = (await (await startTool(`node "${script}"`, { port: 45991 })).json()) as {
      output: string;
      is_error: boolean;
    };
    expect(second.is_error).toBe(true);
    expect(second.output).toMatch(/already/);

    // The stop says what is true: the tree is gone and the port is free.
    const stopped = await post(panel(`/processes/${id}/stop`), {});
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
    const after = (await (await get(panel("/processes?session=opencode%3Ases_x"))).json()) as {
      processes: { id: string; state: string }[];
    };
    expect(after.processes.find((p) => p.id === id)?.state).toBe("stopped");
  }, 40_000);

  test("the table of what ran survives the service that ran it", () => {
    // The plugin writes down what it is running, because a service that is
    // killed outright cannot run its own cleanup. The file is what the next
    // run works from — and it is still the app data directory's file, so an
    // upgrade finds the table the old service wrote.
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
    const stopped = await post(panel("/processes/dev_missing/stop"), {});
    expect(stopped.status).toBe(404);
  }, 30_000);

  test("a finished record can be deleted, a running one cannot", async () => {
    const finished = (await (await startTool('node -e "setTimeout(() => {}, 500)"')).json()) as { output: string };
    const id = startedID(finished.output);
    await post(panel(`/processes/${id}/stop`), {});
    const removed = await fetch(`${base}${panel(`/processes/${id}`)}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    // The id is gone; a second delete cannot pretend otherwise.
    expect((await fetch(`${base}${panel(`/processes/${id}`)}`, { method: "DELETE" })).status).toBe(404);

    const running = (await (await startTool('node -e "setTimeout(() => {}, 30000)"')).json()) as { output: string };
    const live = startedID(running.output);
    try {
      const refused = await fetch(`${base}${panel(`/processes/${live}`)}`, { method: "DELETE" });
      expect(refused.status).toBe(400);
      // The record is the only handle that can stop the process; dropping it
      // while the process is alive would leave a server on a port with no name.
      expect(((await refused.json()) as { error: string }).error).toMatch(/still running/);
    } finally {
      await post(panel(`/processes/${live}/stop`), {});
    }
  }, 30_000);

  test("the workspace is the session's, whatever the caller says", async () => {
    // A caller that could name a directory would be a caller that could
    // leave the project. The path in the body is ignored: the session's
    // workspace is the answer.
    const elsewhere = mkdtempSync(join(tmpdir(), "strata-devsvc-elsewhere-"));
    try {
      const started = (await post(panel("/tools/start"), {
        session_id: "opencode:ses_x",
        input: { command: 'node -e "setTimeout(() => {}, 500)"', cwd: elsewhere },
      }).then((r) => r.json())) as { output: string };
      const id = startedID(started.output);
      const info = (await (await get(panel(`/processes/${id}`))).json()) as { cwd: string };
      expect(info.cwd).toBe(work);

      const stopped = await post(panel(`/processes/${id}/stop`), {});
      expect(stopped.status).toBe(200);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 30_000);

  test("workdir runs inside the workspace and cannot leave it", async () => {
    const child = join(work, "web");
    mkdirSync(child, { recursive: true });
    const started = (await (await startTool('node -e "setTimeout(() => {}, 500)"', { workdir: "web" })).json()) as {
      output: string;
      is_error: boolean;
    };
    expect(started.is_error).toBe(false);
    const id = startedID(started.output);
    const info = (await (await get(panel(`/processes/${id}`))).json()) as { cwd: string };
    expect(info.cwd).toBe(child);
    await post(panel(`/processes/${id}/stop`), {});

    const escaped = await startTool('node -e "setTimeout(() => {}, 500)"', { workdir: ".." });
    expect(escaped.status).toBe(403);
    const body = (await escaped.json()) as { error: string };
    expect(body.error).toMatch(/inside the session workspace/);
  }, 30_000);

  test("logs take an offset, and restart keeps the id", async () => {
    const started = (await (await startTool('node -e "console.log(\'one\'); setTimeout(() => {}, 30000)"')).json()) as {
      output: string;
    };
    const id = startedID(started.output);
    const before = (await (await get(panel(`/processes/${id}`))).json()) as { pid: number };

    let page = (await (await get(panel(`/processes/${id}/logs?offset=0`))).json()) as {
      lines: { seq: number; text: string }[];
      next_offset: number;
    };
    for (let i = 0; i < 40 && !page.lines.some((line) => line.text === "one"); i++) {
      await Bun.sleep(50);
      page = (await (await get(panel(`/processes/${id}/logs?offset=0`))).json()) as typeof page;
    }
    expect(page.lines.some((line) => line.text === "one")).toBe(true);
    const next = (await (await get(panel(`/processes/${id}/logs?offset=${page.next_offset}`))).json()) as {
      lines: { text: string }[];
      next_offset: number;
    };
    expect(next.lines.filter((line) => line.text === "one")).toEqual([]);

    const again = await post(panel(`/processes/${id}/restart`), {});
    expect(again.status).toBe(200);
    const restarted = (await again.json()) as { id: string; pid: number; state: string };
    expect(restarted.id).toBe(id);
    expect(restarted.pid).not.toBe(before.pid);
    expect(restarted.state).toBe("running");
    const listed = (await (await get(panel("/processes?session=opencode%3Ases_x"))).json()) as {
      processes: { id: string }[];
    };
    expect(listed.processes.filter((row) => row.id === id)).toHaveLength(1);
    await post(panel(`/processes/${id}/stop`), {});
  }, 40_000);

  test("another session's command is not visible or stoppable", async () => {
    // Two sessions can each run a server. A panel scoped to one of them must
    // not see the other's rows, and an id from the other session is a 404 —
    // not "found but forbidden", which would confirm the id exists.
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_other",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "other", workspace: work },
      } as EventInput),
    ]);
    const started = (await post(panel("/tools/start"), {
      session_id: "opencode:ses_other",
      input: { command: 'node -e "setTimeout(() => {}, 30000)"' },
    }).then((r) => r.json())) as { output: string };
    const id = startedID(started.output);
    try {
      const mine = (await (await get(panel("/processes?session=opencode%3Ases_x"))).json()) as {
        processes: { id: string }[];
      };
      expect(mine.processes.some((p) => p.id === id)).toBe(false);
      const peek = await get(panel(`/processes/${id}?session=opencode%3Ases_x`));
      expect(peek.status).toBe(404);
      const stop = await post(panel(`/processes/${id}/stop?session=opencode%3Ases_x`), {});
      expect(stop.status).toBe(404);
    } finally {
      await post(panel(`/processes/${id}/stop`), {});
    }
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
    fetch(`${base}/plugins/dev/tools/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "opencode:ses_policy", input: { command } }),
    });

  const listed = async (base: string) => {
    const res = (await (await fetch(`${base}/plugins/dev/processes?session=opencode%3Ases_policy`)).json()) as {
      processes: unknown[];
    };
    return res.processes;
  };

  const stopOutput = async (base: string, output: string) => {
    const id = /Started (dev_\w+)/.exec(output)?.[1];
    if (id) await fetch(`${base}/plugins/dev/processes/${id}/stop`, { method: "POST" });
  };

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
      expect(await listed(base)).toHaveLength(0);
    } finally {
      service.stop();
    }
  }, 30_000);

  test("a rule written for dev_start stops the command too", async () => {
    const service = policyService({
      version: 1,
      default: "allow",
      rules: [{ id: "no-sleep", effect: "deny", tool: "dev_start", when: { command: { matches: "^sleep" } } }],
    });
    const base = `http://127.0.0.1:${service.port}`;
    try {
      const denied = await start(base, "sleep 30");
      expect(denied.status).toBe(403);
    } finally {
      service.stop();
    }
  }, 30_000);

  test("the connection's own policy is what a background command meets", async () => {
    // A connection can carry a policy of its own, and that policy wins over
    // the shared one. The shared document here allows everything; the
    // connection denies it all. The command has to meet the connection's
    // rules, or a reader who locked a connection down could still have a
    // background command run under it.
    const MOCK = fileURLToPath(new URL("../../adapter-acp/test/fixtures/mock-agent.ts", import.meta.url));
    const file = join(desktop, `policy-shared-${crypto.randomUUID()}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, default: "allow", rules: [] }));
    const service = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile: file });
    const base = `http://127.0.0.1:${service.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const connected = (await post("/connect", {
        backend: "acp",
        command: process.execPath,
        args: [MOCK],
        agentName: "mock",
        cwd: work,
        directory: work,
        policy: { version: 1, default: "deny", rules: [] },
      }).then((r) => r.json())) as { id: string };
      const created = (await post("/sessions", { connection_id: connected.id, directory: work }).then((r) =>
        r.json(),
      )) as { id: string };
      const denied = await post("/plugins/dev/tools/start", { session_id: created.id, input: { command: "sleep 30" } });
      expect(denied.status).toBe(403);
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
      const body = (await started.json()) as { output: string };
      await stopOutput(base, body.output);
    } finally {
      service.stop();
    }
  }, 30_000);

  test("an explicit allow rule still beats the floor", async () => {
    const service = policyService({
      version: 1,
      default: "deny",
      rules: [{ id: "trusted-sleep", effect: "allow", tool: "dev_start", when: { command: { matches: "^sleep" } } }],
    });
    const base = `http://127.0.0.1:${service.port}`;
    try {
      const started = await start(base, "sleep 30");
      expect(started.status).toBe(200);
      const body = (await started.json()) as { output: string };
      await stopOutput(base, body.output);
    } finally {
      service.stop();
    }
  }, 30_000);
});
