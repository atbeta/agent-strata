import { afterEach, expect, test, vi } from "vitest";
import { listTerminals, terminalSocket } from "./api";

afterEach(() => vi.unstubAllGlobals());

test("terminal reads use the native plugin namespace and session scope", async () => {
  let requested = "";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    requested = String(input);
    return Response.json({ sessions: [], shells: [] });
  });
  await listTerminals("opencode:a b");
  const url = new URL(requested, "http://localhost");
  expect(url.pathname).toBe("/api/plugins/terminal/terminals");
  expect(url.searchParams.get("session")).toBe("opencode:a b");
});

test("terminal sockets keep the session query when the token helper builds the URL", async () => {
  const raw = await terminalSocket("opencode:a b", "pty 1");
  const url = new URL(raw);
  expect(url.protocol).toBe("ws:");
  expect(url.pathname).toBe("/api/plugins/terminal/terminals/pty%201/connect");
  expect(url.searchParams.get("session")).toBe("opencode:a b");
});
