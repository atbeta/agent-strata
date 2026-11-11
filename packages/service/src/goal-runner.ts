import type { SessionView } from "@agent-strata/projector";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import type { Store } from "@agent-strata/store";
import type { BackendDriver } from "./driver";
import {
  goalContinuation,
  goalMetByReply,
  lastAssistantReply,
  nextPlanStep,
  sessionAwaiting,
  shouldContinueGoal,
} from "./goal";

export class GoalRunner {
  private readonly goalKicked = new Set<string>();
  private readonly goalPaused = new Set<string>();

  constructor(
    private readonly deps: {
      store: Store;
      sessionView(sessionId: string): SessionView;
      driverFor(sessionId: string): BackendDriver | undefined;
      directoryOf(sessionId: string): string | undefined;
      hasPending(sessionId: string): boolean;
    },
  ) {}

  handleEvent(event: EventInput): void {
    if (event.type === "session.status" && event.data.state === "busy") {
      this.goalKicked.delete(event.session_id);
    }
    if (event.type === "session.status" && event.data.state === "idle") {
      this.consider(event.session_id);
    }
    if (event.type === "permission.resolved" || event.type === "question.resolved") {
      this.consider(event.session_id);
    }
  }

  pause(sessionId: string): void {
    this.goalPaused.add(sessionId);
  }

  allow(sessionId: string): void {
    this.goalPaused.delete(sessionId);
  }

  reset(sessionId: string): void {
    this.goalPaused.delete(sessionId);
    this.goalKicked.delete(sessionId);
  }

  restart(sessionId: string): void {
    this.reset(sessionId);
    this.consider(sessionId);
  }

  consider(sessionId: string): void {
    let view: SessionView;
    try {
      view = this.deps.sessionView(sessionId);
    } catch {
      return;
    }
    const pending = sessionAwaiting(view) || this.deps.hasPending(sessionId);
    const goal = view.goal;
    if (
      goal &&
      goalMetByReply({
        goal,
        met: view.goal_met,
        goalSeq: view.goal_seq,
        reply: lastAssistantReply(view.turns),
      })
    ) {
      this.deps.store.append([
        makeEvent({
          session_id: sessionId,
          source: { backend: "desktop" },
          type: "session.goal",
          data: { text: goal, met: true },
        }) as EventInput,
      ]);
      return;
    }
    if (
      !shouldContinueGoal({
        goal,
        busy: view.busy,
        status: view.status,
        deleted: view.deleted,
        archived: view.archived,
        pending,
        paused: this.goalPaused.has(sessionId),
        kicked: this.goalKicked.has(sessionId),
        met: view.goal_met,
        held: view.goal_paused,
      })
    ) {
      return;
    }
    const conn = this.deps.driverFor(sessionId);
    const native = conn?.nativeId(sessionId);
    if (!conn || !native || !conn.capabilities.prompt || !view.goal) return;
    const text = goalContinuation(view.goal, nextPlanStep(view.plan));
    this.goalKicked.add(sessionId);
    void conn.prompt(native, [{ type: "text", text }], {
      directory: this.deps.directoryOf(sessionId),
    }).catch((error) => {
      this.goalKicked.delete(sessionId);
      console.error("goal continuation failed:", error);
    });
  }
}
