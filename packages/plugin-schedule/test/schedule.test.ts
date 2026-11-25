import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, ToolCallRequest } from "@agent-strata/plugin-sdk";
import type { SessionView } from "@agent-strata/projector";
import { ScheduleEngine, type EngineDeps } from "../src/engine";
import { firstAt, nextClockAt, parseClock, parseWeekly, type Schedule } from "../src/model";
import { SchedulesFile } from "../src/schedules-file";
import { createSchedulePlugin, manifest } from "../src/index";

const CALLER = "opencode:caller";
const OTHER = "opencode:other";
const WS = "/repo";

let NOW = Date.parse("2026-11-19T10:00:00");

const ctxOf = (dir: string): PluginContext =>
  ({
    pluginId: "schedule",
    resolveSession: (id: string) => (id.includes(":") ? id : `opencode:${id}`),
    dataDir: dir,
    config: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    emit: () => {},
  }) as unknown as PluginContext;

function view(busy = false): SessionView {
  return {
    session_id: CALLER,
    backend: "opencode",
    workspace: WS,
    title: "standup",
    status: "active",
    busy,
    turns: [],
    orphans: [],
    pending_permissions: [],
    pending_questions: [],
    files_changed: [],
    totals: {},
  } as unknown as SessionView;
}

interface ControlCalls {
  created: { connectionId: string; title?: string; directory?: string }[];
  prompted: { sessionId: string; text: string }[];
}

function control(calls: ControlCalls = { created: [], prompted: [] }, busyIds: string[] = ["conn1"]) {
  return {
    calls,
    connections: () => busyIds.map((id) => ({ id, agent: "opencode", canPrompt: true })),
    connectionOf: (sessionId: string) => (sessionId === CALLER ? "conn1" : undefined),
    create: async (opts: { connectionId: string; title?: string; directory?: string }) => {
      calls.created.push(opts);
      return { sessionId: "opencode:sched_new" };
    },
    prompt: async (sessionId: string, text: string) => {
      calls.prompted.push({ sessionId, text });
    },
  };
}

function engineDeps(dir: string, over: Partial<EngineDeps> = {}): EngineDeps {
  const calls: ControlCalls = { created: [], prompted: [] };
  return {
    file: new SchedulesFile(join(dir, "schedules.json")),
    control: control(calls),
    view: () => view(false),
    workspaceOf: () => WS,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    emit: () => {},
    now: () => NOW,
    catchupWindowMs: 30 * 60 * 1000,
    ...over,
  } as EngineDeps;
}

function seed(dir: string, over: Partial<Schedule>): Schedule {
  const s: Schedule = {
    id: `sch_${Math.random().toString(16).slice(2, 8)}`,
    name: "nightly",
    prompt: "do the thing",
    created_by: CALLER,
    created_at: new Date(NOW).toISOString(),
    enabled: true,
    when: { kind: "at", at: NOW - 1000 },
    target: { kind: "session", session_id: CALLER },
    next_at: new Date(NOW - 1000).toISOString(),
    ...over,
  };
  new SchedulesFile(join(dir, "schedules.json")).mutate((all) => {
    const i = all.findIndex((x) => x.id === s.id);
    if (i >= 0) all[i] = s;
    else all.push(s);
  });
  return s;
}

describe("model", () => {
  test("parseClock and parseWeekly accept the spelled formats only", () => {
    expect(parseClock("9:30")).toEqual({ hour: 9, minute: 30 });
    expect(parseWeekly("fri 18:00")).toEqual({ weekday: 5, hour: 18, minute: 0 });
    expect(() => parseClock("25:00")).toThrow();
    expect(() => parseWeekly("someday 10:00")).toThrow();
  });

  test("daily/weekly pick the next local occurrence strictly after now", () => {
    // NOW = 2026-11-19T10:00 local? Date used local time — pin via constructor args.
    const after = new Date(2026, 10, 19, 10, 0, 0); // a Thursday in local time
    const daily = nextClockAt({ kind: "daily", hour: 9, minute: 0 }, after);
    expect(new Date(daily!).getHours()).toBe(9);
    expect(daily! > after.getTime()).toBe(true);
    const weekly = nextClockAt({ kind: "weekly", weekday: 4, hour: 10, minute: 0 }, after);
    const d = new Date(weekly!);
    expect(d.getDay()).toBe(4); // Thursday
    expect(weekly! > after.getTime()).toBe(true);
  });

  test("firstAt arms a one-shot, an interval from now, a clock at its next beat", () => {
    expect(firstAt({ kind: "at", at: NOW + 5000 }, NOW)).toBe(NOW + 5000);
    expect(firstAt({ kind: "every", everyMs: 60000 }, NOW)).toBe(NOW + 60000);
  });
});

describe("engine", () => {
  test("a due one-shot prompts its session with the scheduled marker and retires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const calls: ControlCalls = { created: [], prompted: [] };
    const deps = engineDeps(dir, { control: control(calls) });
    const s = seed(dir, {});
    const engine = new ScheduleEngine(deps);
    await engine.runDue(false);
    await engine.stop();

    expect(calls.prompted).toHaveLength(1);
    expect(calls.prompted[0]!.sessionId).toBe(CALLER);
    expect(calls.prompted[0]!.text).toBe("[scheduled: nightly]\n\ndo the thing");
    const saved = deps.file.load().find((x) => x.id === s.id)!;
    expect(saved.enabled).toBe(false);
    expect(saved.next_at).toBeNull();
    expect(saved.last_result).toBe("ok");
  });

  test("a busy session is skipped, not queued, and the interval moves on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const calls: ControlCalls = { created: [], prompted: [] };
    const deps = engineDeps(dir, {
      control: control(calls),
      view: () => view(true),
    });
    const s = seed(dir, { when: { kind: "every", everyMs: 3600000 } });
    const engine = new ScheduleEngine(deps);
    await engine.runDue(false);
    await engine.runDue(false); // a second due pass must not send anything either
    await engine.stop();

    expect(calls.prompted).toHaveLength(0);
    const saved = deps.file.load().find((x) => x.id === s.id)!;
    expect(saved.last_result).toBe("skipped-busy");
    expect(Date.parse(saved.next_at!)).toBeGreaterThan(NOW);
  });

  test("a session parked on a person is skipped as waiting, not busy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const calls: ControlCalls = { created: [], prompted: [] };
    const deps = engineDeps(dir, {
      control: control(calls),
      view: () => ({
        ...view(true),
        pending_questions: [{ request_id: "q1" }],
      } as unknown as SessionView),
    });
    const s = seed(dir, { when: { kind: "every", everyMs: 3600000 } });
    const engine = new ScheduleEngine(deps);
    await engine.runDue(false);
    await engine.stop();

    expect(calls.prompted).toHaveLength(0);
    const saved = deps.file.load().find((x) => x.id === s.id)!;
    expect(saved.last_result).toBe("skipped-waiting");
    expect(saved.last_note).toContain("waiting on a person");
  });

  test("a fire does not prompt a target outside the creator's workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const calls: ControlCalls = { created: [], prompted: [] };
    const deps = engineDeps(dir, {
      control: control(calls),
      // the caller sits in /repo; the target lives in another repository
      view: (id: string) => ({
        ...view(false),
        session_id: id,
        workspace: id === CALLER ? WS : "/other-repo",
      }),
      workspaceOf: (id: string) => (id === CALLER ? WS : undefined),
    });
    const s = seed(dir, { target: { kind: "session", session_id: OTHER } });
    const engine = new ScheduleEngine(deps);
    await engine.runDue(false);
    await engine.stop();

    expect(calls.prompted).toHaveLength(0);
    const saved = deps.file.load().find((x) => x.id === s.id)!;
    expect(saved.last_result).toBe("failed");
    expect(saved.enabled).toBe(false);
  });

  test("startup catch-up: inside the window it fires once late; past it, missed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const calls: ControlCalls = { created: [], prompted: [] };
    const deps = engineDeps(dir, { control: control(calls) });
    const recent = seed(dir, { next_at: new Date(NOW - 10 * 60 * 1000).toISOString() });
    const stale = seed(dir, {
      id: "sch_stale",
      name: "stale",
      when: { kind: "every", everyMs: 3600000 },
      next_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    });
    const engine = new ScheduleEngine(deps);
    await engine.start();
    await engine.stop();

    expect(calls.prompted).toHaveLength(1);
    const all = deps.file.load();
    expect(all.find((x) => x.id === recent.id)!.last_result).toBe("late");
    const staleRow = all.find((x) => x.id === stale.id)!;
    expect(staleRow.last_result).toBe("missed");
    expect(Date.parse(staleRow.next_at!)).toBeGreaterThan(NOW); // advanced, not replayed
  });

  test("a new_session target creates then prompts on the caller's connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const calls: ControlCalls = { created: [], prompted: [] };
    const deps = engineDeps(dir, { control: control(calls) });
    seed(dir, { target: { kind: "new_session" } });
    const engine = new ScheduleEngine(deps);
    await engine.runDue(false);
    await engine.stop();

    expect(calls.created).toEqual([{ connectionId: "conn1", title: "schedule: nightly", directory: WS }]);
    expect(calls.prompted[0]!.sessionId).toBe("opencode:sched_new");
    expect(calls.prompted[0]!.text).toContain("[scheduled: nightly]");
  });

  test("a backend failure records failed, never crashes the loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const broken = control({ created: [], prompted: [] });
    broken.prompt = async () => {
      throw new Error("backend offline");
    };
    const deps = engineDeps(dir, { control: broken });
    const s = seed(dir, {});
    const engine = new ScheduleEngine(deps);
    await engine.runDue(false);
    await engine.stop();

    const saved = deps.file.load().find((x) => x.id === s.id)!;
    expect(saved.last_result).toBe("failed");
    expect(saved.last_note).toContain("backend offline");
  });

  test("an unreadable target session disables the schedule instead of looping failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const calls: ControlCalls = { created: [], prompted: [] };
    const deps = engineDeps(dir, {
      control: control(calls),
      view: () => {
        throw new Error("gone");
      },
    });
    const s = seed(dir, { when: { kind: "every", everyMs: 60000 } });
    const engine = new ScheduleEngine(deps);
    await engine.runDue(false);
    await engine.runDue(false);
    await engine.stop();

    expect(calls.prompted).toHaveLength(0);
    const saved = deps.file.load().find((x) => x.id === s.id)!;
    expect(saved.enabled).toBe(false);
    expect(saved.last_result).toBe("failed");
  });
});

describe("tools", () => {
  async function plugin(dir = mkdtempSync(join(tmpdir(), "sched-"))) {
    const calls: ControlCalls = { created: [], prompted: [] };
    const p = createSchedulePlugin({
      control: control(calls),
      view: () => view(false),
      workspaceOf: (id) => (id === CALLER || id === OTHER ? WS : undefined),
      listSessions: () => [{ session_id: CALLER, title: "standup", workspace: WS }],
    });
    await p.initialize(ctxOf(dir));
    return { p, calls, dir };
  }
  const req = (tool: string, input: Record<string, unknown> = {}, sessionId = CALLER): ToolCallRequest => ({
    tool,
    sessionId,
    input,
    signal: new AbortController().signal,
  });

  test("create validates name, prompt, and exactly one timing", async () => {
    const { p } = await plugin();
    expect((await p.callTool(req("create", { prompt: "x", at: "2027-01-01T00:00:00Z" }))).isError).toBe(true);
    expect((await p.callTool(req("create", { name: "x", at: "2027-01-01T00:00:00Z" }))).isError).toBe(true);
    expect((await p.callTool(req("create", { name: "x", prompt: "y" }))).output).toContain("one of at");
    const two = await p.callTool(req("create", { name: "x", prompt: "y", at: "2027-01-01T00:00:00Z", daily: "09:00" }));
    expect(two.isError).toBe(true);
    const past = await p.callTool(req("create", { name: "x", prompt: "y", at: "2020-01-01T00:00:00Z" }));
    expect(past.output).toContain("in the past");
    const tooFast = await p.callTool(req("create", { name: "x", prompt: "y", every_minutes: 1 }));
    expect(tooFast.output).toContain("≥ 5");
    const notANumber = await p.callTool(req("create", { name: "x", prompt: "y", every_minutes: "soon" }));
    expect(notANumber.output).toContain("≥ 5");
    await p.shutdown();
  });

  test("a one-shot instant arrives as epoch milliseconds, the way the panel sends it", async () => {
    const { p } = await plugin();
    const at = Date.now() + 86_400_000;
    const made = await p.callTool(req("create", { name: "once", prompt: "p", at }));
    expect(made.isError).toBeFalsy();
    expect(made.output).toContain(`once at ${new Date(at).toISOString()}`);
    const digits = await p.callTool(req("create", { name: "digits", prompt: "p", at: String(at) }));
    expect(digits.output).toContain("ISO-8601");
    await p.shutdown();
  });

  test("an interval arrives as digits, the way a session's tool call sends it", async () => {
    const { p } = await plugin();
    // The call does not deliver a JSON number. These are the shapes that
    // were refused with the same "must be a number" line.
    const digits = await p.callTool(req("create", { name: "digits", prompt: "p", every_minutes: "30" }));
    expect(digits.isError).toBeFalsy();
    expect(digits.output).toContain("every 30m");
    const scientific = await p.callTool(req("create", { name: "scientific", prompt: "p", every_minutes: "60e0" }));
    expect(scientific.isError).toBeFalsy();
    expect(scientific.output).toContain("every 1h");
    const five = await p.callTool(req("create", { name: "five", prompt: "p", every_minutes: "5" }));
    expect(five.isError).toBeFalsy();
    expect(five.output).toContain("every 5m");
    const updated = await p.callTool(req("update", { name: "digits", every_minutes: "15" }));
    expect(updated.isError).toBeFalsy();
    expect(updated.output).toContain("every 15m");
    const stillShort = await p.callTool(req("update", { name: "five", every_minutes: "4" }));
    expect(stillShort.output).toContain("≥ 5");
    await p.shutdown();
  });

  test("a target outside the creator's workspace is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const calls: ControlCalls = { created: [], prompted: [] };
    const p = createSchedulePlugin({
      control: control(calls),
      // the caller sits in /repo; the other session lives in another repository
      view: (id: string) => ({
        ...view(false),
        session_id: id,
        workspace: id === CALLER ? WS : "/other-repo",
      }),
      workspaceOf: (id: string) => (id === CALLER ? WS : id === OTHER ? "/other-repo" : undefined),
      listSessions: () => [{ session_id: CALLER, title: "standup", workspace: WS }],
    });
    await p.initialize(ctxOf(dir));
    const out = await p.callTool(
      req("create", { name: "cross", prompt: "p", daily: "09:30", session_id: OTHER }),
    );
    expect(out.isError).toBe(true);
    expect(out.output).toContain("not in this workspace");
    await p.shutdown();
  });

  test("create persists; list and view read it back", async () => {
    const { p, dir } = await plugin();
    const out = await p.callTool(req("create", { name: "standup", prompt: "summarise", daily: "09:30" }));
    expect(out.output).toContain("daily 09:30");
    const list = await p.callTool(req("list"));
    expect(list.output).toContain("standup");
    const v = await p.callTool(req("view", { name: "standup" }));
    expect(v.output).toContain("prompt: summarise");
    // the file on disk is the same truth another instance would load
    expect(new SchedulesFile(join(dir, "schedules.json")).load()[0]!.name).toBe("standup");
    await p.shutdown();
  });

  test("update and delete are owner-only", async () => {
    const { p } = await plugin();
    await p.callTool(req("create", { name: "mine", prompt: "p", every_minutes: 30 }));
    const stranger = await p.callTool(req("update", { name: "mine", prompt: "hacked" }, OTHER));
    expect(stranger.output).toContain("no such schedule");
    const strangerDel = await p.callTool(req("delete", { name: "mine" }, OTHER));
    expect(strangerDel.isError).toBe(true);

    const upd = await p.callTool(req("update", { name: "mine", prompt: "better", enabled: false }));
    expect(upd.output).toContain("updated");
    expect(upd.output).toContain("disabled");
    const del = await p.callTool(req("delete", { name: "mine" }));
    expect(del.output).toContain("deleted");
    expect((await p.callTool(req("list"))).output).toBe("(no schedules)");
    await p.shutdown();
  });

  test("the panel route toggles and deletes a schedule regardless of owner", async () => {
    const { p } = await plugin();
    const created = await p.callTool(req("create", { name: "theirs", prompt: "p", every_minutes: 30 }));
    const id = /sch_[a-z0-9]+/.exec(created.output)![0]!;
    const toggle = await p.route!(new Request("http://x", { method: "POST" }), `/schedules/${id}/toggle`);
    expect(toggle!.status).toBe(200);
    expect((await p.callTool(req("view", { id }))).output).toContain("(disabled)");
    const del = await p.route!(new Request("http://x", { method: "DELETE" }), `/schedules/${id}`);
    expect(del!.status).toBe(200);
    expect((await p.callTool(req("list"))).output).toBe("(no schedules)");
    await p.shutdown();
  });

  test("the panel route makes a schedule and edits it", async () => {
    const { p } = await plugin();
    const made = await p.route!(
      new Request(`http://x?session=${CALLER}`, {
        method: "POST",
        body: JSON.stringify({ name: "standup", prompt: "summarise", daily: "09:30" }),
      }),
      "/schedules",
    );
    expect(made!.status).toBe(200);
    const body = (await made!.json()) as { schedule: Schedule };
    expect(body.schedule.name).toBe("standup");
    expect(body.schedule.created_by).toBe(CALLER);
    expect(body.schedule.target).toEqual({ kind: "session", session_id: CALLER });

    // The panel owns every schedule, so it may edit one it did not make.
    const edited = await p.route!(
      new Request(`http://x?session=${CALLER}`, {
        method: "PUT",
        body: JSON.stringify({ prompt: "summarise the week" }),
      }),
      `/schedules/${body.schedule.id}`,
    );
    expect(edited!.status).toBe(200);
    const after = (await edited!.json()) as { schedule: Schedule };
    expect(after.schedule.prompt).toBe("summarise the week");
    await p.shutdown();
  });

  test("the panel route names the session it acts for", async () => {
    const { p } = await plugin();
    const noSession = await p.route!(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ name: "x", prompt: "y", daily: "09:30" }),
      }),
      "/schedules",
    );
    expect(noSession!.status).toBe(400);
    const noBody = await p.route!(
      new Request(`http://x?session=${CALLER}`, { method: "POST" }),
      "/schedules",
    );
    expect(noBody!.status).toBe(400);
    await p.shutdown();
  });

  test("readResource serves the schedules the panel asks for", async () => {
    const { p } = await plugin();
    await p.callTool(req("create", { name: "a", prompt: "p", daily: "08:00" }));
    const res = await p.readResource!({ key: "schedules", sessionId: CALLER });
    expect(res.mime).toBe("application/json");
    expect(JSON.parse(String(res.body)).schedules[0].name).toBe("a");
    await p.shutdown();
  });

  test("a session ending disables schedules pointed at it", async () => {
    const { p } = await plugin();
    await p.callTool(req("create", { name: "aimed", prompt: "p", every_minutes: 30 }));
    await p.callTool(req("create", { name: "elsewhere", prompt: "p", every_minutes: 30, session_id: OTHER }));
    await p.sessionEnded!(CALLER);
    const list = await p.callTool(req("list"));
    const aimed = list.output.split("\n").find((l) => l.includes("aimed"))!;
    expect(aimed).toContain("disabled");
    expect(list.output).toContain("elsewhere");
    await p.shutdown();
  });

  test("manifest policy: writes follow the posture, reads allow; the panel names its resource", async () => {
    const { p } = await plugin();
    const policyOf = (n: string) => manifest.tools.find((t) => t.name === n)!.policy;
    expect(policyOf("create")).toEqual({ default: "allow", risk: "write" });
    expect(policyOf("update")).toEqual({ default: "allow", risk: "write" });
    expect(policyOf("delete")).toEqual({ default: "allow", risk: "write" });
    expect(policyOf("list")).toEqual({ default: "allow", risk: "read" });
    expect(policyOf("view")).toEqual({ default: "allow", risk: "read" });
    expect(manifest.panel?.resource).toBe("schedules");
    await p.shutdown();
  });

  describe("the panel's shape of a schedule", () => {
    test("a weekly timing may be given as a weekday and a clock, not as English", async () => {
      // The panel holds a weekday as the number it is and a clock as two
      // halves; it has no English weekday to give. The tool still spells it
      // out, and both land on the same thing.
      const { p } = await plugin();
      const made = await p.callTool(
        req("create", { name: "weekly", prompt: "p", weekly: { weekday: 5, hour: 18, minute: 30 } }),
      );
      expect(made.isError).toBeFalsy();
      const seen = await p.callTool(req("view", { name: "weekly" }));
      expect(seen.output).toContain("fri 18:30");
      await p.shutdown();
    });

    test("a weekly timing with a bad weekday is refused", async () => {
      const { p } = await plugin();
      const made = await p.callTool(
        req("create", { name: "weekly", prompt: "p", weekly: { weekday: 9, hour: 18, minute: 30 } }),
      );
      expect(made.isError).toBe(true);
      expect(made.output).toContain("weekday");
      await p.shutdown();
    });

    test("a rename takes effect", async () => {
      // The update tool accepts a name and the tools say it may change one,
      // so a renamed schedule has to answer to its new name.
      const { p } = await plugin();
      await p.callTool(req("create", { name: "old", prompt: "p", every_minutes: 30 }));
      const list = await p.callTool(req("list"));
      const id = list.output.split("\n")[0]!.split(" ")[0]!;
      const updated = await p.callTool(req("update", { id, name: "new" }));
      expect(updated.isError).toBeFalsy();
      const after = await p.callTool(req("list"));
      expect(after.output).toContain("new");
      expect(after.output).not.toContain("old");
      await p.shutdown();
    });

    test("a rename onto a taken name is refused", async () => {
      const { p } = await plugin();
      await p.callTool(req("create", { name: "first", prompt: "p", every_minutes: 30 }));
      await p.callTool(req("create", { name: "second", prompt: "p", every_minutes: 30 }));
      const list = await p.callTool(req("list"));
      const id = list.output.split("\n")[0]!.split(" ")[0]!;
      const clash = await p.callTool(req("update", { id, name: "second" }));
      expect(clash.isError).toBe(true);
      expect(clash.output).toContain("already taken");
      expect(clash.output).not.toMatch(/sch_[a-z0-9]+/);
      await p.shutdown();
    });

    test("the resource names the target session and offers the ones it may reach", async () => {
      const { p } = await plugin();
      await p.callTool(req("create", { name: "aimed", prompt: "p", every_minutes: 30 }));
      const read = await p.readResource!({ key: "schedules", sessionId: CALLER });
      const body = JSON.parse(String(read.body)) as {
        schedules: { target_title?: string }[];
        candidates: { session_id: string }[];
      };
      expect(body.schedules[0]!.target_title).toBe("standup");
      expect(body.candidates.map((c) => c.session_id)).toContain(CALLER);
      await p.shutdown();
    });

    test("an empty workspace still scopes candidates by the requesting session", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sched-"));
      const calls: ControlCalls = { created: [], prompted: [] };
      const reads: { workspace?: string; limit?: number }[] = [];
      const p = createSchedulePlugin({
        control: control(calls),
        view: () => view(false),
        workspaceOf: (id) => (id === CALLER ? WS : undefined),
        listSessions: (opts) => {
          reads.push(opts);
          return [];
        },
      });
      await p.initialize(ctxOf(dir));
      await p.readResource!({ key: "schedules", sessionId: CALLER });
      expect(reads).toEqual([{ workspace: WS, limit: 200 }]);
      await p.shutdown();
    });
  });
});


describe("the engine's last run", () => {
  test("carries a code beside the note, so a reader can be shown a sentence", async () => {
    // The note is English prose for the log; the code is what a window
    // can translate. A busy session says so in both.
    const dir = mkdtempSync(join(tmpdir(), "sched-"));
    const calls: ControlCalls = { created: [], prompted: [] };
    const deps = engineDeps(dir, {
      control: control(calls),
      view: () => view(true),
    });
    const s = seed(dir, { when: { kind: "every", everyMs: 3600000 } });
    const engine = new ScheduleEngine(deps);
    await engine.runDue(false);
    await engine.stop();

    const saved = deps.file.load().find((x) => x.id === s.id)!;
    expect(saved.last_result).toBe("skipped-busy");
    expect(saved.last_code).toBe("busy");
    expect(saved.last_note).toContain("busy");
  });
});



describe("engine deadlines", () => {
  test("a hung operation times out and the next due schedule still fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-deadline-"));
    const first = seed(dir, { name: "first" });
    const second = seed(dir, { name: "second" });
    const deps = engineDeps(dir, {
      operationTimeoutMs: 20,
      control: {
        ...control(),
        prompt: async (_sessionId: string, text: string, signal?: AbortSignal) => {
          if (!text.includes("first")) return;
          return new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      },
    });
    const engine = new ScheduleEngine(deps);

    await engine.runDue(false);
    await engine.stop();

    expect(deps.file.load().find((row) => row.id === first.id)).toMatchObject({
      last_result: "failed",
      last_note: "schedule operation timed out",
    });
    expect(deps.file.load().find((row) => row.id === second.id)?.last_result).toBe("ok");
  });

  test("stop aborts the current operation and does not fire the next schedule", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-stop-"));
    const first = seed(dir, { name: "first" });
    const second = seed(dir, { name: "second" });
    let aborted = false;
    const prompted: string[] = [];
    const deps = engineDeps(dir, {
      control: {
        ...control(),
        prompt: async (_sessionId: string, text: string, signal?: AbortSignal) => {
          prompted.push(text);
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            }, { once: true });
          });
        },
      },
    });
    const engine = new ScheduleEngine(deps);
    const due = engine.runDue(false);

    await engine.stop();
    await due;

    expect(aborted).toBe(true);
    expect(prompted).toHaveLength(1);
    expect(deps.file.load().find((row) => row.id === first.id)).toMatchObject({
      last_result: "failed",
      last_note: "schedule stopped",
    });
    expect(deps.file.load().find((row) => row.id === second.id)?.last_run_at).toBeUndefined();
  });
});
