// schedule_* as a builtin plugin: prompts on a clock.
//
// The first plugin that acts without being called. Its timer is the
// plugin's own code — policy governs the tool-execution entry point, not a
// builtin's heartbeat — so what it may do is bounded by what it is injected
// with: `sessionControl`'s create/prompt, the same verbs the HTTP routes
// run. Every prompt a schedule sends is prefixed `[scheduled: <name>]`, so
// the receiving transcript explains itself.
//
// Grammar stays small on purpose: one-shot `at`, a fixed `every`, a local
// `daily` or `weekly` clock. A missed beat runs at most once, inside the
// catch-up window; a busy session is skipped, never queued.
//
// Ownership follows the dev plugin: only the session that created a
// schedule may update or delete it, and another session's id answers
// "no such schedule" rather than "exists but forbidden". The reader's panel
// route is exempt — the person owns every schedule.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  PluginContext,
  PluginManifest,
  PluginTool,
  StrataPlugin,
  ToolCallRequest,
  ToolCallResult,
} from "@agent-strata/plugin-sdk";
import type { SessionView } from "@agent-strata/projector";
import { ScheduleEngine, type ScheduleControl } from "./engine";
import { describeWhen, firstAt, parseClock, parseWeekly, type Schedule, type When } from "./model";
import { SchedulesFile } from "./schedules-file";

/** What the plugin is injected with — the ceiling of what its timer may do. */
export interface ScheduleHost {
  control: ScheduleControl;
  view(sessionId: string): SessionView;
  workspaceOf(sessionId: string): string | undefined;
  /**
   * The sessions a schedule may name, in one workspace.
   *
   * The panel asks the reader to pick a target session by name. The
   * list is deliberately one workspace's: a schedule may only reach a
   * session in the creator's workspace, so offering one from elsewhere
   * would be offering a save that is refused.
   */
  listSessions(opts: { workspace?: string; limit?: number }): {
    session_id: string;
    title?: string | null;
    workspace?: string | null;
  }[];
}

const WHEN_FIELDS = ["at", "every_minutes", "daily", "weekly"] as const;

export const manifest: PluginManifest = {
  id: "schedule",
  name: "Scheduled prompts",
  version: "1.0.0",
  description: "Send a prompt to this session — or a fresh one — on a clock you set.",
  entry: { kind: "builtin" },
  provides: ["tools", "resources", "panel"],
  permissions: {},
  hooks: { systemPrompt: true, beforeTool: [] },
  tools: [
    {
      name: "create",
      description: [
        "Schedule a prompt. Exactly one timing: `at` (ISO timestamp, one shot),",
        "`every_minutes` (digits, minimum 5, e.g. \"30\"), `daily` (\"HH:MM\" local time), or",
        "`weekly` (\"<weekday> HH:MM\" local time, e.g. \"fri 18:00\").",
        "",
        "By default the prompt lands in this session; pass `new_session: true`",
        "to start a fresh one on `connection_id` (or this session's connection).",
        "The injected text is prefixed `[scheduled: <name>]`.",
        "",
        "A fire while the session is busy is skipped, not queued. A fire missed",
        "while the app was down runs once if it is under 30 minutes old, then",
        "marks itself missed. Creating a schedule asks the user first.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "A short label, unique among your schedules." },
          prompt: { type: "string", description: "The text sent when it fires." },
          at: { type: "string", description: "One shot: ISO-8601 timestamp." },
          every_minutes: {
            type: "string",
            description: "Repeating: minutes between fires, minimum 5, written as digits (\"30\").",
          },
          daily: { type: "string", description: "Repeating: \"HH:MM\" in local time." },
          weekly: { type: "string", description: "Repeating: \"<weekday> HH:MM\" in local time." },
          session_id: { type: "string", description: "Target session; defaults to this session." },
          new_session: { type: "boolean", description: "Start a fresh session each fire instead." },
          connection_id: { type: "string", description: "For new_session: which backend connection; defaults to this session's." },
          enabled: { type: "boolean", description: "Defaults to true." },
        },
        required: ["name", "prompt"],
      },
      policy: { default: "allow", risk: "write" },
    },
    {
      name: "list",
      description: "Every schedule in the app, with its next fire and last result.",
      input: { type: "object", properties: {} },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "view",
      description: "One schedule's full state: timing, target, last result, who created it. `id` or `name`.",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
      policy: { default: "allow", risk: "read" },
    },
    {
      name: "update",
      description: [
        "Change a schedule you created: name, prompt, timing, target, or",
        "`enabled` to pause/resume. Same fields as create. `id` or `name`.",
      ].join("\n"),
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          prompt: { type: "string" },
          at: { type: "string" },
          every_minutes: {
            type: "string",
            description: "Repeating: minutes between fires, minimum 5, written as digits (\"30\").",
          },
          daily: { type: "string" },
          weekly: { type: "string" },
          session_id: { type: "string" },
          new_session: { type: "boolean" },
          connection_id: { type: "string" },
          enabled: { type: "boolean" },
        },
      },
      policy: { default: "allow", risk: "write" },
    },
    {
      name: "delete",
      description: "Remove a schedule you created. `id` or `name`.",
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
        },
      },
      policy: { default: "allow", risk: "write" },
    },
  ],
  resources: [{ key: "schedules", mime: "application/json", description: "Every schedule and its last result.", scope: "session" }],
  panel: { id: "schedules", title: "Schedules", kind: "component", resource: "schedules" },
};

function err(message: string): ToolCallResult {
  return { output: `error: ${message}`, isError: true };
}

/**
 * Minutes from a tool argument.
 *
 * `Number` reads the strings a session actually sends (`"30"`, `"60e0"`)
 * and leaves a genuine number alone. Anything else is not a duration.
 */
function minutesOf(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/**
 * Parse the one timing field the caller gave — exactly one is required.
 *
 * The grammar is deliberately narrow: the agent's tool spells a weekly as
 * `"fri 18:00"`, because a model writes English weekdays and a wall-clock
 * string. A reader's panel has no such grammar — its weekday picker holds
 * a number, and a locale it does not share with the agent. So the panel
 * sends `{ weekday, hour, minute }` and both are read here.
 *
 * The two shapes land on the same {@link When}, so nothing downstream has
 * to know which caller wrote it.
 */
function parseWhen(input: Record<string, unknown>): When | string {
  const given = WHEN_FIELDS.filter((k) => input[k] !== undefined);
  if (given.length === 0) return "one of at / every_minutes / daily / weekly is required";
  if (given.length > 1) return `give one timing, not ${given.join(" + ")}`;
  try {
    switch (given[0]) {
      case "at": {
        const at = Date.parse(str(input, "at") ?? "");
        if (!Number.isFinite(at)) return `at must be an ISO-8601 timestamp, got ${JSON.stringify(input.at)}`;
        return { kind: "at", at };
      }
      case "every_minutes": {
        // A session's tool call does not deliver a JSON number — the same
        // call writes `daily` and `weekly` as text and those land. Digits
        // in a string are the form that arrives; a real number still does,
        // from the panel and from a client that kept the type.
        const mins = minutesOf(input.every_minutes);
        if (mins === undefined || mins < 5) {
          return `every_minutes must be a number ≥ 5, got ${JSON.stringify(input.every_minutes)}`;
        }
        return { kind: "every", everyMs: Math.round(mins * 60000) };
      }
      case "daily":
        return { kind: "daily", ...parseClock(str(input, "daily")!) };
      case "weekly": {
        const raw = input.weekly;
        if (raw && typeof raw === "object") {
          const parts = raw as { weekday?: unknown; hour?: unknown; minute?: unknown };
          const weekday = Number(parts.weekday);
          const hour = Number(parts.hour);
          const minute = Number(parts.minute);
          if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
            return `weekly.weekday must be 0-6, got ${JSON.stringify(parts.weekday)}`;
          }
          if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
            return `weekly.hour must be 0-23, got ${JSON.stringify(parts.hour)}`;
          }
          if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
            return `weekly.minute must be 0-59, got ${JSON.stringify(parts.minute)}`;
          }
          return { kind: "weekly", weekday, hour, minute };
        }
        return { kind: "weekly", ...parseWeekly(str(input, "weekly")!) };
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "unreachable";
}

export function createSchedulePlugin(host: ScheduleHost): StrataPlugin {
  let ctx: PluginContext;
  let file: SchedulesFile;
  let engine: ScheduleEngine;

  const find = (idOrName: { id?: string; name?: string }): Schedule | undefined => {
    const all = file.load();
    if (idOrName.id) return all.find((s) => s.id === idOrName.id);
    if (idOrName.name) return all.find((s) => s.name === idOrName.name);
    return undefined;
  };

  /** A schedule the caller may mutate. Another session's is not a lookup failure to leak. */
  const owned = (sessionId: string, idOrName: { id?: string; name?: string }): Schedule | string => {
    if (!idOrName.id && !idOrName.name) return "id or name is required";
    const s = find(idOrName);
    if (!s || s.created_by !== sessionId) return `no such schedule: ${idOrName.id ?? idOrName.name}`;
    return s;
  };

  const visible = (idOrName: { id?: string; name?: string }): Schedule | string => {
    if (!idOrName.id && !idOrName.name) return "id or name is required";
    const s = find(idOrName);
    return s ?? `no such schedule: ${idOrName.id ?? idOrName.name}`;
  };

  /**
   * A schedule may only reach a session in the creator's workspace.
   *
   * The resolver that turns a name into a session id is global, and the
   * view reads any session, so without this a schedule made in one
   * repository could prompt a session in another - the boundary the
   * sessions plugin keeps for reads. The creator's own session is always
   * in scope: that is the default target.
   */
  const inScope = (creatorId: string, sessionId: string): boolean => {
    if (sessionId === creatorId) return true;
    const ws = host.workspaceOf(creatorId);
    if (ws === undefined) return false;
    try {
      return host.view(sessionId).workspace === ws;
    } catch {
      return false;
    }
  };

  const describe = (s: Schedule): string =>
    [
      `${s.id}  ${s.name}${s.enabled ? "" : "  (disabled)"}`,
      `  when: ${describeWhen(s.when)}${s.next_at ? `  next: ${s.next_at}` : ""}`,
      `  target: ${s.target.kind === "session" ? `session ${s.target.session_id}` : `new session${s.target.connection_id ? ` on ${s.target.connection_id}` : ""}`}`,
      `  created by: ${s.created_by}`,
      s.last_result ? `  last: ${s.last_result}${s.last_run_at ? ` at ${s.last_run_at}` : ""}${s.last_note ? ` — ${s.last_note}` : ""}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

  /**
   * Build a schedule from an input.
   *
   * The tools and the reader's panel both make schedules, so the rules live
   * here once: the same name, prompt, timing and target checks, and the
   * same workspace boundary.
   */
  const makeSchedule = (
    input: Record<string, unknown>,
    sessionId: string,
  ): { schedule?: Schedule; error?: string } => {
    const name = str(input, "name");
    const prompt = str(input, "prompt");
    if (!name) return { error: "name is required" };
    if (!prompt) return { error: "prompt is required" };
    const when = parseWhen(input);
    if (typeof when === "string") return { error: when };
    if (when.kind === "at" && when.at <= Date.now()) return { error: "at is in the past" };

    const newSession = input.new_session === true;
    let target: Schedule["target"];
    if (newSession) {
      const connectionId = str(input, "connection_id");
      if (connectionId && !host.control.connections().some((c) => c.id === connectionId && c.canPrompt)) {
        return { error: `connection ${connectionId} cannot prompt` };
      }
      target = { kind: "new_session", connection_id: connectionId };
    } else {
      let targetSession = sessionId;
      const named = str(input, "session_id");
      if (named) {
        try {
          targetSession = ctx.resolveSession(named);
        } catch {
          return { error: `no such session: ${named}` };
        }
        try {
          host.view(targetSession);
        } catch {
          return { error: `no such session: ${named}` };
        }
        if (!inScope(sessionId, targetSession)) {
          return { error: "that session is not in this workspace" };
        }
      }
      target = { kind: "session", session_id: targetSession };
    }

    const clash = find({ name });
    // The id is an internal handle. "taken by sch_…" does not say which
    // schedule it is, so the sentence stops at the name.
    if (clash) return { error: `the name ${name} is already taken` };

    const schedule: Schedule = {
      id: `sch_${randomBytes(4).toString("hex")}`,
      name,
      prompt,
      created_by: sessionId,
      created_at: new Date().toISOString(),
      enabled: input.enabled !== false,
      when,
      target,
      next_at: null,
    };
    schedule.next_at = isoOrNull(firstAt(when, Date.now()));
    file.mutate((all) => {
      all.push(schedule);
    });
    engine.rearm();
    ctx.emit({ type: "changed" });
    return { schedule };
  };

  const create = (req: ToolCallRequest): ToolCallResult => {
    const made = makeSchedule(req.input, req.sessionId);
    if (made.error) return err(made.error);
    return { output: `created ${describe(made.schedule!)}` };
  };

  /**
   * Apply an input to a schedule.
   *
   * The tools may only touch a schedule they created; the reader's panel
   * owns them all. The rules are the same either way, so they live here
   * once.
   */
  const applyTo = (
    target: Schedule,
    input: Record<string, unknown>,
    sessionId: string,
  ): { error?: string } => {
    const whenTouched = WHEN_FIELDS.some((k) => input[k] !== undefined);
    let when = target.when;
    if (whenTouched) {
      const parsed = parseWhen(input);
      if (typeof parsed === "string") return { error: parsed };
      when = parsed;
    }
    const prompt = str(input, "prompt") ?? target.prompt;
    // The name is part of what an update may change, and the tools say so.
    // It used to be accepted and then dropped, which left a reader who
    // renamed a schedule looking at the old name with no error to explain
    // it.
    const name = str(input, "name") ?? target.name;
    if (name !== target.name) {
      const clash = find({ name });
      if (clash) return { error: `the name ${name} is already taken` };
    }
    const enabled = typeof input.enabled === "boolean" ? input.enabled : target.enabled;

    const newSession = input.new_session === true ? true : input.new_session === false ? false : target.target.kind === "new_session";
    let next: Schedule["target"] = target.target;
    if (newSession && target.target.kind !== "new_session") {
      next = { kind: "new_session", connection_id: str(input, "connection_id") };
    } else if (!newSession) {
      const named = str(input, "session_id");
      if (named) {
        let resolved: string;
        try {
          resolved = ctx.resolveSession(named);
          host.view(resolved);
        } catch {
          return { error: `no such session: ${named}` };
        }
        if (!inScope(sessionId, resolved)) {
          return { error: "that session is not in this workspace" };
        }
        next = { kind: "session", session_id: resolved };
      } else {
        next = target.target.kind === "session" ? target.target : { kind: "session", session_id: sessionId };
      }
    }
    if (next.kind === "new_session" && input.connection_id !== undefined) {
      next = { kind: "new_session", connection_id: str(input, "connection_id") };
    }

    file.mutate((all) => {
      const cur = all.find((s) => s.id === target.id);
      if (!cur) return;
      cur.name = name;
      cur.prompt = prompt;
      cur.enabled = enabled;
      cur.when = when;
      cur.target = next;
      cur.next_at = enabled ? isoOrNull(firstAt(when, Date.now())) : null;
    });
    engine.rearm();
    ctx.emit({ type: "changed" });
    return {};
  };

  const update = (req: ToolCallRequest): ToolCallResult => {
    const target = owned(req.sessionId, { id: str(req.input, "id"), name: str(req.input, "name") });
    if (typeof target === "string") return err(target);
    const applied = applyTo(target, req.input, req.sessionId);
    if (applied.error) return err(applied.error);
    const updated = find({ id: target.id });
    return { output: `updated ${updated ? describe(updated) : target.id}` };
  };

  return {
    async initialize(pluginCtx) {
      ctx = pluginCtx;
      file = new SchedulesFile(join(ctx.dataDir, "schedules.json"));
      engine = new ScheduleEngine({
        file,
        control: host.control,
        view: host.view,
        workspaceOf: host.workspaceOf,
        logger: ctx.logger,
        emit: (e) => ctx.emit(e),
        now: () => Date.now(),
        catchupWindowMs: 30 * 60 * 1000,
      });
      await engine.start();
    },

    async shutdown() {
      await engine.stop();
    },

    async sessionEnded(sessionId) {
      // A schedule aimed at a session that ended must say so, not fire into
      // the dark on the next beat.
      const touched = file.mutate((all) => {
        let n = 0;
        for (const s of all) {
          if (s.enabled && s.target.kind === "session" && s.target.session_id === sessionId) {
            s.enabled = false;
            s.next_at = null;
            s.last_result = "failed";
            s.last_note = "target session ended";
            n++;
          }
        }
        return n;
      });
      if (touched > 0) ctx.emit({ type: "changed" });
    },

    listTools(): PluginTool[] {
      return manifest.tools.map((t) => ({ name: t.name, description: t.description, input: t.input }));
    },

    async callTool(req) {
      switch (req.tool) {
        case "create":
          return create(req);
        case "list": {
          const lines = file.load().map(
            (s) =>
              `${s.id} | ${s.name} | ${s.enabled ? (s.next_at ?? "—") : "disabled"} | ${describeWhen(s.when)} | ${s.target.kind}${s.target.kind === "session" ? `:${s.target.session_id}` : ""} | ${s.last_result ?? "never"}`,
          );
          return { output: lines.length > 0 ? lines.join("\n") : "(no schedules)" };
        }
        case "view": {
          const s = visible({ id: str(req.input, "id"), name: str(req.input, "name") });
          if (typeof s === "string") return err(s);
          return { output: `${describe(s)}\n  prompt: ${s.prompt}` };
        }
        case "update":
          return update(req);
        case "delete": {
          const s = owned(req.sessionId, { id: str(req.input, "id"), name: str(req.input, "name") });
          if (typeof s === "string") return err(s);
          file.mutate((all) => {
            const i = all.findIndex((x) => x.id === s.id);
            if (i >= 0) all.splice(i, 1);
          });
          engine.rearm();
          ctx.emit({ type: "changed" });
          return { output: `deleted ${s.id} (${s.name})` };
        }
        default:
          return err(`unknown tool: ${req.tool}`);
      }
    },

    async readResource(req) {
      if (req.key !== "schedules") throw new Error(`no resource ${req.key}`);
      if (!req.sessionId) throw new Error("session required");
      // The reader's first question about a schedule is which session it
      // lands in, and a session id answers nothing to a human. The title is
      // looked up here, because the plugin is the only side that can see
      // sessions the panel did not create.
      const titleOf = (sessionId: string): string | undefined => {
        try {
          return host.view(sessionId).title;
        } catch {
          return undefined;
        }
      };
      const schedules = file.load().map((s) => ({
        ...s,
        target_title: s.target.kind === "session" ? titleOf(s.target.session_id) : undefined,
      }));
      // The sessions a schedule may name, so the reader picks one by its
      // name instead of by an id they cannot see. The list is one
      // workspace's and no other: a target outside the creator's
      // workspace is refused on save anyway, so offering it would only
      // be offering an error.
      const workspace = host.workspaceOf(req.sessionId);
      const candidates = host
        .listSessions({ workspace, limit: 200 })
        .map((s) => ({ session_id: s.session_id, title: s.title }));
      return {
        mime: "application/json",
        body: JSON.stringify({ schedules, candidates }, null, 2),
      };
    },

    async route(req, subpath) {
      // The reader's panel: make, edit, pause and remove a schedule.
      // Unlike the tools this is not owner-scoped — the person owns every
      // schedule — but the session is still named, because a schedule is
      // made by a session and may only reach that session's workspace.
      const url = new URL(req.url);
      const sessionOf = (): string | undefined => {
        const requested = url.searchParams.get("session");
        return requested === null ? undefined : ctx.resolveSession(requested);
      };
      const body = async (): Promise<Record<string, unknown> | undefined> => {
        const parsed = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
      };

      if (subpath === "/schedules" && req.method === "POST") {
        const sessionId = sessionOf();
        if (!sessionId) return Response.json({ error: "session is required" }, { status: 400 });
        const input = await body();
        if (!input) return Response.json({ error: "a body is required" }, { status: 400 });
        const made = makeSchedule(input, sessionId);
        if (made.error) return Response.json({ error: made.error, code: "schedule-invalid" }, { status: 400 });
        return Response.json({ ok: true, schedule: made.schedule });
      }

      const m = /^\/schedules\/(sch_[a-z0-9]+)(?:\/(toggle))?$/.exec(subpath);
      if (!m) return undefined;
      const s = find({ id: m[1] });
      if (!s) return Response.json({ error: "not found", code: "schedule-not-found" }, { status: 404 });
      if (req.method === "PUT") {
        const sessionId = sessionOf();
        if (!sessionId) return Response.json({ error: "session is required", code: "session-required" }, { status: 400 });
        const input = await body();
        if (!input) return Response.json({ error: "a body is required", code: "body-required" }, { status: 400 });
        const applied = applyTo(s, input, sessionId);
        if (applied.error) return Response.json({ error: applied.error, code: "schedule-invalid" }, { status: 400 });
        return Response.json({ ok: true, schedule: find({ id: s.id }) });
      }
      if (req.method === "DELETE") {
        file.mutate((all) => {
          const i = all.findIndex((x) => x.id === s.id);
          if (i >= 0) all.splice(i, 1);
        });
      } else if (m[2] === "toggle" && req.method === "POST") {
        file.mutate((all) => {
          const cur = all.find((x) => x.id === s.id);
          if (!cur) return;
          cur.enabled = !cur.enabled;
          cur.next_at = cur.enabled ? isoOrNull(firstAt(cur.when, Date.now())) : null;
        });
      } else {
        return Response.json({ error: "method not allowed", code: "method-not-allowed" }, { status: 405 });
      }
      engine.rearm();
      ctx.emit({ type: "changed" });
      return Response.json({ ok: true });
    },

    async systemPrompt() {
      return "A prompt prefixed `[scheduled: <name>]` was sent by a timer the user or an earlier session set — treat it as a queued request, not a fresh message from the person.";
    },
  };
}

function isoOrNull(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}
