import { describe, expect, test } from "bun:test";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";

const ev = (sessionId: string, type: EventInput["type"], data: Record<string, unknown>): EventInput =>
  makeEvent({
    session_id: sessionId,
    type,
    ts: "2026-10-22T10:00:00.000Z",
    source: { backend: "opencode" },
    data,
  } as EventInput);

describe("the session list names a dev server that is still in the shell", () => {
  test("a pending server is named, and a pending git status is not", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    svc.store.append([
      ev("opencode:dev", "session.started", { title: "dev", workspace: "/repo" }),
      ev("opencode:dev", "tool.call", { turn_id: "t1", call_id: "c1", tool: "bash", input: { command: "bun dev" } }),
      ev("opencode:git", "session.started", { title: "git", workspace: "/repo" }),
      ev("opencode:git", "tool.call", { turn_id: "t1", call_id: "c2", tool: "bash", input: { command: "git status" } }),
      ev("opencode:done", "session.started", { title: "done", workspace: "/repo" }),
      ev("opencode:done", "tool.call", { turn_id: "t1", call_id: "c3", tool: "bash", input: { command: "bun dev" } }),
      ev("opencode:done", "tool.result", { call_id: "c3", status: "ok", output: "" }),
    ]);
    const body = (await fetch(`${base}/sessions`).then((r) => r.json())) as {
      sessions: Array<{ summary: { session_id: string }; shell?: { command: string } }>;
    };
    const byId = new Map(body.sessions.map((s) => [s.summary.session_id, s.shell?.command]));
    expect(byId.get("opencode:dev")).toBe("bun dev");
    expect(byId.get("opencode:git")).toBeUndefined();
    expect(byId.get("opencode:done")).toBeUndefined();
    svc.stop();
  });
});
