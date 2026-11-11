import { describe, expect, test } from "bun:test";
import type { SessionView } from "@agent-strata/projector";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { openStore } from "@agent-strata/store";
import { PermissionRequests, type PendingAsk, type PendingQuestion } from "../src/permission-requests";
import { promptRoute } from "../src/prompt-routes";

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

function harness(options: {
  asks?: PendingAsk[];
  questions?: PendingQuestion[];
  driver?: {
    replyPermission?(requestId: string, reply: "once" | "always" | "reject", directory?: string): Promise<unknown>;
    replyQuestion?(requestId: string, answers: string[][], directory?: string): Promise<unknown>;
    rejectQuestion?(requestId: string, directory?: string): Promise<unknown>;
  };
  pendingQuestionIds?: string[];
}) {
  const store = openStore(":memory:");
  for (const requestId of options.pendingQuestionIds ?? []) {
    store.append([
      makeEvent({
        session_id: "opencode:s1",
        source: { backend: "opencode" },
        type: "question.asked",
        data: { request_id: requestId, questions: [] },
      }) as EventInput,
    ]);
  }
  const requests = new PermissionRequests({
    store,
    sessionView: () =>
      ({
        pending_questions: (options.pendingQuestionIds ?? []).map((request_id) => ({ request_id })),
      }) as SessionView,
    driverFor: () => options.driver,
    directoryOf: () => "/repo",
  });
  for (const pending of options.asks ?? []) requests.pendingAsks.set(pending.request_id, pending);
  for (const pending of options.questions ?? []) requests.pendingQuestions.set(pending.request_id, pending);
  return { requests, store };
}

describe("prompt response routes", () => {
  test("invalid permission responses fail closed and leave the ask pending", async () => {
    let replies = 0;
    const { requests, store } = harness({
      asks: [ask()],
      driver: {
        replyPermission: async () => {
          replies++;
        },
      },
    });

    for (const body of [{ decision: "yes" }, { decision: "allow", scope: "forever" }, "{"]) {
      const res = await promptRoute(post("/permissions/perm1/respond", body), "/permissions/perm1/respond", requests);
      expect(res!.status).toBe(400);
    }
    expect(requests.pendingAsks.has("perm1")).toBe(true);
    expect(replies).toBe(0);
    store.close();
  });

  test("a local ask is resolved without a backend reply", async () => {
    let replies = 0;
    const { requests, store } = harness({
      asks: [{ ...ask(), local: true }],
      driver: {
        replyPermission: async () => {
          replies++;
        },
      },
    });
    const res = await promptRoute(
      post("/permissions/perm1/respond", { decision: "allow" }),
      "/permissions/perm1/respond",
      requests,
    );
    expect(res!.status).toBe(200);
    expect(replies).toBe(0);
    expect(requests.pendingAsks.has("perm1")).toBe(false);
    store.close();
  });

  test("a failed permission reply can be retried and only success resolves locally", async () => {
    let attempts = 0;
    const { requests, store } = harness({
      asks: [ask()],
      driver: {
        replyPermission: async () => {
          attempts++;
          if (attempts === 1) throw new Error("network down");
        },
      },
    });

    const failed = await promptRoute(
      post("/permissions/perm1/respond", { decision: "allow" }),
      "/permissions/perm1/respond",
      requests,
    );
    expect(failed!.status).toBe(502);
    expect(requests.pendingAsks.get("perm1")!.submitting).toBe(false);
    expect(store.query({ types: ["permission.resolved"] })).toHaveLength(0);

    const ok = await promptRoute(
      post("/permissions/perm1/respond", { decision: "allow" }),
      "/permissions/perm1/respond",
      requests,
    );
    expect(ok!.status).toBe(200);
    expect(attempts).toBe(2);
    expect(store.query({ types: ["permission.resolved"] })).toHaveLength(1);
    store.close();
  });

  test("a permission response cannot be submitted twice while the backend is deciding", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { requests, store } = harness({ asks: [ask()], driver: { replyPermission: () => waiting } });
    const first = promptRoute(
      post("/permissions/perm1/respond", { decision: "deny" }),
      "/permissions/perm1/respond",
      requests,
    );
    await Promise.resolve();
    const second = await promptRoute(
      post("/permissions/perm1/respond", { decision: "deny" }),
      "/permissions/perm1/respond",
      requests,
    );
    expect(second!.status).toBe(409);
    release();
    expect((await first)!.status).toBe(200);
    store.close();
  });

  test("a live question is resolved only after the backend accepts its answer", async () => {
    let attempts = 0;
    const { requests, store } = harness({
      questions: [question()],
      driver: {
        replyQuestion: async () => {
          attempts++;
          if (attempts === 1) throw new Error("offline");
        },
      },
    });

    const failed = await promptRoute(
      post("/questions/q1/respond", { decision: "reply", answers: [["A"]] }),
      "/questions/q1/respond",
      requests,
    );
    expect(failed!.status).toBe(502);
    expect(requests.pendingQuestions.get("q1")!.submitting).toBe(false);
    expect(store.query({ types: ["question.resolved"] })).toHaveLength(0);

    const ok = await promptRoute(
      post("/questions/q1/respond", { decision: "reply", answers: [["A"]] }),
      "/questions/q1/respond",
      requests,
    );
    expect(ok!.status).toBe(200);
    expect(store.query({ types: ["question.resolved"] })).toHaveLength(1);
    store.close();
  });

  test("a restarted question does not write resolved when delivery fails", async () => {
    const { requests, store } = harness({
      pendingQuestionIds: ["q1"],
      driver: {
        rejectQuestion: async () => {
          throw new Error("offline");
        },
      },
    });
    const res = await promptRoute(
      post("/questions/q1/respond", { decision: "reject" }),
      "/questions/q1/respond",
      requests,
    );
    expect(res!.status).toBe(502);
    expect(store.query({ types: ["question.resolved"] })).toHaveLength(0);
    store.close();
  });
});
