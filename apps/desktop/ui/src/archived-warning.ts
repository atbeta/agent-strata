import type { SessionData } from "./maintenance-api";
import { t } from "./i18n";

/**
 * What deleting one session takes, said before it takes it.
 *
 * The store's `local` figure is a count of event rows: every status tick,
 * and both halves of a permission or a question. One session routinely has
 * dozens of those, and putting that number in the sentence reads as "N
 * things will be deleted" when the person asked to delete one session.
 * The sentence is about that one session. The row tally stays on the
 * maintenance screen, where it is a row tally.
 */
export function archivedDeleteWarning(data: SessionData): string {
  if (!data.can_delete) return t("sidebar.archived.localOnly");
  return t("sidebar.archived.warning.noLocal");
}
