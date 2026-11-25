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
  rememberAlways?: (tool: string) => void;
  waiting?: (ask: { session_id: string; request_id: string }) => void;
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
    rememberAlways: options.rememberAlways,
    waiting: options.waiting,
  });
  for (const pending of options.asks ?? []) requests.pendingAsks.set(pending.request_id, pending);
  for (const pending of options.questions ?? []) requests.pendingQuestions.set(pending.request_id, pending);
  return { requests, store };
}

describe("an ask that waits on the reader", () => {
  const requested = (request_id: string) =>
    makeEvent({
      id: `opencode:${request_id}:permission.requested`,
      session_id: "opencode:s1",
      source: { backend: "opencode" },
      type: "permission.requested",
      data: { request_id, tool: "bash", input: {} },
    }) as Extract<EventInput, { type: "permission.requested" }>;

  test("is announced once, when it starts to block", () => {
    const waiting: { session_id: string; request_id: string }[] = [];
    const { requests, store } = harness({ waiting: (a) => waiting.push(a) });
    void requests.onAsk(requested("perm1"));
    expect(waiting).toEqual([{ session_id: "opencode:s1", request_id: "perm1" }]);
    // A replay of the same ask, as a reconnect restores it, is not a second one.
    void requests.onAsk(requested("perm1"));
    expect(waiting).toHaveLength(1);
    store.close();
  });

  test("an ask already answered elsewhere is not announced", () => {
    const waiting: string[] = [];
    const { requests, store } = harness({ waiting: (a) => waiting.push(a.request_id) });
    requests.settleAsk("perm2", "allow");
    void requests.onAsk(requested("perm2"));
    expect(waiting).toEqual([]);
    store.close();
  });
});

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

  test("always on a tool this service asked about remembers it, and once does not", async () => {
    const remembered: string[] = [];
    const local = ask();
    local.local = true;
    local.tool = "schedule_create";
    const { requests, store } = harness({
      asks: [local],
      rememberAlways: (tool) => remembered.push(tool),
    });

    const once = await promptRoute(
      post("/permissions/perm1/respond", { decision: "allow", scope: "once" }),
      "/permissions/perm1/respond",
      requests,
    );
    expect(once!.status).toBe(200);
    expect(remembered).toEqual([]);

    const again = ask();
    again.local = true;
    again.tool = "schedule_create";
    again.request_id = "perm2";
    requests.pendingAsks.set(again.request_id, again);
    const always = await promptRoute(
      post("/permissions/perm2/respond", { decision: "allow", scope: "always" }),
      "/permissions/perm2/respond",
      requests,
    );
    expect(always!.status).toBe(200);
    expect(remembered).toEqual(["schedule_create"]);
    store.close();
  });

  test("always for a backend ask is the backend's memory, not a policy rule", async () => {
    const remembered: string[] = [];
    const { requests, store } = harness({
      asks: [ask()],
      rememberAlways: (tool) => remembered.push(tool),
      driver: { replyPermission: async () => {} },
    });
    const res = await promptRoute(
      post("/permissions/perm1/respond", { decision: "allow", scope: "always" }),
      "/permissions/perm1/respond",
      requests,
    );
    expect(res!.status).toBe(200);
    expect(remembered).toEqual([]);
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


describe("a question on an unattended session", () => {
  const asked = (request_id: string) =>
    makeEvent({
      id: `opencode:${request_id}:question.asked`,
      session_id: "opencode:s1",
      source: { backend: "opencode" },
      type: "question.asked",
      data: {
        request_id,
        questions: [
          {
            question: "which database?",
            header: "DB",
            options: [{ label: "postgres", description: "" }],
          },
        ],
      },
    }) as Extract<EventInput, { type: "question.asked" }>;

  function timeoutHarness(
    view: object,
    questionTimeoutMs = 20,
    before?: (store: ReturnType<typeof openStore>, requestId: string) => void,
  ) {
    const store = openStore(":memory:");
    const replies: { requestId: string; answers: string[][] }[] = [];
    const requests = new PermissionRequests({
      store,
      sessionView: () => ({ pending_questions: [], turns: [], ...view }) as unknown as SessionView,
      driverFor: () => ({
        replyQuestion: async (requestId: string, answers: string[][]) => {
          before?.(store, requestId);
          replies.push({ requestId, answers });
        },
      }),
      directoryOf: () => "/repo",
      questionTimeoutMs,
    });
    return { store, requests, replies };
  }

  const sleep = (ms: number) => Bun.sleep(ms);

  test("times out into a judgment answer marked as automatic", async () => {
    const { store, requests, replies } = timeoutHarness({ goal: "ship it", goal_met: undefined });
    void requests.onQuestion(asked("q1"));
    expect(requests.pendingQuestions.has("q1")).toBe(true);
    await sleep(60);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.answers).toHaveLength(1);
    expect(replies[0]!.answers[0]![0]).toContain("best judgment");
    expect(requests.pendingQuestions.has("q1")).toBe(false);
    const seen: EventInput[] = [];
    store.subscribe((e) => seen.push(e));
    void requests.onQuestion(asked("q2"));
    await sleep(60);
    const resolved = seen.find((e) => e.type === "question.resolved");
    expect(resolved?.type).toBe("question.resolved");
    if (resolved?.type === "question.resolved") {
      expect(resolved.data.by).toBe("auto");
      expect(resolved.data.reason).toBe("timeout");
    }
    store.close();
  });

  test("the automatic mark survives the backend's own copy of the reply landing first", async () => {
    const seen: EventInput[] = [];
    const { store, requests } = timeoutHarness({ goal: "ship it" }, 20, (store, requestId) => {
      store.append([
        makeEvent({
          id: `opencode:${requestId}:question.resolved`,
          session_id: "opencode:s1",
          source: { backend: "opencode" },
          type: "question.resolved",
          data: { request_id: requestId, decision: "reply", answers: [["x"]] },
        }) as EventInput,
      ]);
    });
    store.subscribe((e) => seen.push(e));
    void requests.onQuestion(asked("q1"));
    await sleep(60);
    const auto = seen.find((e) => e.type === "question.resolved" && e.data.by === "auto");
    expect(auto?.id).toBe("desktop:q1:question.resolved");
    store.close();
  });

  test("a failed automatic answer comes round again", async () => {
    let attempts = 0;
    const { store, requests, replies } = timeoutHarness({ goal: "ship it" }, 20, () => {
      if (attempts++ === 0) throw new Error("backend away");
    });
    const error = console.error;
    console.error = () => {};
    try {
      void requests.onQuestion(asked("q1"));
      await sleep(100);
    } finally {
      console.error = error;
    }
    expect(replies).toHaveLength(1);
    expect(requests.pendingQuestions.has("q1")).toBe(false);
    store.close();
  });

  test("an interactive session's question waits past the same window", async () => {
    const { store, requests, replies } = timeoutHarness({ goal: undefined });
    void requests.onQuestion(asked("q1"));
    await sleep(60);
    expect(replies).toHaveLength(0);
    expect(requests.pendingQuestions.has("q1")).toBe(true);
    store.close();
  });

  test("a met goal's session is back in the reader's hands", async () => {
    const { store, requests, replies } = timeoutHarness({ goal: "ship it", goal_met: true });
    void requests.onQuestion(asked("q1"));
    await sleep(60);
    expect(replies).toHaveLength(0);
    expect(requests.pendingQuestions.has("q1")).toBe(true);
    store.close();
  });

  test("a schedule-spawned session is autonomous from its first prompt", async () => {
    const { store, requests, replies } = timeoutHarness({
      goal: undefined,
      turns: [{ user: [{ type: "text", text: "[scheduled: nightly]\\n\\ndo the thing" }], assistant: [] }],
    });
    void requests.onQuestion(asked("q1"));
    await sleep(60);
    expect(replies).toHaveLength(1);
    store.close();
  });

  test("a schedule firing into an existing session makes that turn autonomous", async () => {
    const { store, requests, replies } = timeoutHarness({
      goal: undefined,
      turns: [
        { user: [{ type: "text", text: "look at the logs" }], assistant: [] },
        { user: [{ type: "text", text: "[scheduled: nightly]\\n\\ndo the thing" }], assistant: [] },
      ],
    });
    void requests.onQuestion(asked("q1"));
    await sleep(60);
    expect(replies).toHaveLength(1);
    store.close();
  });

  test("a scheduled session the reader typed into again is theirs to answer", async () => {
    const { store, requests, replies } = timeoutHarness({
      goal: undefined,
      turns: [
        { user: [{ type: "text", text: "[scheduled: nightly]\\n\\ndo the thing" }], assistant: [] },
        { user: [{ type: "text", text: "now fix what you found" }], assistant: [] },
      ],
    });
    void requests.onQuestion(asked("q1"));
    await sleep(60);
    expect(replies).toHaveLength(0);
    store.close();
  });

  test("an answer before the deadline is the one that lands", async () => {
    const { store, requests, replies } = timeoutHarness({ goal: "ship it" });
    void requests.onQuestion(asked("q1"));
    const question = requests.pendingQuestions.get("q1")!;
    requests.pendingQuestions.delete("q1");
    requests.settleQuestion("q1");
    await sleep(60);
    expect(replies).toHaveLength(0);
    expect(question).toBeDefined();
    store.close();
  });
});
