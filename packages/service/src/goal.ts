import type { SessionView } from "@agent-strata/projector";

/** The only reply that means the goal is finished. Anything else keeps going. */
export const GOAL_MET = "GOAL MET";

/** The last-line marker that means the goal cannot continue without the reader. */
export const GOAL_BLOCKED = "GOAL BLOCKED";

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
  lines.push(
    "",
    "This is an unattended run. Do not ask the user questions: choose reasonable assumptions, note them in your reply, and keep going. A question you do ask sits unanswered for minutes and is then auto-answered with \"use your best judgment\", so asking only wastes time.",
    "",
    "If you are truly blocked on something only the user can provide or decide — credentials, a destructive or irreversible choice — end your turn with the following as the last line, replacing the bracketed part with what you need and why:",
    `${GOAL_BLOCKED}: <what you need>`,
    "",
    "If the goal is already met, reply with exactly this line and nothing else:",
    GOAL_MET,
  );
  return lines.join("\n");
}

export function goalIsMet(text: string): boolean {
  return lastLine(text) === GOAL_MET;
}

function lastLine(text: string): string | undefined {
  return text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
}

/**
 * The blocked report in a reply, when its last line is the marker.
 *
 * The marker alone still means blocked; the reason after the colon is what
 * the reader needs to unstick it, so the continuation prompt demands one.
 */
export function goalBlockedReason(text: string): { reason?: string } | undefined {
  const line = lastLine(text);
  if (!line) return undefined;
  if (line === GOAL_BLOCKED) return {};
  if (!line.startsWith(`${GOAL_BLOCKED}:`) && !line.startsWith(`${GOAL_BLOCKED} `)) return undefined;
  const reason = line.slice(GOAL_BLOCKED.length).replace(/^[: ]+\s*/, "").trim();
  return reason ? { reason } : {};
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
 * A GOAL BLOCKED reply blocks the goal only when it was written after the goal
 * was saved — the same guard as {@link goalMetByReply}, because an older
 * report belongs to the previous run.
 */
export function goalBlockedByReply(input: {
  goal?: string;
  blocked?: boolean;
  goalSeq?: number;
  reply?: { text: string; seq?: number };
}): { reason?: string } | undefined {
  if (!input.goal || input.blocked || !input.reply) return undefined;
  const hit = goalBlockedReason(input.reply.text);
  if (!hit) return undefined;
  if (input.goalSeq !== undefined) {
    if (input.reply.seq === undefined || input.reply.seq <= input.goalSeq) return undefined;
  }
  return hit;
}

/**
 * Whether a session runs unattended: nobody is expected to answer its
 * questions in time.
 *
 * An active goal makes its own rounds autonomous. A turn a schedule sent is
 * unattended — whether the schedule spawned the session or fired into one
 * the reader already had. Its prompt is the engine's own `[scheduled:` text,
 * so the transcript itself is the provenance record and a restart or a
 * rename does not lose it. Once the reader types again the latest turn is
 * theirs, and so are its questions; a met, paused, or blocked goal is back
 * in their hands the same way.
 */
export function sessionAutonomous(
  view: Pick<SessionView, "goal" | "goal_met" | "goal_paused" | "goal_blocked" | "turns">,
): boolean {
  if (view.goal && !view.goal_met && !view.goal_paused && !view.goal_blocked) return true;
  for (let i = view.turns.length - 1; i >= 0; i--) {
    const text = view.turns[i]!.user
      ?.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text) return text.startsWith("[scheduled:");
  }
  return false;
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
  /** Recorded on the goal itself; the model asked for the reader, so the loop stops. */
  blocked?: boolean;
}): boolean {
  if (!input.goal || input.met || input.held || input.blocked) return false;
  if (input.busy || input.paused || input.kicked || input.pending) return false;
  if (input.deleted || input.archived) return false;
  if (input.status !== "active") return false;
  return true;
}
