import type { SessionView } from "@agent-strata/projector";

/** The only reply that means the goal is finished. Anything else keeps going. */
export const GOAL_MET = "GOAL MET";

/** The plan entry a continuation should do next: the one in progress, else the first still pending. */
export function nextPlanStep(
  plan: readonly { content: string; status: string }[] | undefined,
): string | undefined {
  if (!plan) return undefined;
  const hit = plan.find((entry) => entry.status === "in_progress") ?? plan.find((entry) => entry.status === "pending");
  const text = hit?.content.trim();
  if (!text) return undefined;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** What the service sends when a session with a goal goes idle. */
export function goalContinuation(goal: string, next?: string): string {
  const lines = [
    "The session has a goal. Continue working toward it. Take the next concrete step.",
    "",
    "Goal:",
    goal,
  ];
  if (next) lines.push("", "Next plan item:", next);
  lines.push("", "If the goal is already met, reply with exactly this line and nothing else:", GOAL_MET);
  return lines.join("\n");
}

export function goalIsMet(text: string): boolean {
  const line = text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return line === GOAL_MET;
}

export function sessionAwaiting(
  view: Pick<SessionView, "pending_permissions" | "pending_questions" | "turns" | "orphans">,
): boolean {
  if (view.pending_questions.length > 0) return true;
  if (view.pending_permissions.some((p) => p.decision === undefined)) return true;
  const calls = [...view.turns.flatMap((turn) => turn.tool_calls), ...view.orphans];
  return calls.some(
    (call) => call.status === "pending" && call.permission !== undefined && call.permission.decision === undefined,
  );
}

/** The latest finished assistant text, skipping a message still being written. */
export function lastAssistantReply(
  turns: SessionView["turns"],
): { text: string; seq?: number } | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const assistants = turns[i]!.assistant;
    for (let j = assistants.length - 1; j >= 0; j--) {
      const message = assistants[j]!;
      if (message.partial) continue;
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text) return { text, ...(message.seq !== undefined ? { seq: message.seq } : {}) };
    }
  }
  return undefined;
}

/**
 * A GOAL MET reply completes the goal only when it was written after the goal
 * was saved. An older reply belongs to the previous run; saving again must
 * not complete the new goal immediately.
 */
export function goalMetByReply(input: {
  goal?: string;
  met?: boolean;
  goalSeq?: number;
  reply?: { text: string; seq?: number };
}): boolean {
  if (!input.goal || input.met || !input.reply || !goalIsMet(input.reply.text)) return false;
  if (input.goalSeq !== undefined) {
    if (input.reply.seq === undefined || input.reply.seq <= input.goalSeq) return false;
  }
  return true;
}

/**
 * Whether an idle session should be handed another step.
 *
 * `kicked` means a continuation was already sent and the run has not shown
 * itself as busy yet, so a second idle must not send another one.
 * `paused` means the user aborted, which would otherwise look like an ordinary
 * idle and immediately undo the abort.
 * `held` means the reader paused the goal itself. That one is stored on the
 * goal, and a later message does not lift it.
 */
export function shouldContinueGoal(input: {
  goal?: string;
  busy: boolean;
  status: SessionView["status"];
  deleted?: boolean;
  archived?: boolean;
  pending: boolean;
  paused: boolean;
  kicked: boolean;
  /** Recorded on the goal itself, so a later message does not start the loop again. */
  met?: boolean;
  /** Recorded on the goal itself. Resume is a separate write. */
  held?: boolean;
}): boolean {
  if (!input.goal || input.met || input.held) return false;
  if (input.busy || input.paused || input.kicked || input.pending) return false;
  if (input.deleted || input.archived) return false;
  if (input.status !== "active") return false;
  return true;
}
