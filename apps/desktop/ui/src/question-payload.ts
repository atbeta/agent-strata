import type { PendingQuestion } from "./api";

type Group = PendingQuestion["questions"][number];

/**
 * `/questions` is read through a blind cast, so its shape is whatever the
 * service happened to send that minute. `QuestionCard` used to map
 * `q.questions` while setting up: an entry missing the field threw *there* —
 * during setup, before the dock could draw an error bar or anything else — and
 * took the whole prompt region with it. The agent keeps holding its turn
 * waiting on an answer nobody can see, so the session reads as running and
 * blank rather than broken, which is the worst shape this failure can take.
 *
 * Normalising at the edge turns that crash into an empty list the caller can
 * render as "this one could not be read", still dismissible so it cannot pin
 * the dock open.
 *
 * Individual groups are left alone past an object check: their `options` list
 * is read through `<For>`, which renders nothing for a non-array rather than
 * throwing, and a malformed option should cost that one question its choices,
 * not the whole card.
 */
export function questionGroups(questions: unknown): Group[] {
  if (!Array.isArray(questions)) return [];
  return questions.filter((g): g is Group => !!g && typeof g === "object");
}

/**
 * `custom` means "allow typing a custom answer" and upstream documents it as
 * defaulting to *true*: only an explicit `false` closes the question to free
 * text. The card read the field truthily, so every prompt that left it out —
 * which is what the backend sends today — silently lost its input.
 */
export function questionAllowsCustom(question: Group): boolean {
  return question.custom !== false;
}
