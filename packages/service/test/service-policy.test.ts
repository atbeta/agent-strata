import { describe, expect, test } from "bun:test";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";

describe("session and shared policy routes", () => {
  test("policy endpoints: get/put/test/delete + file persistence", async () => {
    const dir = `${import.meta.dir}/.tmp-${Bun.randomUUIDv7()}`;
    const svc = startService({ db: ":memory:", port: 0, policyFile: `${dir}/policy.json` });
    const base = `http://127.0.0.1:${svc.port}`;

    const empty = await fetch(`${base}/policy`).then((r) => r.json());
    expect(empty.policy).toBeNull();
    const noPolicy = await fetch(`${base}/policy/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "bash", input: { command: "rm -rf /" } }),
    }).then((r) => r.json());
    expect(noPolicy.decision).toBe("ask");

    const bad = await fetch(`${base}/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, rules: [{ id: "x", effect: "allow", tool: "*", when: { c: { matches: "[" } } }] }),
    });
    expect(bad.status).toBe(400);
    const policy = {
      version: 1,
      default: "ask",
      rules: [
        { id: "deny-rm", effect: "deny", tool: "bash", when: { command: { matches: "\\brm\\b" } } },
        { id: "allow-read", effect: "allow", tool: "read" },
      ],
    };
    expect((await fetch(`${base}/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(policy),
    })).status).toBe(200);

    const got = await fetch(`${base}/policy`).then((r) => r.json());
    expect(got.policy.rules.length).toBe(2);
    expect(got.file).toBe(`${dir}/policy.json`);
    const denied = await fetch(`${base}/policy/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "bash", input: { command: "rm -rf /tmp/x" } }),
    }).then((r) => r.json());
    expect(denied).toMatchObject({ decision: "deny", rule_id: "deny-rm" });
    const draft = await fetch(`${base}/policy/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "bash",
        input: { command: "rm -rf /tmp/x" },
        policy: { version: 1, rules: [{ id: "yolo", effect: "allow", tool: "*" }] },
      }),
    }).then((r) => r.json());
    expect(draft).toMatchObject({ decision: "allow", rule_id: "yolo" });

    const svc2 = startService({ db: ":memory:", port: 0, policyFile: `${dir}/policy.json` });
    const got2 = await fetch(`http://127.0.0.1:${svc2.port}/policy`).then((r) => r.json());
    expect(got2.policy.rules.length).toBe(2);
    svc2.stop();
    expect((await fetch(`${base}/policy`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/policy`).then((r) => r.json())).policy).toBeNull();
    svc.stop();
    const svc3 = startService({ db: ":memory:", port: 0, policyFile: `${dir}/policy.json` });
    expect((await fetch(`http://127.0.0.1:${svc3.port}/policy`).then((r) => r.json())).policy).toBeNull();
    svc3.stop();
  });

  test("one session stops asking, and only that one", async () => {
    const oc = fakeOpencode({
      "/permission/p-auto/reply": () => Response.json(true),
      "/permission/p-back/reply": () => Response.json(true),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const put = (u: string, b: unknown) =>
      fetch(u, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const asked = (id: string) => oc.seen.find((s) => s.path === `/permission/${id}/reply`);
    const pendingIds = async () =>
      (await fetch(`${base}/permissions`).then((r) => r.json())).pending.map((p: { request_id: string }) => p.request_id);
    const ask = (id: string, sessionID: string) => oc.push({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: { id, sessionID, permission: "bash", patterns: ["ls"], metadata: {}, always: [] },
      },
    });

    await put(`${base}/policy`, {
      version: 1,
      default: "ask",
      rules: [{ id: "allow-read", effect: "allow", tool: "read" }],
    });
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    expect((await fetch(`${base}/sessions/opencode%3Ases_auto/policy`).then((r) => r.json())).mode).toBe("inherit");
    await put(`${base}/sessions/opencode%3Ases_auto/policy`, { mode: "auto" });
    expect((await fetch(`${base}/sessions/opencode%3Ases_auto/policy`).then((r) => r.json())).mode).toBe("auto");
    const bad = await fetch(`${base}/sessions/opencode%3Ases_auto/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "yolo" }),
    });
    expect(bad.status).toBe(400);

    ask("p-auto", "ses_auto");
    ask("p-other", "ses_other");
    for (let i = 0; i < 30 && !(asked("p-auto") && (await pendingIds()).includes("p-other")); i++) await Bun.sleep(50);
    expect(asked("p-auto")).toBeDefined();
    expect(JSON.parse(asked("p-auto")!.body).reply).toBe("once");
    expect(await pendingIds()).toContain("p-other");
    await fetch(`${base}/sessions/opencode%3Ases_auto/policy`, { method: "DELETE" });
    expect((await fetch(`${base}/sessions/opencode%3Ases_auto/policy`).then((r) => r.json())).mode).toBe("inherit");
    ask("p-back", "ses_auto");
    for (let i = 0; i < 30 && !(await pendingIds()).includes("p-back"); i++) await Bun.sleep(50);
    expect(await pendingIds()).toContain("p-back");
    expect((await fetch(`${base}/sessions/opencode%3Aghost/policy`).then((r) => r.json())).known).toBe(false);
    oc.stop();
    svc.stop();
  });

  test("a session on auto asks nothing when there is no shared policy", async () => {
    const oc = fakeOpencode({ "/permission/p-solo/reply": () => Response.json(true) });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const asked = (id: string) => oc.seen.find((s) => s.path === `/permission/${id}/reply`);
    const pendingIds = async () =>
      (await fetch(`${base}/permissions`).then((r) => r.json())).pending.map((p: { request_id: string }) => p.request_id);
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    await fetch(`${base}/sessions/opencode%3Ases_solo/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    });
    oc.push({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: { id: "p-solo", sessionID: "ses_solo", permission: "bash", patterns: ["ls"], metadata: {}, always: [] },
      },
    });
    for (let i = 0; i < 30 && !asked("p-solo"); i++) await Bun.sleep(50);
    expect(asked("p-solo")).toBeDefined();
    expect(await pendingIds()).not.toContain("p-solo");
    oc.stop();
    svc.stop();
  });

  test("a session on auto is not stopped by the engine floor", async () => {
    const oc = fakeOpencode({ "/permission/p-heredoc/reply": () => Response.json(true) });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const asked = (id: string) => oc.seen.find((s) => s.path === `/permission/${id}/reply`);
    const pendingIds = async () =>
      (await fetch(`${base}/permissions`).then((r) => r.json())).pending.map((p: { request_id: string }) => p.request_id);
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    await fetch(`${base}/sessions/opencode%3Ases_floor/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    });
    oc.push({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: {
          id: "p-heredoc", sessionID: "ses_floor", permission: "bash",
          patterns: ["cat > /tmp/check.mjs <<'EOF'\nconsole.log(1)\nEOF"], metadata: {}, always: [],
        },
      },
    });
    for (let i = 0; i < 30 && !asked("p-heredoc"); i++) await Bun.sleep(50);
    expect(asked("p-heredoc")).toBeDefined();
    expect(JSON.parse(asked("p-heredoc")!.body).reply).toBe("once");
    expect(await pendingIds()).not.toContain("p-heredoc");
    oc.stop();
    svc.stop();
  });

  test("a session on auto still obeys a deny rule, and is not persisted", async () => {
    const oc = fakeOpencode({ "/permission/p-rm/reply": () => Response.json(true) });
    const dir = `${import.meta.dir}/.tmp-${Bun.randomUUIDv7()}`;
    const svc = startService({ db: ":memory:", port: 0, policyFile: `${dir}/policy.json` });
    const base = `http://127.0.0.1:${svc.port}`;
    await fetch(`${base}/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        default: "ask",
        rules: [{ id: "no-rm", effect: "deny", tool: "bash", when: { command: { matches: "^rm" } } }],
      }),
    });
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    await fetch(`${base}/sessions/opencode%3Ases_s/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    });
    oc.push({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: { id: "p-rm", sessionID: "ses_s", permission: "bash", patterns: ["rm -rf /"], metadata: {}, always: [] },
      },
    });
    let reply: (typeof oc.seen)[number] | undefined;
    for (let i = 0; i < 30 && !reply; i++) {
      await Bun.sleep(50);
      reply = oc.seen.find((s) => s.path === "/permission/p-rm/reply");
    }
    expect(JSON.parse(reply!.body).reply).toBe("reject");
    oc.stop();
    svc.stop();
    const svc2 = startService({ db: ":memory:", port: 0, policyFile: `${dir}/policy.json` });
    expect((await fetch(`http://127.0.0.1:${svc2.port}/sessions/opencode%3Ases_s/policy`).then((r) => r.json())).mode).toBe("inherit");
    svc2.stop();
  });
});
