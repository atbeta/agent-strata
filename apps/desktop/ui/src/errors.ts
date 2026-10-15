import { t } from "./i18n";

/** The browser's fetch failure is "Load failed" — say what is actually unreachable. */
export function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "Load failed" || msg === "Failed to fetch") return t("error.serviceUnreachable");
  return msg;
}
