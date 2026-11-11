import { describe, expect, test } from "bun:test";
import { loadPolicy } from "@agent-strata/policy";
import type { Event } from "@opencode-ai/sdk/v2";
import { openStore } from "@agent-strata/store";
import { waitForIdle, expectAllowPath } from "./helpers";

// gated live test
const E2E = process.env.AGENT_STRATA_OPENCODE_E2E === "1";
const HAS_KEY = !!process.env.DEEPSEEK_API_KEY;
const port = Number(process.env.OPENCODE_PORT ?? 4096);
const dir = process.env.OPENCODE_DIR ?? "/tmp";

async function prompt(
  client: { session: { prompt: (p: unknown) => Promise<unknown> } },
  sessionID: string,
  text: string,
) {
  await client.session.prompt({
    sessionID,
    directory: dir,
    parts: [{ type: "text", text }],
  });
}

const casf = (store: ReturnType<typeof openStore>, sessionID: string) =>
  store.read({ session_id: `opencode:${sessionID}` });

describe.skipIf(!E2E)("opencode live e2e", () => {
  test("session.created -> session.started end-to-end", async () => {
    const { connectOpencode } = await import("../src/index");
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
    const store = openStore(":memory:");
    const client = createOpencodeClient({ baseUrl: `http://localhost:${port}`, directory: dir });
    let sessionID = "";
    let sessionCreated!: (evt: Event) => void;
    const created = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no session.created within 10s")), 10_000);
      sessionCreated = (evt) => {
        const props = evt.properties as { sessionID?: string };
        if (evt.type === "session.created" && props.sessionID === sessionID) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    const conn = await connectOpencode({
      baseUrl: `http://localhost:${port}`,
      directory: dir,
      sink: store,
      onEvent: (evt) => sessionCreated(evt),
    });
    const sess = await client.session.create({ directory: dir });
    sessionID = sess.data!.id;
    await created;
    conn.stop();
    const evs = store.read({ session_id: `opencode:${sessionID}` });
    expect(evs[0]?.type).toBe("session.started");
    store.close();
  });
});

describe.skipIf(!(E2E && HAS_KEY))("opencode live e2e (deepseek)", () => {
  test("allow path: prompt -> bash echo -> permission allow -> tool.result -> turn.assistant", async () => {
    const { connectOpencode } = await import("../src/index");
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
    const store = openStore(":memory:");
    const policy = loadPolicy({
      version: 1,
      rules: [{ id: "echo-ok", effect: "allow", tool: "bash", when: { command: { matches: "^echo\\b" } } }],
    });
    const client = createOpencodeClient({ baseUrl: `http://localhost:${port}`, directory: dir });
    const listeners = new Set<(evt: Event) => void>();
    const conn = await connectOpencode({
      baseUrl: `http://localhost:${port}`,
      directory: dir,
      sink: store,
      policy,
      onEvent: (evt) => {
        for (const cb of listeners) cb(evt);
      },
    });
    const sess = await client.session.create({ directory: dir });
    const sessionID = sess.data!.id;
    const text = "Use the bash tool to run exactly: echo agent-strata-e2e — then reply with its output.";
    const idle = waitForIdle(sessionID, (cb) => listeners.add(cb));
    await prompt(client as never, sessionID, text);
    await idle;
    if (!casf(store, sessionID).some((e) => e.type === "permission.requested")) {
      // model may not have called the tool: retry once
      const idle2 = waitForIdle(sessionID, (cb) => listeners.add(cb));
      await prompt(client as never, sessionID, text);
      await idle2;
    }
    conn.stop();

    const evs = casf(store, sessionID);
    expectAllowPath(evs);
    const res = evs.find((e) => e.type === "permission.resolved")!;
    expect((res.data as { by: string }).by).toBe("policy");
    store.close();
  }, 180_000);

  test("deny path: rm denied by policy, session still reaches idle", async () => {
    const { connectOpencode } = await import("../src/index");
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
    const store = openStore(":memory:");
    const policy = loadPolicy({
      version: 1,
      rules: [{ id: "no-rm", effect: "deny", tool: "bash", when: { command: { matches: "^rm\\b" } } }],
    });
    const client = createOpencodeClient({ baseUrl: `http://localhost:${port}`, directory: dir });
    const listeners = new Set<(evt: Event) => void>();
    const conn = await connectOpencode({
      baseUrl: `http://localhost:${port}`,
      directory: dir,
      sink: store,
      policy,
      onEvent: (evt) => {
        for (const cb of listeners) cb(evt);
      },
    });
    const sess = await client.session.create({ directory: dir });
    const sessionID = sess.data!.id;
    const text = "Use the bash tool to run exactly: rm -f /tmp/strata-e2e/nonexistent.txt — then tell me the result.";
    const idle = waitForIdle(sessionID, (cb) => listeners.add(cb));
    await prompt(client as never, sessionID, text);
    await idle;
    conn.stop();

    const evs = casf(store, sessionID);
    expect(evs.some((e) => e.type === "permission.requested")).toBe(true);
    const res = evs.find((e) => e.type === "permission.resolved")!;
    expect((res.data as { decision: string }).decision).toBe("deny");
    expect((res.data as { by: string }).by).toBe("policy");
    const results = evs.filter((e) => e.type === "tool.result");
    const okResult = results.find(
      (e) => (e.data as { status: string }).status === "ok",
    );
    expect(okResult).toBeUndefined();
    store.close();
  }, 180_000);
});
