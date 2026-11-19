// The firing loop.
//
// One timer, always aimed at the soonest next_at — re-armed after every run
// and every mutation, so a wake also self-heals after sleep or a long delay
// (setTimeout tops out around 24.8 days; the clamp below wakes well inside
// that). A fire never queues: a session that is busy answers "skipped-busy"
// and the schedule advances to its next beat instead of piling prompts on a
// turn that is already running.
//
// What a fire is allowed to do is the point of the injected surface: prompt
// an existing session or create one — the exact two verbs `sessionControl`
// exposes, which take the same code paths a user's prompt does. The timer is
// the plugin's own code (policy does not gate it — see the platform doc), so
// it may do nothing else.

import type { Logger, PluginEvent } from "@agent-strata/plugin-sdk";
import type { SessionView } from "@agent-strata/projector";
import { followingAt, type RunResult, type Schedule } from "./model";
import type { SchedulesFile } from "./schedules-file";

export interface ScheduleControl {
  connections(): { id: string; agent: string; canPrompt: boolean }[];
  connectionOf(sessionId: string): string | undefined;
  create(opts: { connectionId: string; title?: string; directory?: string }): Promise<{ sessionId: string }>;
  prompt(sessionId: string, text: string): Promise<void>;
}

export interface EngineDeps {
  file: SchedulesFile;
  control: ScheduleControl;
  /** live session view — the busy check before a prompt lands */
  view(sessionId: string): SessionView;
  /** the creating session's workspace, for new-session targets */
  workspaceOf(sessionId: string): string | undefined;
  logger: Logger;
  emit(event: PluginEvent): void;
  now(): number;
  /** a missed fire still runs when it is this recent (default 30 min) */
  catchupWindowMs: number;
}

/** Never arm further out than this — the timer cap and sleep drift both live inside it. */
const REARM_CAP_MS = 6 * 60 * 60 * 1000;

export class ScheduleEngine {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly firing = new Set<string>();
  private stopped = true;

  constructor(private readonly deps: EngineDeps) {}

  /** Arm the loop and settle whatever was missed while the service was down. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.runDue(true);
    this.rearm();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // a fire already in flight finishes against whatever backend is still up
  }

  /** The soonest pending wake, for callers that just changed the table. */
  rearm(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const now = this.deps.now();
    const next = this.deps.file
      .load()
      .filter((s) => s.enabled && s.next_at !== null)
      .map((s) => Date.parse(s.next_at!))
      .reduce((min, at) => Math.min(min, at), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(next)) {
      this.timer = undefined;
      return;
    }
    const delay = Math.min(Math.max(next - now, 0), REARM_CAP_MS);
    this.timer = setTimeout(() => {
      void this.runDue(false).finally(() => this.rearm());
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /**
   * Fire everything due. On startup (`catchup`) a beat missed while the
   * service was down runs once inside the window and is otherwise marked
   * `missed`; either way the schedule advances — never a backlog replay.
   */
  async runDue(catchup: boolean): Promise<void> {
    const now = this.deps.now();
    for (const s of this.deps.file.load()) {
      if (!s.enabled || s.next_at === null || this.firing.has(s.id)) continue;
      const due = Date.parse(s.next_at);
      if (due > now) continue;
      if (catchup && now - due > this.deps.catchupWindowMs) {
        this.deps.file.mutate((all) => {
          const cur = all.find((x) => x.id === s.id);
          if (cur) this.settle(cur, now, "missed", "service was down past the catch-up window", "missed-window");
        });
        continue;
      }
      await this.fire(s.id, catchup ? "late" : "ok");
    }
  }

  /** Mark a schedule's last result and advance its next beat, atomically. */
  private settle(s: Schedule, now: number, result: RunResult, note?: string, code?: string): void {
    s.last_run_at = new Date(now).toISOString();
    s.last_result = result;
    s.last_note = note;
    s.last_code = code;
    if (s.when.kind === "at") {
      s.enabled = false;
      s.next_at = null;
    } else {
      s.next_at = isoOrNull(followingAt(s.when, now));
    }
  }

  private async fire(id: string, result: RunResult): Promise<void> {
    this.firing.add(id);
    const now = this.deps.now();
    try {
      const s = this.deps.file.load().find((x) => x.id === id);
      if (!s || !s.enabled || s.next_at === null) return;

      if (s.target.kind === "session") {
        let busy = false;
        try {
          busy = this.deps.view(s.target.session_id).busy;
        } catch {
          // the target is gone — say so on the schedule rather than lose it silently
          this.deps.file.mutate((all) => {
            const cur = all.find((x) => x.id === id);
            if (cur) {
              cur.enabled = false;
              this.settleDisabled(
                cur,
                "failed",
                `target session ${s.target.kind === "session" ? s.target.session_id : "?"} is not readable`,
                "target-unreadable",
              );
            }
          });
          this.deps.emit({ type: "changed" });
          return;
        }
        // The scope is checked here too, not only where the target was
        // named: the session may have moved out of the creator's
        // workspace since, and a fire must not cross that line.
        const targetId = s.target.session_id;
        if (!this.inScope(s, targetId)) {
          this.deps.file.mutate((all) => {
            const cur = all.find((x) => x.id === id);
            if (cur) {
              cur.enabled = false;
              this.settleDisabled(
                cur,
                "failed",
                `target session ${targetId} is outside this schedule's workspace`,
                "target-out-of-scope",
              );
            }
          });
          this.deps.emit({ type: "changed" });
          return;
        }
        if (busy) {
          this.deps.file.mutate((all) => {
            const cur = all.find((x) => x.id === id);
            if (cur) this.settle(cur, now, "skipped-busy", "session was busy; not queued", "busy");
          });
          this.deps.emit({ type: "changed" });
          return;
        }
      }

      try {
        if (s.target.kind === "new_session") {
          const conn = s.target.connection_id ?? this.deps.control.connectionOf(s.created_by);
          if (!conn) throw new Error("no connection to create a session on");
          const directory = this.deps.workspaceOf(s.created_by);
          const created = await this.deps.control.create({
            connectionId: conn,
            title: `schedule: ${s.name}`,
            directory,
          });
          s.last_note = `new session ${created.sessionId}`;
          await this.deps.control.prompt(created.sessionId, this.text(s));
        } else {
          // Re-checked: the session may have turned busy between the check
          // above and this prompt. A prompt that lands on a running turn is
          // what a human's own send does too, but the engine promised not
          // to.
          if (this.busy(s.target.session_id)) {
            this.deps.file.mutate((all) => {
              const cur = all.find((x) => x.id === id);
              if (cur) this.settle(cur, now, "skipped-busy", "session was busy; not queued", "busy");
            });
            this.deps.emit({ type: "changed" });
            return;
          }
          await this.deps.control.prompt(s.target.session_id, this.text(s));
        }
        this.deps.file.mutate((all) => {
          const cur = all.find((x) => x.id === id);
          if (cur) this.settle(cur, now, result, s.last_note, s.last_code);
        });
      } catch (error) {
        this.deps.file.mutate((all) => {
          const cur = all.find((x) => x.id === id);
          if (cur) this.settle(cur, now, "failed", error instanceof Error ? error.message : String(error), "failed");
        });
      }
      this.deps.emit({ type: "changed" });
    } finally {
      this.firing.delete(id);
    }
  }

  /** A disabled schedule still reports what happened to it. */
  private settleDisabled(s: Schedule, result: RunResult, note: string, code: string): void {
    s.last_run_at = new Date(this.deps.now()).toISOString();
    s.last_result = result;
    s.last_note = note;
    s.last_code = code;
    s.next_at = null;
  }

  /**
   * A target is in scope when it is the creator's own session or shares
   * the creator's workspace - the rule the plugin applies when the
   * target is named, checked again here because a session can change
   * its workspace, and because the rule must hold at the moment the
   * prompt actually goes out.
   */
  private inScope(s: Schedule, sessionId: string): boolean {
    if (sessionId === s.created_by) return true;
    const ws = this.deps.workspaceOf(s.created_by);
    if (ws === undefined) return false;
    try {
      return this.deps.view(sessionId).workspace === ws;
    } catch {
      return false;
    }
  }

  /** Whether a session is running a turn right now. */
  private busy(sessionId: string): boolean {
    try {
      return this.deps.view(sessionId).busy;
    } catch {
      return false;
    }
  }

  private text(s: Schedule): string {
    return `[scheduled: ${s.name}]\n\n${s.prompt}`;
  }
}

function isoOrNull(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}
