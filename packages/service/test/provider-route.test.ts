import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";

const secret = "sk-live-secret";

describe("provider api keys", () => {
  const upstream = fakeOpencode({
    "/provider": () =>
      Response.json({
        all: [
          { id: "anthropic", name: "Anthropic", key: secret, models: {} },
          { id: "copilot", name: "GitHub Copilot" },
        ],
        connected: ["anthropic"],
        default: {},
      }),
    "/provider/auth": () =>
      Response.json({
        anthropic: [
          { type: "api", label: "API key" },
          { type: "oauth", label: "Claude Max" },
        ],
        copilot: [{ type: "oauth", label: "Sign in" }],
      }),
    "/provider/anthropic/oauth/authorize": async (_url, req) => {
      const body = (await req.json()) as { method?: number };
      if (body.method !== 1) return Response.json({ message: "not oauth" }, { status: 400 });
      return Response.json({
        url: "https://auth.example/start?ticket=secret-ticket",
        method: "code",
        instructions: "paste the code",
        access_token: secret,
      });
    },
    "/provider/anthropic/oauth/callback": async (_url, req) => {
      const body = (await req.json()) as { code?: string };
      if (body.code === "nope") return Response.json({ message: `rejected ${body.code}` }, { status: 400 });
      return Response.json(true);
    },
    "/auth/anthropic": async (url, req) => {
      if (req.method === "PUT") {
        const body = (await req.json()) as { key?: string };
        if (body.key === "nope") return Response.json({ message: `rejected ${body.key}` }, { status: 400 });
        return Response.json(true);
      }
      if (req.method === "DELETE") return Response.json(true);
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  let svc: ReturnType<typeof startService>;
  let base = "";
  let connId = "";

  beforeAll(async () => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: upstream.baseUrl, directory: "/conn" }),
    });
    connId = ((await res.json()) as { id: string }).id;
  });
  afterAll(() => {
    svc.stop();
    upstream.stop();
  });

  const root = () => `${base}/connections/${encodeURIComponent(connId)}/providers`;

  test("the list names api providers and leaves the key behind", async () => {
    const res = await fetch(root());
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text.includes(secret)).toBe(false);
    expect(JSON.parse(text)).toEqual({
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          connected: true,
          methods: [
            { index: 0, type: "api", label: "API key" },
            { index: 1, type: "oauth", label: "Claude Max" },
          ],
        },
        {
          id: "copilot",
          name: "GitHub Copilot",
          connected: false,
          methods: [{ index: 0, type: "oauth", label: "Sign in" }],
        },
      ],
    });
    expect((await fetch(`${base}/connections/${encodeURIComponent(connId)}/opencode/provider`)).status).toBe(404);
  });

  test("a key is stored and the reply does not repeat it", async () => {
    const res = await fetch(`${root()}/anthropic`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: secret }),
    });
    expect(await res.text()).toBe(JSON.stringify({ ok: true }));
    const put = [...upstream.seen].reverse().find((hit) => hit.path === "/auth/anthropic" && hit.method === "PUT");
    expect(put?.body).toBe(JSON.stringify({ type: "api", key: secret }));
    expect(put?.query.get("directory")).toBe("/conn");
  });

  test("a rejected key is not quoted back", async () => {
    const res = await fetch(`${root()}/anthropic`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "nope" }),
    });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text.includes("nope")).toBe(false);
  });

  test("an empty key is refused before it is sent", async () => {
    const before = upstream.seen.length;
    const res = await fetch(`${root()}/anthropic`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "  " }),
    });
    expect(res.status).toBe(400);
    expect(upstream.seen.slice(before).some((hit) => hit.path === "/auth/anthropic")).toBe(false);
  });

  test("removing a key does not need the secret", async () => {
    const res = await fetch(`${root()}/anthropic`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect([...upstream.seen].reverse().find((hit) => hit.method === "DELETE")?.path).toBe("/auth/anthropic");
  });

  test("another site cannot set a key", async () => {
    const res = await fetch(`${root()}/anthropic`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ key: secret }),
    });
    expect(res.status).toBe(403);
  });

  test("oauth returns the address without the token OpenCode added", async () => {
    const res = await fetch(`${root()}/anthropic/oauth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: 1 }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text.includes(secret)).toBe(false);
    expect(JSON.parse(text)).toEqual({
      url: "https://auth.example/start?ticket=secret-ticket",
      method: "code",
      instructions: "paste the code",
    });
  });

  test("an api method cannot start oauth", async () => {
    const before = upstream.seen.length;
    const res = await fetch(`${root()}/anthropic/oauth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: 0 }),
    });
    expect(res.status).toBe(400);
    expect(upstream.seen.slice(before).some((hit) => hit.path.endsWith("/oauth/authorize"))).toBe(false);
  });

  test("a callback code is not quoted back", async () => {
    const res = await fetch(`${root()}/anthropic/oauth/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: 1, code: "nope" }),
    });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text.includes("nope")).toBe(false);
  });
});
