import type { SessionData } from "./maintenance-api";
import { t, tn } from "./i18n";

/**
 * What deleting an archived session takes, said before it takes it.
 *
 * Three cases, and the middle one is the one that used to read badly. A
 * session whose local rows are all rebuildable has nothing that only this
 * machine remembers, and saying so with a zero in it — "0 rows cannot be
 * rebuilt" — reads like something went wrong rather than like there is
 * nothing there to lose. The clause is dropped instead.
 *
 * The count is worth the rest of the sentence when it is not zero: those rows
 * are the permissions that were asked for, the questions that were put, the
 * state of the session, and no backend has them.
 */
export function archivedDeleteWarning(data: SessionData): string {
  if (!data.can_delete) return t("sidebar.archived.localOnly");
  if (data.local === 0) return t("sidebar.archived.warning.noLocal");
  return tn("sidebar.archived.warning", data.local);
}
