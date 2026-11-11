import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService, type RunningService } from "../src/index";

describe("only the desktop shell reaches the service from a browser", () => {
  let svc: RunningService;
  let base = "";
  beforeAll(() => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
  });
  afterAll(() => svc.stop());
  test("a page on another site cannot make strata run a command", async () => {
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ backend: "acp", command: "strata-test-should-never-run" }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a page on another port of this machine is another site too", async () => {
    expect((await fetch(`${base}/sessions`, { headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
    expect((await fetch(`${base}/sessions`, { headers: { origin: "http://localhost:3000" } })).status).toBe(403);
    expect((await fetch(`${base}/sessions`, { headers: { origin: "http://127.0.0.1:3000" } })).status).toBe(403);
  });

  test("a route that throws still answers the shell in JSON it can read", async () => {
    const res = await fetch(`${base}/sessions/%E0%A4%A/view`, { headers: { origin: "http://tauri.localhost" } });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
  });

  test("a request another site made the browser send, or a rebound Host, goes nowhere", async () => {
    expect((await fetch(`${base}/sync`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${base}/sessions`, { headers: { origin: "null" } })).status).toBe(403);
    expect((await fetch(`${base}/stream`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/health`, { headers: { host: "evil.example" } })).status).toBe(403);
  });

  test("a preflight is granted to the shell and nobody else", async () => {
    const ask = (origin: string) =>
      fetch(`${base}/connect`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
    const shell = await ask("http://tauri.localhost");
    expect(shell.status).toBe(204);
    expect(shell.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    expect(shell.headers.get("access-control-allow-methods")).toContain("POST");
    expect(shell.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(shell.headers.get("access-control-allow-headers")).toContain("content-type");
    expect((await ask("https://evil.example")).status).toBe(403);
  });

  test("the shell reads every route cross-origin, the dev proxy reads it same-origin", async () => {
    for (const origin of ["http://tauri.localhost", "tauri://localhost", "http://localhost:5178"]) {
      const res = await fetch(`${base}/health`, { headers: { origin, "sec-fetch-site": "cross-site" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("vary")).toContain("origin");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const proxied = await fetch(`${base}/sync`, {
      method: "POST",
      headers: { host: "localhost:5178", origin: "http://localhost:5178", "sec-fetch-site": "same-origin" },
    });
    expect(proxied.status).toBe(200);
    const stream = await fetch(`${base}/stream`, { headers: { origin: "http://tauri.localhost" } });
    expect(stream.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    await stream.body?.cancel();
  });
});

describe("the service exposes the opencode launch mode and status", () => {
  const withDesktopDir = (run: (desktopDir: string, base: string) => Promise<void>) => {
    const desktopDir = mkdtempSync(join(tmpdir(), "agent-strata-desktop-"));
    const svc = startService({ db: ":memory:", port: 0, desktopDir });
    return run(desktopDir, `http://127.0.0.1:${svc.port}`).finally(() => {
      svc.stop();
      rmSync(desktopDir, { recursive: true, force: true });
    });
  };

  test("GET /desktop/opencode is unmanaged embed when no files exist", async () => {
    await withDesktopDir(async (_desktopDir, base) => {
      const res = await fetch(`${base}/desktop/opencode`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mode: "embed", state: "unmanaged" });
    });
  });

  test("GET /desktop/opencode returns the status file and omits a password", async () => {
    await withDesktopDir(async (desktopDir, base) => {
      writeFileSync(
        join(desktopDir, "opencode-status.json"),
        JSON.stringify({ mode: "embed", state: "missing", password: "secret" }),
      );
      const got = (await fetch(`${base}/desktop/opencode`).then((r) => r.json())) as Record<string, unknown>;
      expect(got).toEqual({ mode: "embed", state: "missing" });
      expect(got).not.toHaveProperty("password");
    });
  });

  test("GET /desktop/opencode prefers the saved mode over the running status", async () => {
    await withDesktopDir(async (desktopDir, base) => {
      writeFileSync(join(desktopDir, "desktop.json"), JSON.stringify({ opencode: "external" }));
      writeFileSync(
        join(desktopDir, "opencode-status.json"),
        JSON.stringify({ mode: "embed", state: "running", url: "http://127.0.0.1:9" }),
      );
      const got = await fetch(`${base}/desktop/opencode`).then((r) => r.json());
      expect(got).toEqual({ mode: "external", state: "running", url: "http://127.0.0.1:9" });
    });
  });

  test("GET /desktop/opencode includes the binary the shell inspected", async () => {
    await withDesktopDir(async (desktopDir, base) => {
      writeFileSync(
        join(desktopDir, "opencode-runtime.json"),
        JSON.stringify({ source: "setting", bin: "/opt/opencode", version: "1.18.30", checked_at: 1_700_000_000 }),
      );
      const got = await fetch(`${base}/desktop/opencode`).then((r) => r.json());
      expect(got).toEqual({
        mode: "embed",
        state: "unmanaged",
        runtime: { source: "setting", bin: "/opt/opencode", version: "1.18.30", checked_at: 1_700_000_000 },
      });
    });
  });

  test("PUT /desktop/opencode saves the mode for the next launch", async () => {
    await withDesktopDir(async (desktopDir, base) => {
      writeFileSync(join(desktopDir, "desktop.json"), JSON.stringify({ opencode: "embed", opencodeBin: "/opt/opencode" }));
      const res = await fetch(`${base}/desktop/opencode`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "external" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mode: "external", applied: "next-launch" });
      expect(JSON.parse(readFileSync(join(desktopDir, "desktop.json"), "utf8"))).toEqual({
        opencode: "external",
        opencodeBin: "/opt/opencode",
      });

      const bad = await fetch(`${base}/desktop/opencode`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(bad.status).toBe(400);
    });
  });
});
