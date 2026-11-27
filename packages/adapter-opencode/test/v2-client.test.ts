import { describe, expect, test } from "bun:test";
import { openStore } from "@agent-strata/store";
import { connectOpencode } from "../src/index";
import { OpencodeMapper } from "../src/map";
import { snapshotEvents } from "../src/mapping/snapshot";
import { createVersionedOpencodeClient, normalizeV2Event } from "../src/v2-client";

const info = {
  id: "ses_v2",
  projectID: "p1",
  title: "v2 smoke",
  location: { directory: "/repo" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
};
const user = {
  id: "msg_user",
  type: "user",
  text: "Reply with OK",
  time: { created: 2 },
};

function requestOf(input: Request | URL | string): Request {
  return input instanceof Request ? input : new Request(input);
}

describe("OpenCode client versions", () => {
  test("an omitted API version keeps the v1 routes", async () => {
    const paths: string[] = [];
    const client = createVersionedOpencodeClient({
      baseUrl: "http://fake",
      fetch: (async (input: Request | URL | string) => {
        const req = requestOf(input);
        paths.push(new URL(req.url).pathname);
        return Response.json(info);
      }) as typeof fetch,
    });
    await client.session.create({ title: "v1", directory: "/repo" });
    expect(paths).toEqual(["/session"]);
  });

  test("v2 prompt and message responses map into a user turn", async () => {
    let promptBody: Record<string, unknown> | undefined;
    let agentBody: Record<string, unknown> | undefined;
    const client = createVersionedOpencodeClient({
      baseUrl: "http://fake",
      apiVersion: "v2",
      fetch: (async (input: Request | URL | string) => {
        const req = requestOf(input);
        const path = new URL(req.url).pathname;
        if (path === "/api/session" && req.method === "POST") return Response.json({ data: info });
        if (path === `/api/session/${info.id}` && req.method === "PATCH") return Response.json({ data: info });
        if (path === `/api/session/${info.id}/agent`) {
          agentBody = (await req.json()) as Record<string, unknown>;
          return Response.json({});
        }
        if (path === `/api/session/${info.id}/prompt`) {
          promptBody = (await req.json()) as Record<string, unknown>;
          return Response.json({ data: user });
        }
        if (path === `/api/session/${info.id}/message`) {
          return Response.json({ data: [user], cursor: { previous: null, next: null } });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });
    const created = await client.session.create({ title: "v2", directory: "/repo" });
    await client.session.promptAsync({
      sessionID: info.id,
      agent: "Build",
      parts: [{ type: "text", text: "Reply with OK" }],
    });
    const messages = await client.session.messages({ sessionID: info.id });
    expect(agentBody?.agent).toBe("build");
    expect(promptBody?.text).toBe("Reply with OK");
    expect(created.data?.directory).toBe("/repo");
    expect(messages.data?.[0]?.info.role).toBe("user");
    expect(messages.data?.[0]?.parts[0]).toMatchObject({ type: "text", text: "Reply with OK" });
  });

  test("an assistant with empty content is rebuilt from durable text history", async () => {
    const assistant = {
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      content: [],
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 3, completed: 4 },
    };
    const client = createVersionedOpencodeClient({
      baseUrl: "http://fake",
      apiVersion: "v2",
      fetch: (async (input: Request | URL | string) => {
        const req = requestOf(input);
        const path = new URL(req.url).pathname;
        if (path === `/api/session/${info.id}/message`) {
          return Response.json({ data: [user, assistant], cursor: { next: null } });
        }
        if (path === `/api/session/${info.id}/history`) {
          const event = (id: string, type: string, data: Record<string, unknown>) => ({
            id,
            type,
            created: 4,
            data: { sessionID: info.id, assistantMessageID: assistant.id, ordinal: 0, ...data },
          });
          return Response.json({
            data: [
              event("t0", "session.text.started", {}),
              event("t1", "session.text.delta", { delta: "OK" }),
              event("t2", "session.text.ended", { text: "OK" }),
            ],
            hasMore: false,
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });
    const messages = await client.session.messages({ sessionID: info.id });
    const mapper = new OpencodeMapper({ directory: "/repo" });
    const events = snapshotEvents(info.id, { ...info, directory: "/repo" }, messages.data!).flatMap((event) => mapper.handle(event));
    const turns = events.filter((event) => event.type === "turn.assistant");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.data).toMatchObject({
      turn_id: user.id,
      msg_id: assistant.id,
      content: [{ type: "text", text: "OK" }],
    });
  });

  test("a v2 inbox event produces the echoed user turn", async () => {
    const enc = new TextEncoder();
    const fakeFetch = async (input: Request | URL | string) => {
      const path = new URL(requestOf(input).url).pathname;
      if (path === "/api/event") {
        const frames = [
          { id: "connected", type: "server.connected", data: {} },
          {
            id: "enqueued",
            type: "session.inbox.enqueued",
            created: 2,
            data: {
              sessionID: info.id,
              inboxID: user.id,
              item: { type: "user", payload: { text: user.text }, delivery: "steer" },
            },
          },
          {
            id: "delivered",
            type: "session.inbox.delivered",
            created: 3,
            data: { sessionID: info.id, inboxID: user.id },
          },
        ];
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              for (const frame of frames) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (path === `/api/session/${info.id}/message`) {
        return Response.json({ data: [user], cursor: { previous: null, next: null } });
      }
      if (path === `/api/session/${info.id}`) return Response.json({ data: info });
      if (path === "/api/session") return Response.json({ data: [info], cursor: { next: null } });
      return Response.json({ data: [] });
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      apiVersion: "v2",
      directory: "/repo",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    try {
      const deadline = Date.now() + 2_000;
      let turns = store.read({ session_id: `opencode:${info.id}` }).filter((event) => event.type === "turn.user");
      while (turns.length === 0 && Date.now() < deadline) {
        await Bun.sleep(20);
        turns = store.read({ session_id: `opencode:${info.id}` }).filter((event) => event.type === "turn.user");
      }
      expect(turns.length).toBe(1);
      expect(turns[0]!.data).toMatchObject({ turn_id: user.id });
    } finally {
      conn.stop();
      store.close();
    }
  });

  test("a terminal event rereads the settled assistant projection", async () => {
    const enc = new TextEncoder();
    const assistant = {
      id: "msg_late_assistant",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      content: [],
      finish: "stop",
      cost: 0,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 3, completed: 4 },
    };
    const availableAt = Date.now() + 400;
    const fakeFetch = async (input: Request | URL | string) => {
      const path = new URL(requestOf(input).url).pathname;
      if (path === "/api/event") {
        const frames = [
          { id: "connected", type: "server.connected", data: {} },
          {
            id: "enqueued",
            type: "session.inbox.enqueued",
            created: 2,
            data: {
              sessionID: info.id,
              inboxID: user.id,
              item: { type: "user", payload: { text: user.text }, delivery: "steer" },
            },
          },
          { id: "delivered", type: "session.inbox.delivered", created: 3, data: { sessionID: info.id, inboxID: user.id } },
          {
            id: "step",
            type: "session.step.ended",
            created: 4,
            data: {
              sessionID: info.id,
              assistantMessageID: assistant.id,
              finish: "stop",
              cost: 0,
              tokens: assistant.tokens,
            },
          },
          { id: "done", type: "session.execution.succeeded", created: 5, data: { sessionID: info.id } },
        ];
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              for (const frame of frames) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (path === `/api/session/${info.id}/message`) {
        return Response.json({ data: Date.now() < availableAt ? [user] : [user, assistant], cursor: { next: null } });
      }
      if (path === `/api/session/${info.id}/history`) {
        return Response.json({
          data: [
            { id: "t0", type: "session.text.started", created: 4, data: { sessionID: info.id, assistantMessageID: assistant.id, ordinal: 0 } },
            { id: "t1", type: "session.text.ended", created: 4, data: { sessionID: info.id, assistantMessageID: assistant.id, ordinal: 0, text: "OK" } },
          ],
          hasMore: false,
        });
      }
      if (path === `/api/session/${info.id}`) return Response.json({ data: info });
      if (path === "/api/session") return Response.json({ data: [info], cursor: { next: null } });
      return Response.json({ data: [] });
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      apiVersion: "v2",
      directory: "/repo",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    try {
      const deadline = Date.now() + 2_500;
      let turns = store.read({ session_id: `opencode:${info.id}` }).filter((event) => event.type === "turn.assistant");
      while (turns.length === 0 && Date.now() < deadline) {
        await Bun.sleep(25);
        turns = store.read({ session_id: `opencode:${info.id}` }).filter((event) => event.type === "turn.assistant");
      }
      expect(turns).toHaveLength(1);
      expect(turns[0]!.data).toMatchObject({ msg_id: assistant.id, content: [{ type: "text", text: "OK" }], stop_reason: "stop" });
      const all = store.read({ session_id: `opencode:${info.id}` });
      expect(all.some((event) => event.id.endsWith(":turn.assistant:idle"))).toBe(false);
    } finally {
      conn.stop();
      store.close();
    }
  });

  test("a v2 permission reply posts decision and a 204 counts as answered", async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const client = createVersionedOpencodeClient({
      baseUrl: "http://fake",
      apiVersion: "v2",
      fetch: (async (input: Request | URL | string) => {
        const req = requestOf(input);
        const path = new URL(req.url).pathname;
        const body = req.method === "POST" ? ((await req.json()) as unknown) : undefined;
        calls.push({ path, method: req.method, body });
        if (path === "/api/permission/request") {
          return Response.json({
            data: [
              {
                id: "per_1",
                sessionID: "ses_1",
                action: "shell",
                resources: ["ls", "head -40"],
                source: { type: "tool", messageID: "msg_1", id: "call_1" },
              },
            ],
          });
        }
        if (path === "/api/session/ses_1/permission/per_1/reply") return new Response(null, { status: 204 });
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });
    const listed = await client.permission.list({ directory: "/repo" });
    expect(listed.data?.[0]).toMatchObject({
      permission: "shell",
      patterns: ["ls", "head -40"],
      tool: { messageID: "msg_1", callID: "call_1" },
    });
    const replied = await client.permission.reply({ requestID: "per_1", reply: "once", directory: "/repo" });
    expect(replied.data).toBe(true);
    expect(replied.error).toBeUndefined();
    const post = calls.find((call) => call.path.endsWith("/reply"));
    expect(post?.method).toBe("POST");
    expect(post?.body).toEqual({ decision: "once" });
  });
});

describe("v2 permission events", () => {
  test("permission.v2.asked becomes a shell permission with the call id", () => {
    const event = normalizeV2Event(
      {
        type: "permission.v2.asked",
        properties: {
          id: "per_1",
          sessionID: "ses_1",
          action: "shell",
          resources: ["ls", "head -40"],
          source: { type: "tool", messageID: "msg_1", id: "call_1" },
        },
      },
      new Map(),
    );
    expect(event?.type).toBe("permission.asked");
    expect(event?.properties).toMatchObject({
      permission: "shell",
      patterns: ["ls", "head -40"],
      tool: { messageID: "msg_1", callID: "call_1" },
    });
  });

  test("permission.v2.replied carries decision as the reply", () => {
    const event = normalizeV2Event(
      {
        type: "permission.v2.replied",
        properties: { sessionID: "ses_1", requestID: "per_1", decision: "reject" },
      },
      new Map(),
    );
    expect(event?.type).toBe("permission.replied");
    expect(event?.properties).toMatchObject({ requestID: "per_1", reply: "reject" });
  });
});
