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
        "`every_minutes` (fixed interval), `daily` (\"HH:MM\" local time), or",
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
          every_minutes: { type: "integer", description: "Repeating: minutes between fires, minimum 5." },
          daily: { type: "string", description: "Repeating: \"HH:MM\" in local time." },
          weekly: { type: "string", description: "Repeating: \"<weekday> HH:MM\" in local time." },
          session_id: { type: "string", description: "Target session; defaults to this session." },
          new_session: { type: "boolean", description: "Start a fresh session each fire instead." },
          connection_id: { type: "string", description: "For new_session: which backend connection; defaults to this session's." },
          enabled: { type: "boolean", description: "Defaults to true." },
        },
        required: ["name", "prompt"],
      },
      policy: { default: "ask", risk: "write" },
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
          every_minutes: { type: "integer" },
          daily: { type: "string" },
          weekly: { type: "string" },
          session_id: { type: "string" },
          new_session: { type: "boolean" },
          connection_id: { type: "string" },
          enabled: { type: "boolean" },
        },
      },
      policy: { default: "ask", risk: "write" },
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
      policy: { default: "ask", risk: "write" },
    },
  ],
  resources: [{ key: "schedules", mime: "application/json", description: "Every schedule and its last result." }],
  panel: { id: "schedules", title: "Schedules", kind: "status", resource: "schedules" },
};

function err(message: string): ToolCallResult {
  return { output: `error: ${message}`, isError: true };
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Parse the one timing field the caller gave — exactly one is required. */
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
        const mins = input.every_minutes;
        if (typeof mins !== "number" || !Number.isFinite(mins) || mins < 5) {
          return "every_minutes must be a number ≥ 5";
        }
        return { kind: "every", everyMs: Math.round(mins * 60000) };
      }
      case "daily":
        return { kind: "daily", ...parseClock(str(input, "daily")!) };
      case "weekly":
        return { kind: "weekly", ...parseWeekly(str(input, "weekly")!) };
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

  const create = (req: ToolCallRequest): ToolCallResult => {
    const name = str(req.input, "name");
    const prompt = str(req.input, "prompt");
    if (!name) return err("name is required");
    if (!prompt) return err("prompt is required");
    const when = parseWhen(req.input);
    if (typeof when === "string") return err(when);
    if (when.kind === "at" && when.at <= Date.now()) return err("at is in the past");

    const newSession = req.input.new_session === true;
    let target: Schedule["target"];
    if (newSession) {
      const connectionId = str(req.input, "connection_id");
      if (connectionId && !host.control.connections().some((c) => c.id === connectionId && c.canPrompt)) {
        return err(`connection ${connectionId} cannot prompt`);
      }
      target = { kind: "new_session", connection_id: connectionId };
    } else {
      let sessionId = req.sessionId;
      const named = str(req.input, "session_id");
      if (named) {
        try {
          sessionId = ctx.resolveSession(named);
        } catch {
          return err(`no such session: ${named}`);
        }
        try {
          host.view(sessionId);
        } catch {
          return err(`no such session: ${named}`);
        }
      }
      target = { kind: "session", session_id: sessionId };
    }

    const schedule: Schedule = {
      id: `sch_${randomBytes(4).toString("hex")}`,
      name,
      prompt,
      created_by: req.sessionId,
      created_at: new Date().toISOString(),
      enabled: req.input.enabled !== false,
      when,
      target,
      next_at: null,
    };
    schedule.next_at = isoOrNull(firstAt(when, Date.now()));
    const clash = find({ name });
    if (clash) return err(`the name ${name} is taken by ${clash.id}`);
    file.mutate((all) => {
      all.push(schedule);
    });
    engine.rearm();
    ctx.emit({ type: "changed" });
    return { output: `created ${describe(schedule)}` };
  };

  const update = (req: ToolCallRequest): ToolCallResult => {
    const target = owned(req.sessionId, { id: str(req.input, "id"), name: str(req.input, "name") });
    if (typeof target === "string") return err(target);

    const whenTouched = WHEN_FIELDS.some((k) => req.input[k] !== undefined);
    let when = target.when;
    if (whenTouched) {
      const parsed = parseWhen(req.input);
      if (typeof parsed === "string") return err(parsed);
      when = parsed;
    }
    const prompt = str(req.input, "prompt") ?? target.prompt;
    const enabled = typeof req.input.enabled === "boolean" ? req.input.enabled : target.enabled;

    const newSession = req.input.new_session === true ? true : req.input.new_session === false ? false : target.target.kind === "new_session";
    let next: Schedule["target"] = target.target;
    if (newSession && target.target.kind !== "new_session") {
      next = { kind: "new_session", connection_id: str(req.input, "connection_id") };
    } else if (!newSession) {
      const named = str(req.input, "session_id");
      if (named) {
        try {
          next = { kind: "session", session_id: ctx.resolveSession(named) };
          host.view(next.session_id);
        } catch {
          return err(`no such session: ${named}`);
        }
      } else {
        next = target.target.kind === "session" ? target.target : { kind: "session", session_id: req.sessionId };
      }
    }
    if (next.kind === "new_session" && req.input.connection_id !== undefined) {
      next = { kind: "new_session", connection_id: str(req.input, "connection_id") };
    }

    file.mutate((all) => {
      const cur = all.find((s) => s.id === target.id);
      if (!cur) return;
      cur.prompt = prompt;
      cur.enabled = enabled;
      cur.when = when;
      cur.target = next;
      cur.next_at = enabled ? isoOrNull(firstAt(when, Date.now())) : null;
    });
    engine.rearm();
    ctx.emit({ type: "changed" });
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
      return { mime: "application/json", body: JSON.stringify({ schedules: file.load() }, null, 2) };
    },

    async route(req, subpath) {
      // The reader's panel: pause/resume/delete any schedule. Unlike the
      // tools this is not owner-scoped — the person owns every schedule.
      const m = /^\/schedules\/(sch_[a-z0-9]+)(?:\/(toggle))?$/.exec(subpath);
      if (!m) return undefined;
      const s = find({ id: m[1] });
      if (!s) return Response.json({ error: "not found" }, { status: 404 });
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
        return Response.json({ error: "method not allowed" }, { status: 405 });
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
