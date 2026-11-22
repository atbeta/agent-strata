import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest, StrataPlugin } from "@agent-strata/plugin-sdk";
import { startService } from "../src/index";
import type { RegisteredPlugin } from "../src/plugins/host";

const manifest: PluginManifest = {
  id: "socket",
  name: "Socket fixture",
  version: "1.0.0",
  entry: { kind: "builtin" },
  provides: [],
  permissions: {},
  tools: [],
  resources: [],
};

function fixture(notifyClosed: () => void): RegisteredPlugin[] {
  return [{
    manifest,
    create: (): StrataPlugin => ({
      async initialize() {},
      listTools() { return []; },
      async callTool() { return { output: "" }; },
      async upgrade(_req, subpath) {
        if (subpath !== "/echo") return undefined;
        return {
          handlers: {
            open(ws) { ws.send("ready"); },
            message(ws, message) {
              ws.send(`echo:${typeof message === "string" ? message : new TextDecoder().decode(message)}`);
            },
            close() { notifyClosed(); },
          },
        };
      },
      async shutdown() {},
    }),
  }];
}

describe("plugin WebSockets", () => {
  let svc: ReturnType<typeof startService>;
  let desktop = "";
  let closed: () => void = () => {};
  const didClose = new Promise<void>((resolve) => {
    closed = resolve;
  });

  beforeAll(async () => {
    desktop = mkdtempSync(join(tmpdir(), "strata-plugin-ws-"));
    svc = startService({ db: ":memory:", port: 0, desktopDir: desktop, apiToken: "secret", plugins: fixture(closed) });
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`http://127.0.0.1:${svc.port}/plugins`, { headers: { authorization: "Bearer secret" } });
      const body = (await res.json()) as { plugins: { id: string; state: string }[] };
      if (body.plugins.some((plugin) => plugin.id === "socket" && plugin.state === "running")) return;
      await Bun.sleep(20);
    }
    throw new Error("socket plugin did not start");
  });

  afterAll(() => {
    svc.stop();
    rmSync(desktop, { recursive: true, force: true });
  });

  test("query-token auth and the generic open/message/close dispatch work", async () => {
    const path = `/plugins/socket/echo`;
    const bad = new WebSocket(`ws://127.0.0.1:${svc.port}${path}`);
    await new Promise<void>((resolve, reject) => {
      bad.onopen = () => reject(new Error("unauthenticated socket opened"));
      bad.onerror = () => resolve();
    });

    const ws = new WebSocket(`ws://127.0.0.1:${svc.port}${path}?token=secret`);
    const ready = new Promise<string>((resolve, reject) => {
      ws.onmessage = (event) => resolve(String(event.data));
      ws.onerror = () => reject(new Error("socket failed"));
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket failed"));
    });
    expect(await ready).toBe("ready");
    const echoed = new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data));
    });
    ws.send("hello");
    expect(await echoed).toBe("echo:hello");
    ws.close();
    await didClose;
  }, 10_000);
});
