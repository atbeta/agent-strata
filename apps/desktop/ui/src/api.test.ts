import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { exportFileName, opencodePath, runCommand } from "./api";

describe("an exported session", () => {
  test("is saved under a name any file system takes", () => {
    expect(exportFileName("opencode:ses_1")).toBe("strata-opencode_ses_1.ndjson");
    expect(exportFileName("acp:claude-code:a/b")).toBe("strata-acp_claude-code_a_b.ndjson");
  });
});

describe("a read of a session's opencode backend", () => {
  test("names the session and the path", () => {
    expect(opencodePath("opencode:ses_1", "/vcs")).toBe("/sessions/opencode%3Ases_1/opencode/vcs");
  });

  test("carries its query", () => {
    expect(opencodePath("opencode:ses_1", "/find/file", { query: "a b", limit: 5 })).toBe(
      "/sessions/opencode%3Ases_1/opencode/find/file?query=a+b&limit=5",
    );
  });
});

describe("running a backend command", () => {
  const realFetch = globalThis.fetch;
  let sent: { url: string; body: unknown }[] = [];
  beforeEach(() => {
    sent = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("leaves parts out when there are none", async () => {
    await runCommand("opencode:ses_1", { name: "init", args: "", parts: [] }, {});
    expect(sent).toEqual([{ url: "/api/sessions/opencode%3Ases_1/command", body: { command: "init", arguments: "" } }]);
  });

  test("sends the command, its arguments, its files and the choice", async () => {
    const parts = [{ type: "file_ref" as const, path: "a.ts" }];
    await runCommand("opencode:ses_1", { name: "review", args: "be brief", parts }, { agent: "plan" });
    expect(sent[0]!.body).toEqual({ command: "review", arguments: "be brief", parts, agent: "plan" });
  });
});
