import { describe, expect, test } from "bun:test";
import {
  runOpencodeStream,
  pickableProviders,
} from "../src/index";
import { openStore } from "@agent-strata/store";
import { type EventInput } from "@agent-strata/schema";

const dir = process.env.OPENCODE_DIR ?? "/tmp";

describe("connectOpencode lifecycle", () => {
  test("stop() aborts the SSE fetch signal", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    let fetchSignal: AbortSignal | undefined;
    const fakeFetch = async (input: Request | URL | string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(
            enc.encode('data: {"type":"server.connected","properties":{}}\n\n'),
          );
          // stream stays open forever
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal!.aborted).toBe(false);
    conn.stop();
    expect(fetchSignal!.aborted).toBe(true);
    store.close();
  });

  test("a request that stays quiet for minutes is not cut by Bun's idle timeout", async () => {
    const { connectOpencode } = await import("../src/index");
    let fetchInit: RequestInit | undefined;
    const fakeFetch = async (_input: Request | URL | string, init?: RequestInit) => {
      fetchInit = init;
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    expect((fetchInit as { timeout?: unknown } | undefined)?.timeout).toBe(false);
    conn.stop();
    store.close();
  });

  test("connect timeout aborts the fetch and rejects", async () => {
    const { connectOpencode } = await import("../src/index");
    let fetchSignal: AbortSignal | undefined;
    const fakeFetch = async (input: Request | URL | string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      // stream that never emits anything
      const body = new ReadableStream<Uint8Array>({ start() {} });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const store = openStore(":memory:");
    await expect(
      connectOpencode({
        baseUrl: "http://fake",
        sink: store,
        fetch: fakeFetch as typeof fetch,
        connectTimeoutMs: 50,
      }),
    ).rejects.toThrow(/no events within/);
    expect(fetchSignal?.aborted).toBe(true);
    store.close();
  });

  test("a quiet server spends the connect timeout once", async () => {
    const { connectOpencode } = await import("../src/index");
    const fakeFetch = async (_input: Request | URL | string, _init?: RequestInit) =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const store = openStore(":memory:");
    const started = Date.now();
    await expect(
      connectOpencode({
        baseUrl: "http://fake",
        sink: store,
        fetch: fakeFetch as typeof fetch,
        connectTimeoutMs: 300,
      }),
    ).rejects.toThrow(/no events within/);
    expect(Date.now() - started).toBeLessThan(500);
    store.close();
  });

  test("a closed event stream is opened again", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    let eventOpens = 0;
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/global/event") || url.endsWith("/event")) {
        eventOpens += 1;
        const stay = eventOpens > 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
              if (!stay) ctrl.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json([]);
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    const deadline = Date.now() + 4_000;
    while (eventOpens < 2 && Date.now() < deadline) await Bun.sleep(50);
    expect(eventOpens).toBeGreaterThanOrEqual(2);
    conn.stop();
    store.close();
  });

  test("a prompt OpenCode rejects does not repeat the text", async () => {
    const { connectOpencode } = await import("../src/index");
    const secret = "secret-prompt-value-xx";
    const enc = new TextEncoder();
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/global/event") || url.endsWith("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.includes("prompt_async")) return Response.json({ message: `rejected ${secret}` }, { status: 400 });
      return Response.json([]);
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    const failed = conn.prompt("ses", [{ type: "text", text: secret }]);
    await expect(failed).rejects.toThrow("prompt was not accepted");
    await expect(failed.catch((err: Error) => err.message)).resolves.not.toContain(secret);
    conn.stop();
    store.close();
  });

  test("a prompt that is never accepted fails and keeps the text out", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      const signal = input instanceof Request ? input.signal : undefined;
      if (url.includes("/global/event") || url.endsWith("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.includes("prompt_async")) {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        });
      }
      return Response.json([]);
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
      promptAcceptMs: 80,
    });
    const started = Date.now();
    await expect(conn.prompt("ses", [{ type: "text", text: "hello from the composer" }])).rejects.toThrow(
      "prompt was not accepted",
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    conn.stop();
    store.close();
  });

  test("an accepted abort resolves and checks status", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    let aborts = 0;
    let statuses = 0;
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/global/event") || url.endsWith("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.endsWith("/abort")) {
        aborts++;
        return Response.json(true);
      }
      if (url.includes("/session/status")) {
        statuses++;
        return Response.json({});
      }
      return Response.json([]);
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });

    await conn.abort("ses");

    expect(aborts).toBe(1);
    expect(statuses).toBeGreaterThan(0);
    conn.stop();
    store.close();
  });

  test("an abort request that hangs reaches its deadline", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      const signal = input instanceof Request ? input.signal : undefined;
      if (url.includes("/global/event") || url.endsWith("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.endsWith("/abort")) {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        });
      }
      return Response.json([]);
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
      abortTimeoutMs: 60,
    });

    const started = Date.now();
    await expect(conn.abort("ses")).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(1_000);
    conn.stop();
    store.close();
  });
});


describe("importSession revision", () => {
  test("an unchanged session costs only the info fetch; force pays for messages", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    let messageCalls = 0;
    const info = {
      id: "ses_rev",
      sessionID: "ses_rev",
      title: "T",
      directory: dir,
      time: { created: 1, updated: 42 },
    };
    const messages = [
      {
        info: { id: "u1", sessionID: "ses_rev", role: "user", time: { created: 10 } },
        parts: [
          { id: "p1", sessionID: "ses_rev", messageID: "u1", type: "text", text: "hi" },
        ],
      },
    ];
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/session/ses_rev/message")) {
        messageCalls++;
        return Response.json(messages);
      }
      if (url.includes("/session/ses_rev")) return Response.json(info);
      if (url.includes("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(
                enc.encode('data: {"type":"server.connected","properties":{}}\n\n'),
              );
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    try {
      expect(await conn.importSession("ses_rev", dir)).toBe(true);
      expect(messageCalls).toBe(1);
      // Same time.updated -> the transcript fetch is skipped entirely.
      expect(await conn.importSession("ses_rev", dir)).toBe(false);
      expect(messageCalls).toBe(1);
      expect(await conn.importSession("ses_rev", dir, { force: true })).toBe(true);
      expect(messageCalls).toBe(2);
    } finally {
      conn.stop();
      store.close();
    }
  });

  test("a transcript lands in one append", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    const info = {
      id: "ses_batch",
      title: "T",
      directory: dir,
      time: { created: 1, updated: 7 },
    };
    const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
    const messages = [
      {
        info: { id: "u1", sessionID: "ses_batch", role: "user", time: { created: 10 } },
        parts: [{ id: "p1", sessionID: "ses_batch", messageID: "u1", type: "text", text: "hi" }],
      },
      {
        info: {
          id: "a1", sessionID: "ses_batch", role: "assistant", parentID: "u1",
          time: { created: 20, completed: 30 }, providerID: "p", modelID: "m",
          cost: 0, tokens, finish: "stop",
        },
        parts: [{ id: "p2", sessionID: "ses_batch", messageID: "a1", type: "text", text: "ok" }],
      },
    ];
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/session/ses_batch/message")) return Response.json(messages);
      if (url.includes("/session/ses_batch")) return Response.json(info);
      if (url.includes("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const store = openStore(":memory:");
    let appends = 0;
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: {
        append(events) {
          appends += 1;
          return store.append(events);
        },
        sessionRevision: (id) => store.sessionRevision(id),
        markRevision: (id, rev) => store.markRevision(id, rev),
      },
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    try {
      expect(await conn.importSession("ses_batch", dir)).toBe(true);
      expect(appends).toBe(1);
      const types = store.read({ session_id: "opencode:ses_batch" }).map((e) => e.type);
      expect(types).toContain("turn.user");
      expect(types).toContain("turn.assistant");
    } finally {
      conn.stop();
      store.close();
    }
  });
});

describe("sync stays off the live path", () => {
  test("a status, an idle and a session.next do not reread the transcript", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    const sse = (chunks: string[]) =>
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          for (const c of chunks) ctrl.enqueue(enc.encode(`data: ${c}\n\n`));
        },
      });
    const frame = (type: string, id: string) =>
      JSON.stringify({
        directory: "/repo",
        payload: { id, type, properties: { sessionID: "ses_live", status: { type: "busy" } } },
      });
    let messageCalls = 0;
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/message")) {
        messageCalls += 1;
        return Response.json([]);
      }
      if (url.includes("/global/event") || url.includes("/event")) {
        return new Response(
          sse([
            '{"type":"server.connected","properties":{}}',
            frame("session.status", "st1"),
            frame("session.idle", "id1"),
            frame("session.next.step", "n1"),
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json([]);
    };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    try {
      // Longer than the old 400ms forced reimport.
      await Bun.sleep(600);
      expect(messageCalls).toBe(0);
    } finally {
      conn.stop();
      store.close();
    }
  });

  test("two changed sessions are written one at a time, with a turn of the event loop between them", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
    const info = (id: string, updated: number) => ({
      id,
      title: id,
      directory: "/repo",
      time: { created: 1, updated },
    });
    const messages = (id: string) => [
      {
        info: { id: `${id}-u`, sessionID: id, role: "user", time: { created: 10 } },
        parts: [{ id: `${id}-p`, sessionID: id, messageID: `${id}-u`, type: "text", text: "hi" }],
      },
      {
        info: {
          id: `${id}-a`, sessionID: id, role: "assistant", parentID: `${id}-u`,
          time: { created: 20, completed: 30 }, providerID: "p", modelID: "m",
          cost: 0, tokens, finish: "stop",
        },
        parts: [{ id: `${id}-ap`, sessionID: id, messageID: `${id}-a`, type: "text", text: "ok" }],
      },
    ];
    const fakeFetch = async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      const path = new URL(url).pathname;
      if (path === "/session") {
        return Response.json([info("ses_a", 10), info("ses_b", 11)]);
      }
      if (path.endsWith("/message")) {
        const id = path.split("/")[2]!;
        return Response.json(messages(id));
      }
      if (path.endsWith("/children")) return Response.json([]);
      if (path.startsWith("/session/")) {
        const id = path.split("/")[2]!;
        return Response.json(info(id, id === "ses_a" ? 10 : 11));
      }
      if (url.includes("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json([]);
    };
    const store = openStore(":memory:");
    let transcripts = 0;
    let turn = false;
    let yieldedBeforeSecond = false;
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: {
        append(events) {
          const heavy = events.some((e) => e.type === "turn.user" || e.type === "turn.assistant");
          if (heavy) {
            transcripts += 1;
            if (transcripts === 1) setTimeout(() => {
              turn = true;
            }, 0);
            // A timer queued by the first write has run only if that write
            // gave the event loop a turn before this one started.
            if (transcripts === 2) yieldedBeforeSecond = turn;
          }
          return store.append(events);
        },
        sessionRevision: (id) => store.sessionRevision(id),
        markRevision: (id, rev) => store.markRevision(id, rev),
      },
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    try {
      await conn.refreshSessions();
    } finally {
      conn.stop();
      store.close();
    }
    expect(transcripts).toBe(2);
    expect(yieldedBeforeSecond).toBe(true);
  });
});

describe("sync reconciles local sessions", () => {
  const enc = new TextEncoder();
  const sse = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode('data: {"type":"server.connected","properties":{}}\n\n'));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const info = (id: string, updated = 10) => ({
    id,
    title: id,
    directory: "/repo",
    time: { created: 1, updated },
  });
  /** ses_a is listed; every other session id answers however `gets` says. */
  const fakeFetch =
    (gets: Record<string, "data" | "404" | "throw">) =>
    async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      const path = new URL(url).pathname;
      if (url.includes("/event")) return sse();
      if (path === "/session") return Response.json([info("ses_a")]);
      const m = path.match(/^\/session\/([^/]+)/);
      if (m) {
        const id = decodeURIComponent(m[1]!);
        if (path.endsWith("/children") || path.endsWith("/message")) return Response.json([]);
        const mode = gets[id] ?? "data";
        if (mode === "throw") throw new Error("connection refused");
        if (mode === "404") return new Response("{}", { status: 404 });
        return Response.json(info(id, 20));
      }
      return Response.json([]);
    };
  const syncWith = async (
    local: { id: string; directory?: string }[],
    gets: Record<string, "data" | "404" | "throw">,
  ) => {
    const { connectOpencode } = await import("../src/index");
    const store = openStore(":memory:");
    const appended: EventInput[] = [];
    const reconciled: string[] = [];
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: {
        append(events) {
          appended.push(...events);
          return store.append(events);
        },
        sessionRevision: (id) => store.sessionRevision(id),
        markRevision: (id, rev) => store.markRevision(id, rev),
      },
      fetch: fakeFetch(gets) as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    try {
      await conn.refreshSessions({
        local: () => local,
        reconciled: (id) => reconciled.push(id),
      });
      return {
        deleted: appended.filter((e) => e.type === "session.deleted").map((e) => e.session_id),
        updated: appended.filter((e) => e.type === "session.updated").map((e) => e.session_id),
        reconciled,
      };
    } finally {
      conn.stop();
      store.close();
    }
  };

  test("a local session the upstream 404s is marked deleted", async () => {
    const r = await syncWith([{ id: "ses_gone", directory: "/repo" }], { ses_gone: "404" });
    expect(r.reconciled).toEqual(["opencode:ses_gone"]);
    expect(r.deleted).toContain("opencode:ses_gone");
    expect(r.deleted).not.toContain("opencode:ses_a");
  });

  test("a missed session the upstream still answers for is collected, not deleted", async () => {
    const r = await syncWith([{ id: "ses_b", directory: "/repo" }], { ses_b: "data" });
    expect(r.reconciled).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(r.updated).toContain("opencode:ses_b");
  });

  test("a lookup that never reached the server deletes nothing", async () => {
    const r = await syncWith([{ id: "ses_c", directory: "/repo" }], { ses_c: "throw" });
    expect(r.reconciled).toEqual([]);
    expect(r.deleted).toEqual([]);
  });

  test("no local guard means no reconciliation", async () => {
    const { connectOpencode } = await import("../src/index");
    const store = openStore(":memory:");
    const appended: EventInput[] = [];
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: {
        append(events) {
          appended.push(...events);
          return store.append(events);
        },
        sessionRevision: (id) => store.sessionRevision(id),
        markRevision: (id, rev) => store.markRevision(id, rev),
      },
      fetch: fakeFetch({ ses_z: "404" }) as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    try {
      await conn.refreshSessions();
      expect(appended.filter((e) => e.type === "session.deleted")).toEqual([]);
    } finally {
      conn.stop();
      store.close();
    }
  });
});

describe("pickable providers", () => {
  const catalog = [
    { id: "deepseek", source: "api", env: ["DEEPSEEK_API_KEY"] },
    { id: "minimax-cn-coding-plan", source: "api", env: ["MINIMAX_API_KEY"] },
    { id: "minimax-coding-plan", source: "env", env: ["MINIMAX_API_KEY"] },
    { id: "minimax-cn", source: "env", env: ["MINIMAX_API_KEY"] },
    { id: "minimax", source: "env", env: ["MINIMAX_API_KEY"] },
    { id: "opencode-go", source: "api", env: ["OPENCODE_API_KEY"] },
    { id: "opencode", source: "custom", env: ["OPENCODE_API_KEY"] },
    { id: "openai", source: "env", env: ["OPENAI_API_KEY"] },
  ];

  test("a stored key does not make every sibling that names the same env var pickable", () => {
    const ids = pickableProviders(catalog, [
      "deepseek",
      "minimax-cn-coding-plan",
      "minimax-coding-plan",
      "minimax-cn",
      "minimax",
      "opencode-go",
      "opencode",
      "openai",
    ]).map((row) => row.id);
    expect(ids).toEqual(["deepseek", "minimax-cn-coding-plan", "opencode-go", "opencode", "openai"]);
  });

  test("an env var with no stored key is still a credential", () => {
    const ids = pickableProviders(
      [{ id: "groq", source: "env", env: ["GROQ_API_KEY"] }],
      ["groq"],
    ).map((row) => row.id);
    expect(ids).toEqual(["groq"]);
  });
});

describe("runOpencodeStream", () => {
  /** A queue-backed async generator: what the SSE client gives us. */
  const feed = (signal?: AbortSignal) => {
    const END = Symbol("end");
    const q: unknown[] = [];
    let wait: (() => void) | undefined;
    let ended = false;
    const gen = (async function* () {
      for (;;) {
        if (!q.length) await new Promise<void>((r) => (wait = r));
        const v = q.shift()!;
        if (v === END) return;
        yield v;
      }
    })();
    const stop = () => {
      if (ended) return;
      ended = true;
      q.push(END);
      wait?.();
      wait = undefined;
    };
    // A real SSE stream is torn down by its abort signal, so the double is
    // too: that is how a closed bus is told apart from an idle one.
    signal?.addEventListener("abort", stop, { once: true });
    return {
      gen,
      push: (v: unknown) => {
        q.push(v);
        wait?.();
        wait = undefined;
      },
      close: stop,
      ended: () => ended,
    };
  };
  const fakeClient = (
    sessions: { directory: string }[] = [],
    opts: { globalFails?: number } = {},
  ) => {
    const globals: ReturnType<typeof feed>[] = [];
    const dirs = new Map<string, ReturnType<typeof feed>[]>();
    let globalFails = opts.globalFails ?? 0;
    const client = {
      global: {
        // server.connected is the first frame a real stream always sends.
        event: async (o?: { signal?: AbortSignal }) => {
          // A server that is not ready yet rejects the global bus: measured on
          // an embedded server still warming up, it answers the root bus first.
          if (globalFails > 0) {
            globalFails -= 1;
            throw new Error("global bus unavailable");
          }
          const f = feed(o?.signal);
          globals.push(f);
          f.push({ type: "server.connected" });
          return { stream: f.gen };
        },
      },
      event: {
        subscribe: async (o: { directory?: string; signal?: AbortSignal }) => {
          const f = feed(o?.signal);
          const d = o?.directory ?? "";
          const list = dirs.get(d) ?? [];
          list.push(f);
          dirs.set(d, list);
          // a real bus opens with server.connected, whatever it watches
          f.push({ type: "server.connected" });
          return { stream: f.gen };
        },
      },
      project: { list: async () => ({ data: [] }) },
      session: { list: async () => ({ data: sessions }) },
    };
    return { client: client as never, globals, dirs };
  };

  test("a silent stream is re-opened through the global bus again", async () => {
    const { client, globals, dirs } = fakeClient();
    const abort = new AbortController();
    let reconnects = 0;
    await runOpencodeStream({
      client,
      abort,
      connectTimeout: 500,
      silenceMs: 150,
      handle: () => {},
      onReconnect: () => reconnects++,
    });
    expect(globals.length).toBe(1);
    await Bun.sleep(1_800);
    // The wedged stream was abandoned and a new one opened — on the global
    // bus, not on a single-directory fallback.
    expect(globals.length).toBeGreaterThanOrEqual(2);
    expect(dirs.has("")).toBe(false);
    expect(reconnects).toBeGreaterThanOrEqual(1);
    abort.abort();
  });

  test("a stream that ends re-opens", async () => {
    const { client, globals } = fakeClient();
    const abort = new AbortController();
    await runOpencodeStream({
      client,
      abort,
      connectTimeout: 500,
      silenceMs: 5_000,
      handle: () => {},
      onReconnect: () => {},
    });
    globals[0]!.close();
    await Bun.sleep(1_200);
    expect(globals.length).toBeGreaterThanOrEqual(2);
    abort.abort();
  });

  test("a stream that keeps talking is left alone", async () => {
    const { client, globals } = fakeClient();
    const abort = new AbortController();
    await runOpencodeStream({
      client,
      abort,
      connectTimeout: 500,
      silenceMs: 200,
      handle: () => {},
      onReconnect: () => {},
    });
    const beat = setInterval(
      () => globals[0]!.push({ type: "server.heartbeat" }),
      60,
    );
    await Bun.sleep(500);
    clearInterval(beat);
    expect(globals.length).toBe(1);
    abort.abort();
  });

  test("the global bus carries every project, so no other socket is opened", async () => {
    // The global bus reaches every directory. A socket per project on top of
    // it is what the server's listener limit complained about — 52 of them
    // at steady state — so it is opened only when the global one is missing.
    const { client, globals, dirs } = fakeClient([{ directory: "/repo" }]);
    const abort = new AbortController();
    await runOpencodeStream({
      client,
      abort,
      connectTimeout: 500,
      silenceMs: 5_000,
      handle: () => {},
      onReconnect: () => {},
    });
    await Bun.sleep(200);
    expect(globals.length).toBe(1);
    expect(dirs.size).toBe(0);
    abort.abort();
  });

  test("a session in another directory is reached when the global bus is missing", async () => {
    // The global bus is the one that carries every project, but it is not
    // always there: an embedded server still warming up when the service
    // attaches answers the single-directory bus first. That bus watches the
    // server's own root, and the root carries nothing for a session that
    // lives elsewhere — measured on a live server, the root bus delivered
    // `server.connected` and heartbeats while a session in a project
    // directory produced every frame of its turn elsewhere.
    //
    // A session nobody hears from is a session that never says it is working:
    // the busy mark comes from work evidence, and work evidence is a frame.
    // So the session's own directory gets a bus, and the frames come back.
    const dirs = new Map<string, ReturnType<typeof feed>[]>();
    const client = {
      global: {
        event: async () => {
          throw new Error("404 not found");
        },
      },
      event: {
        subscribe: async (o: { directory?: string }) => {
          const f = feed();
          const d = o?.directory ?? "";
          const list = dirs.get(d) ?? [];
          list.push(f);
          dirs.set(d, list);
          f.push({ type: "server.connected" });
          return { stream: f.gen };
        },
      },
      project: { list: async () => ({ data: [{ id: "p1", worktree: "/repo" }] }) },
      session: { list: async () => ({ data: [{ id: "ses_1", directory: "/repo" }] }) },
    };
    const abort = new AbortController();
    const seen: string[] = [];
    await runOpencodeStream({
      client: client as never,
      abort,
      connectTimeout: 500,
      silenceMs: 5_000,
      handle: (evt) => {
        seen.push(evt.type);
      },
      onReconnect: () => {},
    });
    await Bun.sleep(200);
    // the session's own directory is watched
    expect(dirs.has("/repo")).toBe(true);
    // and its frames reach the mapper
    dirs.get("/repo")![0]!.push({
      type: "message.updated",
      properties: {
        sessionID: "ses_1",
        info: { id: "u1", sessionID: "ses_1", role: "user", time: { created: 10 } },
      },
    });
    await Bun.sleep(100);
    expect(seen).toContain("message.updated");
    abort.abort();
  });

  test("a fallback keeps asking for the global bus and closes the per-directory buses when it arrives", async () => {
    // The global bus is missing for a reason that may pass: an embedded
    // server still warming up when the service attaches answers the root bus
    // first and the global one a second later. A fallback that never asks
    // again is stuck on the root bus for the life of the process — and the
    // root bus carries nothing for a session that lives outside the server's
    // own root, so the per-directory buses have to make up for it with a
    // socket each. When the global bus finally answers, it reaches every
    // directory on its own and those sockets are not needed any more.
    const { client, globals, dirs } = fakeClient([{ directory: "/repo" }], { globalFails: 1 });
    const abort = new AbortController();
    await runOpencodeStream({
      client,
      abort,
      connectTimeout: 500,
      silenceMs: 5_000,
      globalProbeMs: 100,
      globalRetryMs: 300,
      handle: () => {},
      onReconnect: () => {},
    });
    await Bun.sleep(200);
    // the global bus refused, so the root bus is in use and the directory
    // that is known gets a bus of its own
    expect(dirs.has("/repo")).toBe(true);
    expect(dirs.get("/repo")![0]!.ended()).toBe(false);
    // and the retry finds the global bus
    await Bun.sleep(1_800);
    expect(globals.length).toBeGreaterThanOrEqual(1);
    // the per-directory bus is closed: the global one reaches it
    expect(dirs.get("/repo")![0]!.ended()).toBe(true);
    abort.abort();
  });

  test("a directory bus that ends is opened again", async () => {
    // The per-directory bus is the only thing carrying a session that lives
    // outside the server's own root. When it ends — a server restart, a
    // socket the network dropped — the session in it goes quiet, and the
    // reader sees a session that never says it is working.
    //
    // The attempt that ended used to abort the controller the next attempt
    // was about to use, so the loop found itself aborted and left: the bus
    // of that directory was opened exactly once and never again, and the
    // entry in the table kept it from being opened even later.
    const { client, dirs } = fakeClient([{ directory: "/repo" }], { globalFails: 99 });
    const abort = new AbortController();
    await runOpencodeStream({
      client,
      abort,
      connectTimeout: 500,
      silenceMs: 5_000,
      globalProbeMs: 50,
      globalRetryMs: 150,
      handle: () => {},
      onReconnect: () => {},
    });
    await Bun.sleep(600);
    expect(dirs.get("/repo")!.length).toBe(1);

    // The bus ends.
    dirs.get("/repo")![0]!.close();
    // And a new one is opened for the same directory.
    for (let i = 0; i < 60; i++) {
      if (dirs.get("/repo")!.length > 1) break;
      await Bun.sleep(50);
    }
    expect(dirs.get("/repo")!.length).toBeGreaterThan(1);
    abort.abort();
  });

  test("a fallback that never gets the global bus keeps the sockets it opened", async () => {
    // The other half of the promise: a server that never offers the global
    // bus must not be left with a session nobody hears from. The per-directory
    // buses stay open, and a directory that appears later is still learned.
    const { client, globals, dirs } = fakeClient([{ directory: "/repo" }], { globalFails: 99 });
    const abort = new AbortController();
    await runOpencodeStream({
      client,
      abort,
      connectTimeout: 500,
      silenceMs: 5_000,
      globalProbeMs: 50,
      globalRetryMs: 150,
      handle: () => {},
      onReconnect: () => {},
    });
    await Bun.sleep(600);
    expect(dirs.has("/repo")).toBe(true);
    expect(dirs.get("/repo")![0]!.ended()).toBe(false);
    expect(globals.length).toBe(0);
    abort.abort();
  });
});
