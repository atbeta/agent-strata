import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";

const SESSION = "opencode:ses_native_terminal";

interface ToolReply {
  output: string;
  is_error: boolean;
}

class Capture {
  readonly messages: string[] = [];
  binary = "";

  constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      this.messages.push(text);
      this.binary += text;
    };
  }

  send(text: string): void {
    this.ws.send(text);
  }

  async contains(wanted: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (this.binary.includes(wanted)) return;
      await Bun.sleep(25);
    }
    throw new Error(`socket did not receive ${wanted}: ${this.binary}`);
  }
}

async function connect(base: string, id: string, session = SESSION): Promise<Capture> {
  const query = new URLSearchParams({ session });
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/plugins/terminal/terminals/${id}/connect?${query}`);
  const capture = new Capture(ws);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("terminal socket failed"));
  });
  return capture;
}

const input = (text: string) => process.platform === "win32" ? `echo ${text}\r` : `printf '${text}\\n'\n`;

describe("native terminal plugin", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  let desktop = "";
  let work = "";
  let terminalId = "";

  const call = async (tool: string, body: Record<string, unknown>, session = SESSION): Promise<ToolReply> => {
    const res = await fetch(`${base}/plugins/terminal/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: session, input: body }),
    });
    return (await res.json()) as ToolReply;
  };

  const read = async (id: string, wanted?: string): Promise<Record<string, unknown>> => {
    let latest: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      const reply = await call("read", { terminal_id: id, offset: 0, max_bytes: 64 * 1024 });
      expect(reply.is_error).toBe(false);
      latest = JSON.parse(reply.output) as Record<string, unknown>;
      if (!wanted || String(latest.output).includes(wanted)) return latest;
      await Bun.sleep(25);
    }
    throw new Error(`terminal did not print ${wanted}: ${String(latest.output)}`);
  };

  beforeAll(async () => {
    desktop = mkdtempSync(join(tmpdir(), "strata-native-terminal-"));
    work = mkdtempSync(join(tmpdir(), "strata-native-work-"));
    writeFileSync(join(desktop, "policy.json"), JSON.stringify({
      version: 1,
      default: "allow",
      rules: [{ id: "terminal", effect: "allow", tool: "terminal_*" }],
    }));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, policyFile: join(desktop, "policy.json") });
    base = `http://127.0.0.1:${svc.port}`;
    svc.store.append([
      makeEvent({
        session_id: SESSION,
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "terminal", workspace: work },
      } as EventInput),
    ]);
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${base}/plugins`);
      const body = (await res.json()) as { plugins: { id: string; state: string }[] };
      if (body.plugins.some((plugin) => plugin.id === "terminal" && plugin.state === "running")) return;
      await Bun.sleep(20);
    }
    throw new Error("terminal plugin did not start");
  }, 30_000);

  afterAll(async () => {
    if (terminalId) await call("close", { terminal_id: terminalId }).catch(() => undefined);
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }, 30_000);

  test("agent tools and user sockets share one reconnectable PTY", async () => {
    const created = await call("create", { title: "shared" });
    expect(created.is_error).toBe(false);
    terminalId = (JSON.parse(created.output) as { terminal: { id: string } }).terminal.id;

    const write = await call("write", { terminal_id: terminalId, data: input("ready") });
    expect(write.is_error).toBe(false);
    await read(terminalId, "ready");

    const stringCursor = await call("read", { terminal_id: terminalId, offset: "0", max_bytes: "65536" });
    expect(stringCursor.is_error).toBe(false);
    const invalidCursor = await call("read", { terminal_id: terminalId, offset: "1.5" });
    expect(invalidCursor.is_error).toBe(true);
    const baseline = (JSON.parse(stringCursor.output) as { next_offset: number }).next_offset;
    expect(baseline).toBeGreaterThan(0);
    await call("write", { terminal_id: terminalId, data: input("paged") });
    await read(terminalId, "paged");
    const paged = await call("read", { terminal_id: terminalId, offset: baseline, max_bytes: 4 });
    expect(paged.is_error).toBe(false);
    const page = JSON.parse(paged.output) as { output: string; next_offset: number };
    expect(page.next_offset).toBeGreaterThan(baseline);
    expect(page.output.length).toBeLessThanOrEqual(4);
    const decimalCursor = await call("read", { terminal_id: terminalId, offset: `${baseline}.0`, max_bytes: "65536.0" });
    expect(decimalCursor.is_error).toBe(false);
    const exponentCursor = await call("read", { terminal_id: terminalId, offset: `${baseline}e0`, max_bytes: null });
    expect(exponentCursor.is_error).toBe(false);

    const waitBaseline = (JSON.parse(decimalCursor.output) as { next_offset: number }).next_offset;
    const waiting = call("read", { terminal_id: terminalId, offset: waitBaseline, wait_ms: 1000, quiet_ms: 100 });
    setTimeout(() => {
      void call("write", { terminal_id: terminalId, data: input("delayed") }).catch(() => undefined);
    }, 50);
    const delayed = await waiting;
    expect(delayed.is_error).toBe(false);
    const delayedPage = JSON.parse(delayed.output) as {
      output: string;
      next_offset: number;
      new_output: boolean;
      output_idle: boolean;
      timed_out: boolean;
    };
    expect(delayedPage.output).toContain("delayed");
    expect(delayedPage.new_output).toBe(true);
    expect(delayedPage.output_idle).toBe(true);
    expect(delayedPage.timed_out).toBe(false);

    const quiet = await call("read", { terminal_id: terminalId, offset: delayedPage.next_offset, wait_ms: 30, quiet_ms: 5 });
    const quietPage = JSON.parse(quiet.output) as { new_output: boolean; output_idle: boolean; timed_out: boolean };
    expect(quietPage).toMatchObject({ new_output: false, output_idle: true, timed_out: true });

    const first = await connect(base, terminalId);
    await first.contains("ready");
    first.send(input("from-ui"));
    await first.contains("from-ui");
    await read(terminalId, "from-ui");

    const second = await connect(base, terminalId);
    await second.contains("from-ui");
    first.ws.close();
    second.ws.close();

    const query = new URLSearchParams({ session: SESSION });
    const listed = await fetch(`${base}/plugins/terminal/terminals?${query}`);
    const listing = (await listed.json()) as { sessions: { id: string; status: string }[] };
    expect(listing.sessions).toHaveLength(1);
    expect(listing.sessions[0]).toMatchObject({ id: terminalId, status: "running" });

    const badSize = await fetch(`${base}/plugins/terminal/terminals/${terminalId}/size?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: 0, cols: 80 }),
    });
    expect(badSize.status).toBe(400);

    const foreign = await call("read", { terminal_id: terminalId }, "opencode:other");
    expect(foreign.is_error).toBe(true);

    const reconnected = await connect(base, terminalId);
    await reconnected.contains("from-ui");
    reconnected.ws.close();

    const closed = await call("close", { terminal_id: terminalId });
    expect(closed.is_error).toBe(false);
    const after = await call("list", {});
    expect(JSON.parse(after.output)).toEqual({ terminals: [] });
    terminalId = "";
  }, 30_000);
});
