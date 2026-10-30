import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  connectMcp,
  disconnectMcp,
  exportFileName,
  fmtDuration,
  fmtDurationDelta,
  fmtUsd,
  fmtUsdFlat,
  opencodePath,
  readMcp,
  readSkills,
  runCommand,
  stopDevProcess,
} from "./api";

describe("a cost in dollars", () => {
  test("drops the digits past the cent once it is worth dollars", () => {
    expect(fmtUsd(5.9363)).toBe("$5.94");
    expect(fmtUsd(3.6345964)).toBe("$3.63");
  });

  test("keeps four places below a dollar, where they are the only signal", () => {
    expect(fmtUsd(0.0013)).toBe("$0.0013");
    expect(fmtUsd(0.3969)).toBe("$0.3969");
  });

  test("reads as nothing rather than as a row of zeros", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(Number.NaN)).toBe("$0.00");
  });

  test("a column of costs keeps every decimal point on the same line", () => {
    // What `fmtUsd` widens for a lone row, a column has to give up: five
    // places side by side only line up if they are all the same five.
    expect(fmtUsdFlat(5.9363)).toBe("$5.94");
    expect(fmtUsdFlat(0.4621)).toBe("$0.46");
    expect(fmtUsdFlat(0.0566)).toBe("$0.06");
    expect(fmtUsdFlat(0)).toBe("$0.00");
    expect(fmtUsdFlat(Number.NaN)).toBe("$0.00");
    expect(fmtUsdFlat(0.0013)).toBe("$0.00");
  });
});

describe("a duration", () => {
  test("stays in milliseconds where the sub-second calls are", () => {
    expect(fmtDuration(0)).toBe("0 ms");
    expect(fmtDuration(4)).toBe("4 ms");
    expect(fmtDuration(812)).toBe("812 ms");
    // A tool call is the reason a timing view exists, and `0.81 s` reads as noise.
    expect(fmtDuration(999)).toBe("999 ms");
  });

  test("keeps a decimal so two nearby calls stay distinguishable", () => {
    expect(fmtDuration(1_000)).toBe("1.00 s");
    expect(fmtDuration(1_580)).toBe("1.58 s");
    expect(fmtDuration(9_994)).toBe("9.99 s");
    // Past ten seconds the hundredths are width spent on precision nobody reads.
    expect(fmtDuration(12_340)).toBe("12.3 s");
    expect(fmtDuration(59_400)).toBe("59.4 s");
  });

  test("past a minute it reads as a clock, with the seconds padded", () => {
    expect(fmtDuration(60_000)).toBe("1 m 00 s");
    expect(fmtDuration(158_000)).toBe("2 m 38 s");
    expect(fmtDuration(604_000)).toBe("10 m 04 s");
    expect(fmtDuration(3_600_000)).toBe("60 m 00 s");
  });

  test("a missing or nonsense measurement shows a dash rather than NaN", () => {
    expect(fmtDuration(-1)).toBe("—");
    expect(fmtDuration(Number.NaN)).toBe("—");
    expect(fmtDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });

  test("a delta keeps its sign and never turns a missing measurement into zero", () => {
    expect(fmtDurationDelta(1_580)).toBe("+1.58 s");
    expect(fmtDurationDelta(-1_580)).toBe("-1.58 s");
    expect(fmtDurationDelta(0)).toBe("0 ms");
    expect(fmtDurationDelta(null)).toBe("—");
    expect(fmtDurationDelta(Number.NaN)).toBe("—");
  });
});

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
    }) as unknown as typeof fetch;
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

describe("stopping a dev command", () => {
  const realFetch = globalThis.fetch;
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POSTs to the command's stop endpoint", async () => {
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return Response.json({ stopped: true, clean: true, residual: [] });
    }) as unknown as typeof fetch;
    const result = await stopDevProcess("dev_1");
    expect(urls).toEqual(["/api/dev/dev_1/stop"]);
    expect(result).toEqual({ stopped: true, clean: true, residual: [] });
  });

  test("says which processes survived a stop that did not take", async () => {
    // The service already knows what is left. Swallowing that would show the
    // reader a stop that did not happen.
    globalThis.fetch = (async () =>
      Response.json({ stopped: true, clean: false, residual: [4321], port: 5173, port_free: false })) as unknown as typeof fetch;
    await expect(stopDevProcess("dev_1")).rejects.toThrow("still running: 4321");
    await expect(stopDevProcess("dev_1")).rejects.toThrow("port 5173 is still held");
  });

  test("says a stop left something behind even when it cannot name it", async () => {
    globalThis.fetch = (async () => Response.json({ stopped: true, clean: false, residual: [] })) as unknown as typeof fetch;
    await expect(stopDevProcess("dev_1")).rejects.toThrow("the command is still running");
  });

  test("surfaces a service error", async () => {
    globalThis.fetch = (async () => Response.json({ error: "nope" }, { status: 400 })) as unknown as typeof fetch;
    await expect(stopDevProcess("dev_1")).rejects.toThrow("nope");
  });
});

describe("reading MCP servers and skills", () => {
  const realFetch = globalThis.fetch;
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("reads MCP status through the opencode extension", async () => {
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return Response.json({ srv: { status: "connected" } });
    }) as unknown as typeof fetch;
    const mcp = await readMcp("opencode:ses_1");
    expect(urls).toEqual(["/api/sessions/opencode%3Ases_1/opencode/mcp"]);
    expect(mcp).toEqual({ srv: { status: "connected" } });
  });

  test("reads skills through the opencode extension", async () => {
    const skills = [{ name: "review", location: "project", content: "# review" }];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return Response.json(skills);
    }) as unknown as typeof fetch;
    expect(await readSkills("opencode:ses_1")).toEqual(skills);
    expect(urls).toEqual(["/api/sessions/opencode%3Ases_1/opencode/skill"]);
  });

  test("treats a missing extension as undefined", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await readMcp("acp:1")).toBeUndefined();
    expect(await readSkills("acp:1")).toBeUndefined();
  });
});

describe("connecting and disconnecting an MCP server", () => {
  const realFetch = globalThis.fetch;
  let sent: { url: string; method?: string; body?: string }[] = [];
  beforeEach(() => {
    sent = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method, body: init?.body as string | undefined });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POSTs the encoded name with no body", async () => {
    await connectMcp("opencode:ses_1", "my server");
    await disconnectMcp("opencode:ses_1", "my server");
    expect(sent).toEqual([
      { url: "/api/sessions/opencode%3Ases_1/mcp/my%20server/connect", method: "POST", body: undefined },
      { url: "/api/sessions/opencode%3Ases_1/mcp/my%20server/disconnect", method: "POST", body: undefined },
    ]);
  });

  test("surfaces a service error", async () => {
    globalThis.fetch = (async () => Response.json({ error: "nope" }, { status: 400 })) as unknown as typeof fetch;
    await expect(connectMcp("s", "srv")).rejects.toThrow("nope");
    await expect(disconnectMcp("s", "srv")).rejects.toThrow("nope");
  });
});
