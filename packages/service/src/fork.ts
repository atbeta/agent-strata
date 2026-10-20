import type { SessionView } from "@agent-strata/projector";

/**
 * The message a backend forks before. A backend copies only what precedes the
 * id it is given, so keeping a message means naming the one after it; with
 * nothing after it the whole session goes, minus any turns a revert undid.
 * `null` means the id names no message in the session.
 */
export function forkBefore(
  view: Pick<SessionView, "turns">,
  messageId: string | undefined,
  through: boolean,
): { before: string | undefined } | null {
  const ids: string[] = [];
  let undone: string | undefined;
  for (const turn of view.turns) {
    if (turn.reverted) {
      undone = turn.turn_id;
      break;
    }
    ids.push(turn.turn_id);
    for (const a of turn.assistant) if (a.msg_id && !ids.includes(a.msg_id)) ids.push(a.msg_id);
  }
  if (messageId === undefined) return { before: undone };
  const at = ids.indexOf(messageId);
  if (at < 0) return null;
  if (!through) return { before: messageId };
  return { before: ids[at + 1] ?? undone };
}

/** `title (fork #N)`, numbered past every fork of the same title already taken. */
export function forkTitle(source: string, taken: Iterable<string | null>): string {
  const base = source.replace(/ \(fork #\d+\)$/, "");
  let n = 0;
  for (const title of taken) {
    const m = title?.startsWith(base) ? title.slice(base.length).match(/^ \(fork #(\d+)\)$/) : null;
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `${base} (fork #${n + 1})`;
}
