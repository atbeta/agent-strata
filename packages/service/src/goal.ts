import type { SessionView } from "@agent-strata/projector";

/** The only reply that means the goal is finished. Anything else keeps going. */
export const GOAL_MET = "GOAL MET";

/** What the service sends when a session with a goal goes idle. */
export function goalContinuation(goal: string): string {
  return [
    "The session has a goal. Continue working toward it. Take the next concrete step.",
    "",
    "Goal:",
    goal,
    "",
    "If the goal is already met, reply with exactly this line and nothing else:",
    GOAL_MET,
  ].join("\n");
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
export function lastAssistantText(turns: SessionView["turns"]): string | undefined {
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
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * Whether an idle session should be handed another step.
 *
 * `kicked` means a continuation was already sent and the run has not shown
 * itself as busy yet, so a second idle must not send another one.
 * `paused` means the user aborted, which would otherwise look like an ordinary
 * idle and immediately undo the abort.
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
  lastAssistant?: string;
}): boolean {
  if (!input.goal) return false;
  if (input.busy || input.paused || input.kicked || input.pending) return false;
  if (input.deleted || input.archived) return false;
  if (input.status !== "active") return false;
  if (input.lastAssistant && goalIsMet(input.lastAssistant)) return false;
  return true;
}
