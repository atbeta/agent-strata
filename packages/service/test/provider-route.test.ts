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
        anthropic: [{ type: "api", label: "API key" }],
        copilot: [{ type: "oauth", label: "Sign in" }],
      }),
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
      providers: [{ id: "anthropic", name: "Anthropic", connected: true, label: "API key" }],
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
});
