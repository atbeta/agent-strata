import { t } from "./i18n";
import { isGeneratedTitle } from "./pane-session-picker";

/**
 * The name a session wears on screen.
 *
 * The backend stamps a session that was never titled
 * `New session - 2026-10-14T14:48:58.578Z` — a UTC timestamp in ISO, which in
 * a sidebar row is twelve sessions named the same thing. What the reader
 * actually uses it for is "the one I opened at half past", so the date is
 * parsed out and rendered as local `MM-DD HH:mm`; the rest of the name — and
 * any session with a real title — passes through untouched. Detection stays
 * with `isGeneratedTitle` so the picker's sort and this label never disagree
 * about which titles are generated.
 */
export function displayTitle(raw: string | null | undefined): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  if (!isGeneratedTitle(raw)) return raw;
  const iso = raw.slice(raw.indexOf("-") + 1).trim();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return t("session.generated", { when });
}
