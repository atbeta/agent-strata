import { describe, expect, test } from "bun:test";
import { startService } from "../src/index";
import { configDirectory, configDocument, configPatch, safeConfigError } from "../src/config-edit";
import { fakeOpencode } from "./fake-opencode";

describe("config edit", () => {
  test("only changed fields are written", () => {
    expect(configPatch({ model: "a", mcp: { keep: true } }, { model: "b", mcp: { keep: true } })).toEqual({
      patch: { model: "b" },
    });
  });

  test("a removed field is refused", () => {
    expect(configPatch({ mcp: { keep: true, drop: true } }, { mcp: { keep: true } })).toEqual({ error: "removed" });
  });

  test("an unchanged document is not a write", () => {
    expect(configPatch({ model: "a" }, { model: "a" })).toEqual({ error: "same" });
  });

  test("the document has to be a JSON object", () => {
    expect(configDocument("[]")).toEqual({ error: "invalid config" });
    expect(configDocument("{")).toEqual({ error: "invalid config" });
    expect(configDocument('{"model":"a"}')).toEqual({ config: { model: "a" } });
  });

  test("an error that repeats a config value is replaced", () => {
    const url = "https://mcp.example/secret-config-value";
    expect(safeConfigError(new Error(`refused ${url}`), { mcp: { url } })).toBe("config update failed");
    expect(safeConfigError(new Error("expected string"), {})).toBe("expected string");
  });

  test("the directory has to be one the connection already has", () => {
    expect(configDirectory("D:/Code/lector", ["D:\\Code\\lector"])).toBe("D:\\Code\\lector");
    expect(configDirectory("D:/Code/other", ["D:\\Code\\lector"])).toBeUndefined();
    expect(configDirectory("D:/Code/lector/../secret", ["D:\\Code\\lector"])).toBeUndefined();
  });
});

describe("config route", () => {
  test("a change is merged, and a bad document never reaches OpenCode", async () => {
    const secret = "https://mcp.example/secret-config-value";
    const oc = fakeOpencode({
      "/config": async (_url, req) => {
        if (req.method === "PATCH") {
          const body = (await req.json()) as { model?: string };
          if (typeof body.model === "string" && body.model.includes("secret-config-value")) {
            return Response.json({ message: `nope ${body.model}` }, { status: 400 });
          }
          return Response.json({ ok: true });
        }
        return Response.json({ model: "a", mcp: { keep: { url: secret } } });
      },
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const connected = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    const connId = ((await connected.json()) as { id: string }).id;
    const root = `${base}/connections/${encodeURIComponent(connId)}/config`;
    const send = (method: string, body?: string, directory?: string) =>
      fetch(directory ? `${root}?directory=${encodeURIComponent(directory)}` : root, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify({ text: body }),
      });

    const listed = await fetch(root);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ config: { model: "a", mcp: { keep: { url: secret } } } });

    const broken = await send("PATCH", "{");
    expect(broken.status).toBe(400);
    const removed = await send("PATCH", JSON.stringify({ model: "a" }));
    expect(removed.status).toBe(400);
    expect(await removed.json()).toEqual({ error: "config cannot remove fields" });
    const same = await send("PATCH", JSON.stringify({ model: "a", mcp: { keep: { url: secret } } }));
    expect(same.status).toBe(200);
    const elsewhere = await send("PATCH", JSON.stringify({ model: "b", mcp: { keep: { url: secret } } }), "C:/Windows");
    expect(elsewhere.status).toBe(400);

    const leaked = await send("PATCH", JSON.stringify({ model: secret, mcp: { keep: { url: secret } } }));
    expect(leaked.status).toBe(502);
    expect(await leaked.text()).not.toContain("secret-config-value");
    const writes = oc.seen.filter((item) => item.method === "PATCH" && item.path === "/config");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.body)).toEqual({ model: secret });

    oc.stop();
    svc.stop();
  });
});
