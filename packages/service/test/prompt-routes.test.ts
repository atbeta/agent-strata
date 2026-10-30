import { describe, expect, test } from "bun:test";
import { promptRoute, type PendingAsk, type PendingQuestion } from "../src/prompt-routes";

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const ask = (): PendingAsk => ({
  request_id: "perm1",
  session_id: "opencode:s1",
  tool: "bash",
  input: {},
  asked_at: "2026-01-01T00:00:00Z",
  resolve: () => {},
});

const question = (): PendingQuestion => ({
  request_id: "q1",
  session_id: "opencode:s1",
  questions: [],
  asked_at: "2026-01-01T00:00:00Z",
  resolve: () => {},
});

describe("prompt response routes", () => {
  test("invalid permission responses fail closed and leave the ask pending", async () => {
    const pendingAsks = new Map([["perm1", ask()]]);
    let replies = 0;
    const driver = {
      replyPermission: async () => {
        replies++;
      },
    };
    const ctx = {
      pendingAsks,
      pendingQuestions: new Map(),
      driverFor: () => driver,
      directoryOf: () => "/repo",
      rememberAsk: () => {},
      resolvePermissionLocally: () => {},
      sessionIdOfPendingQuestion: () => undefined,
      replyQuestion: async () => {},
      resolveQuestionLocally: () => {},
    };

    for (const body of [{ decision: "yes" }, { decision: "allow", scope: "forever" }, "{"]) {
      const res = await promptRoute(post("/permissions/perm1/respond", body), "/permissions/perm1/respond", ctx);
      expect(res!.status).toBe(400);
    }
    expect(pendingAsks.has("perm1")).toBe(true);
    expect(replies).toBe(0);
  });

  test("a failed permission reply can be retried and only success resolves locally", async () => {
    const pendingAsks = new Map([["perm1", ask()]]);
    let attempts = 0;
    const resolved: string[] = [];
    const driver = {
      replyPermission: async () => {
        attempts++;
        if (attempts === 1) throw new Error("network down");
      },
    };
    const ctx = {
      pendingAsks,
      pendingQuestions: new Map(),
      driverFor: () => driver,
      directoryOf: () => "/repo",
      rememberAsk: () => {},
      resolvePermissionLocally: (_session: string, request: string) => resolved.push(request),
      sessionIdOfPendingQuestion: () => undefined,
      replyQuestion: async () => {},
      resolveQuestionLocally: () => {},
    };

    const failed = await promptRoute(post("/permissions/perm1/respond", { decision: "allow" }), "/permissions/perm1/respond", ctx);
    expect(failed!.status).toBe(502);
    expect(resolved).toEqual([]);
    expect(pendingAsks.get("perm1")!.submitting).toBe(false);

    const ok = await promptRoute(post("/permissions/perm1/respond", { decision: "allow" }), "/permissions/perm1/respond", ctx);
    expect(ok!.status).toBe(200);
    expect(attempts).toBe(2);
    expect(resolved).toEqual(["perm1"]);
  });

  test("a permission response cannot be submitted twice while the backend is deciding", async () => {
    const pendingAsks = new Map([["perm1", ask()]]);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driver = { replyPermission: () => waiting };
    const ctx = {
      pendingAsks,
      pendingQuestions: new Map(),
      driverFor: () => driver,
      directoryOf: () => "/repo",
      rememberAsk: () => {},
      resolvePermissionLocally: () => {},
      sessionIdOfPendingQuestion: () => undefined,
      replyQuestion: async () => {},
      resolveQuestionLocally: () => {},
    };
    const first = promptRoute(post("/permissions/perm1/respond", { decision: "deny" }), "/permissions/perm1/respond", ctx);
    await Promise.resolve();
    const second = await promptRoute(post("/permissions/perm1/respond", { decision: "deny" }), "/permissions/perm1/respond", ctx);
    expect(second!.status).toBe(409);
    release();
    expect((await first)!.status).toBe(200);
  });

  test("a live question is resolved only after the backend accepts its answer", async () => {
    const pendingQuestions = new Map([["q1", question()]]);
    let attempts = 0;
    const resolved: string[] = [];
    const driver = {
      replyQuestion: async () => {
        attempts++;
        if (attempts === 1) throw new Error("offline");
      },
    };
    const ctx = {
      pendingAsks: new Map(),
      pendingQuestions,
      driverFor: () => driver,
      directoryOf: () => "/repo",
      rememberAsk: () => {},
      resolvePermissionLocally: () => {},
      sessionIdOfPendingQuestion: () => undefined,
      replyQuestion: async () => {},
      resolveQuestionLocally: (_session: string, request: string) => resolved.push(request),
    };

    const failed = await promptRoute(post("/questions/q1/respond", { decision: "reply", answers: [["A"]] }), "/questions/q1/respond", ctx);
    expect(failed!.status).toBe(502);
    expect(resolved).toEqual([]);
    expect(pendingQuestions.get("q1")!.submitting).toBe(false);

    const ok = await promptRoute(post("/questions/q1/respond", { decision: "reply", answers: [["A"]] }), "/questions/q1/respond", ctx);
    expect(ok!.status).toBe(200);
    expect(resolved).toEqual(["q1"]);
  });

  test("a restarted question does not write resolved when delivery fails", async () => {
    const resolved: string[] = [];
    const ctx = {
      pendingAsks: new Map(),
      pendingQuestions: new Map(),
      driverFor: () => undefined,
      directoryOf: () => "/repo",
      rememberAsk: () => {},
      resolvePermissionLocally: () => {},
      sessionIdOfPendingQuestion: () => "opencode:s1",
      replyQuestion: async () => {
        throw new Error("offline");
      },
      resolveQuestionLocally: (_session: string, request: string) => resolved.push(request),
    };
    const res = await promptRoute(post("/questions/q1/respond", { decision: "reject" }), "/questions/q1/respond", ctx);
    expect(res!.status).toBe(502);
    expect(resolved).toEqual([]);
  });
});
