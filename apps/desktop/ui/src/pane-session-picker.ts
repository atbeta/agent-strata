import { realWorkspace } from "./api";
import type { SessionRowSummary } from "./pane-stage";

/**
 * Which sessions a pane's session switcher offers, and in what order.
 *
 * This started as `props.sessions.slice(0, 30)`. That was a performance guard
 * and it worked — the node count is the same whether you have thirty sessions
 * or three thousand — but it silently amputated the list with nothing on
 * screen saying so. A picker that shows you the first thirty of three thousand
 * is not a picker; it is a scrollback of the most recent ones, and the session
 * you were reaching for may simply not be in it.
 *
 * So the cap stays, and the ordering earns its place in it.
 *
 * ## What counts as titled
 *
 * The backend names a session that was never given a title after the moment it
 * was created: `New session - 2026-10-14T14:48:58.578Z`. Those rows are real
 * sessions and must stay selectable — they are often the ones you just made and
 * have not typed into yet. But they are also near-duplicates of one another,
 * and a column of a dozen of them is indistinguishable at a glance. So they
 * sort to the back of the unfiltered list instead of filling the front of it.
 *
 * The distinction is deliberately narrow: a session is treated as untitled only
 * when it has no title of its own *and* its name is the backend's generated
 * one. A session a human is looking at and has not renamed yet keeps its place.
 */
export function isGeneratedTitle(title: string): boolean {
  return /^new session\s*-\s*\d{4}-\d{2}-\d{2}t/i.test(title.trim());
}

/** The name shown in the list, matching what `PaneHeader` puts on the trigger. */
export function pickerLabel(s: SessionRowSummary, untitled: string): string {
  return s.title || s.summary.title || untitled;
}

/**
 * The rows the picker renders: filtered by `query`, ordered so the ones a person
 * can recognise come first, and cut to `limit`.
 *
 * The cut is applied last, after filtering. Cutting first — which is what the
 * old `slice(0, 30)` did — is what made a search useless even once one existed:
 * the thirty it kept were chosen from the whole library, so a title you typed
 * could sit at position forty and never appear however well you spelled it.
 */
export function pickPaneSessions(
  sessions: readonly SessionRowSummary[],
  query: string,
  limit: number,
  untitled: string,
): SessionRowSummary[] {
  const q = query.trim().toLowerCase();
  const label = (s: SessionRowSummary) =>
    pickerLabel(s, untitled).toLowerCase();
  const workspace = (s: SessionRowSummary) =>
    (realWorkspace(s.workspace ?? s.summary.workspace) ?? "").toLowerCase();

  // Same two fields the global search matches on — title and workspace. A
  // session you can only find by remembering which project it was in is not
  // findable here.
  const matched = q
    ? sessions.filter((s) => label(s).includes(q) || workspace(s).includes(q))
    : sessions.slice();

  // The test data that pinned the first version of this got it backwards, and
  // that was the point of writing it: the check was `!s.title &&
  // !s.summary.title`, on the theory that an unnamed session has no title
  // field. The backend always sends one — it is the generated name. So the
  // condition was false for every row the app will ever see, and the ordering
  // silently did nothing while looking like it worked.
  //
  // What actually marks one of these is the name itself, not a missing field.
  const generated = (s: SessionRowSummary) => isGeneratedTitle(pickerLabel(s, untitled));

  // Stable within each group: a session keeps its place in the library, so the
  // list does not reshuffle under the pointer while you read it.
  const named = matched.filter((s) => !generated(s));
  const anonymous = matched.filter(generated);

  return [...named, ...anonymous].slice(0, limit);
}

/**
 * True when the cap actually hid something, so the list can say so.
 *
 * Without this the picker is indistinguishable from one holding everything:
 * you cannot tell whether you have seen the whole library or only its head.
 */
export function pickerTruncated(
  sessions: readonly SessionRowSummary[],
  query: string,
  limit: number,
  untitled: string,
): boolean {
  const q = query.trim().toLowerCase();
  const matches = (s: SessionRowSummary) => {
    if (!q) return true;
    return (
      pickerLabel(s, untitled).toLowerCase().includes(q) ||
      (realWorkspace(s.workspace ?? s.summary.workspace) ?? "")
        .toLowerCase()
        .includes(q)
    );
  };
  let seen = 0;
  for (const s of sessions) {
    if (!matches(s)) continue;
    seen += 1;
    if (seen > limit) return true;
  }
  return false;
}
