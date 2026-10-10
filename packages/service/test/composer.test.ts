import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";

const png = "data:image/png;base64,iVBORw0KGgo=";

describe("the composer through strata", () => {
  const upstream = fakeOpencode({
    "/session/ses_x/prompt_async": () => new Response(null, { status: 204 }),
  });
  let svc: ReturnType<typeof startService>;
  let base = "";
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = `/sessions/${encodeURIComponent("opencode:ses_x")}`;
  const sent = () =>
    JSON.parse(upstream.seen.filter((s) => s.path === "/session/ses_x/prompt_async").at(-1)!.body) as {
      parts: unknown[];
      agent?: string;
    };

  beforeAll(async () => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
    await post("/connect", { baseUrl: upstream.baseUrl, directory: "/conn" });
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_x",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "x", workspace: "/repo/x" },
      } as EventInput),
    ]);
  });
  afterAll(() => {
    svc.stop();
    upstream.stop();
  });

  test("a session says what its backend's composer can do", async () => {
    expect(await fetch(`${base}${session}/capabilities`).then((r) => r.json())).toEqual({
      connected: true,
      prompt: true,
      abort: true,
      commands: true,
      attachments: true,
      extension: "opencode",
    });
    expect(
      await fetch(`${base}/sessions/${encodeURIComponent("acp:nobody:1")}/capabilities`).then((r) => r.json()),
    ).toEqual({ connected: false });
    expect((await fetch(`${base}/sessions/%E0%A4%A/capabilities`)).status).toBe(404);
  });

  test("text, a workspace file and an image reach OpenCode as its own parts", async () => {
    const res = await post(`${session}/prompt`, {
      agent: "plan",
      parts: [
        { type: "text", text: "@src/a.ts and this" },
        { type: "file_ref", path: "src/a.ts", mention: { start: 0, end: 9 } },
        { type: "attachment", mime: "image/png", url: png, filename: "shot.png" },
      ],
    });
    expect(res.status).toBe(200);
    expect(sent()).toMatchObject({
      agent: "plan",
      parts: [
        { type: "text", text: "@src/a.ts and this" },
        {
          type: "file",
          mime: "text/plain",
          filename: "a.ts",
          url: pathToFileURL(resolve("/repo/x", "src/a.ts")).href,
          source: { type: "file", path: "src/a.ts", text: { value: "@src/a.ts", start: 0, end: 9 } },
        },
        { type: "file", mime: "image/png", url: png, filename: "shot.png" },
      ],
    });
  });

  test("the old text body still works, and a bad part never leaves strata", async () => {
    expect((await post(`${session}/prompt`, { text: "plain" })).status).toBe(200);
    expect(sent().parts).toEqual([{ type: "text", text: "plain" }]);
    const before = upstream.seen.length;
    const res = await post(`${session}/prompt`, { parts: [{ type: "file_ref", path: "../x" }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/workspace/);
    expect(upstream.seen.length).toBe(before);
  });
});

describe("a session with no workspace", () => {
  const upstream = fakeOpencode({
    "/session/ses_y/prompt_async": () => new Response(null, { status: 204 }),
  });
  let svc: ReturnType<typeof startService>;
  let base = "";
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
    await post("/connect", { baseUrl: upstream.baseUrl });
  });
  afterAll(() => {
    svc.stop();
    upstream.stop();
  });

  test("cannot send a workspace file, and says so before OpenCode hears of it", async () => {
    const res = await post(`/sessions/${encodeURIComponent("opencode:ses_y")}/prompt`, {
      parts: [{ type: "text", text: "look" }, { type: "file_ref", path: "a.ts" }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("session has no workspace to read files from");
    expect(upstream.seen.some((s) => s.path === "/session/ses_y/prompt_async")).toBe(false);
  });
});
