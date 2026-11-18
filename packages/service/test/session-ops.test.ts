import { describe, expect, test } from "bun:test";
import { openStore } from "@agent-strata/store";
import { ConnectionRegistry } from "../src/connection-registry";
import type { BackendDriver, PromptOpts, PromptPart } from "../src/driver";
import { GoalRunner } from "../src/goal-runner";
import { SessionClaims } from "../src/identity";
import { makeSessionControl } from "../src/session-ops";

const CAPS = { prompt: true, abort: false, models: false, agents: false, import: false, manage: false };

function fakeDriver(overrides: Partial<BackendDriver> = {}): BackendDriver {
  return {
    id: "conn1",
    backend: "opencode",
    agent: "opencode",
    baseUrl: "http://127.0.0.1:1",
    capabilities: { ...CAPS },
    stop: () => {},
    createSession: async () => ({ casfId: "opencode:ses_new", nativeId: "ses_new" }),
    prompt: async () => {},
    abort: async () => {},
    listModels: async () => [],
    listAgents: async () => [],
    listWorkspaces: async () => [],
    indexSessions: async () => [],
    sync: async () => 0,
    rebuild: async () => 0,
    importSession: async () => {},
    rename: async () => {},
    archive: async () => {},
    deleteSession: async () => {},
    nativeId: (casfId) => (casfId === "opencode:ses_new" ? "ses_new" : undefined),
    ...overrides,
  };
}

function harness(driver?: BackendDriver) {
  const store = openStore(":memory:");
  const connections = new ConnectionRegistry();
  if (driver) connections.add(driver, () => undefined, undefined);
  const claims = new SessionClaims();
  const createdDirs = new Map<string, string>();
  const touched = new Set<string>();
  const control = makeSessionControl({
    connections,
    claims,
    createdDirs,
    touched,
    goalRunner: new GoalRunner({
      store,
      sessionView: () => {
        throw new Error("no events");
      },
      driverFor: (sessionId) => connections.driverFor(sessionId),
      directoryOf: () => undefined,
      hasPending: () => false,
    }),
    directoryOf: () => "/repo",
    driverFor: (sessionId) => connections.driverFor(sessionId),
  });
  return { store, connections, claims, createdDirs, touched, control };
}

describe("sessionControl", () => {
  test("create adopts the session and prompt marks it touched", async () => {
    const prompts: { native: string; parts: PromptPart[]; opts?: PromptOpts }[] = [];
    const driver = fakeDriver({
      prompt: async (native, parts, opts) => {
        prompts.push({ native, parts, opts });
      },
    });
    const h = harness(driver);

    expect(h.control.connections()).toEqual([{ id: "conn1", agent: "opencode", canPrompt: true }]);
    expect(h.control.connectionOf("opencode:ses_new")).toBeUndefined();

    const { sessionId } = await h.control.create({ connectionId: "conn1", title: "t", directory: "/repo" });
    expect(sessionId).toBe("opencode:ses_new");
    // owned by the connection that created it, claimed under the backend identity
    expect(h.connections.owns(sessionId)).toBe(true);
    expect(h.connections.connectionOf(sessionId)).toBe("conn1");
    expect(h.control.connectionOf(sessionId)).toBe("conn1");
    expect(h.claims.shadowed({ backend: "opencode", native_id: "ses_new" }, "opencode:other")).toBe(true);
    expect(h.createdDirs.get(sessionId)).toBe("/repo");

    await h.control.prompt(sessionId, "hello");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      native: "ses_new",
      parts: [{ type: "text", text: "hello" }],
      opts: { directory: "/repo" },
    });
    // the mark the if_empty delete reads: the session counts as used until its turn lands
    expect(h.touched.has(sessionId)).toBe(true);
  });

  test("a refused prompt takes the touched mark back", async () => {
    const driver = fakeDriver({
      prompt: async () => {
        throw new Error("backend said no");
      },
    });
    const h = harness(driver);
    const { sessionId } = await h.control.create({ connectionId: "conn1" });
    await expect(h.control.prompt(sessionId, "hi")).rejects.toThrow("backend said no");
    expect(h.touched.has(sessionId)).toBe(false);
  });

  test("create and prompt refuse what they cannot do", async () => {
    const h = harness(fakeDriver());
    await expect(h.control.create({ connectionId: "nope" })).rejects.toThrow("no such connection");
    const mute = harness(
      fakeDriver({
        capabilities: { ...CAPS, prompt: false },
      }),
    );
    await expect(mute.control.create({ connectionId: "conn1" })).rejects.toThrow("cannot create sessions");
    // a session no backend claims
    await expect(h.control.prompt("opencode:ghost", "hi")).rejects.toThrow("not owned by a connected backend");
    // and with nothing connected at all
    const empty = harness();
    await expect(empty.control.prompt("opencode:ghost", "hi")).rejects.toThrow("no backend connected");
  });
});
