import { t } from "./i18n";
import type { MessageKey } from "./locales/zh";

/**
 * What the shell knows about the OpenCode binary, as it stores it.
 *
 * `error` is a code, then an optional detail after a colon — see
 * `RuntimeError::to_stored` in `embed.rs`. It used to be English prose built in
 * Rust, which meant a translated screen carried one English sentence the reader
 * could do nothing with. The code says what happened; this module says how to
 * say it, in the reader's language.
 */
const PREFIX = "settings.opencode.err.";

/** A stored code, split into the part that names it and the part that fills it in. */
export function parseRuntimeError(stored: string | undefined): {
  code: string;
  detail: string;
} | undefined {
  if (!stored) return undefined;
  const at = stored.indexOf(":");
  if (at < 0) return { code: stored, detail: "" };
  return { code: stored.slice(0, at), detail: stored.slice(at + 1) };
}

/**
 * The reader-facing sentence for a stored error.
 *
 * An unknown code falls back to the stored text verbatim: a newer shell talking
 * to an older page is a real combination, and a code this build does not know
 * is still more useful than nothing. A known code with no locale entry returns
 * the key, which is visible and greppable rather than blank.
 */
export function runtimeErrorText(stored: string | undefined): string | undefined {
  const parsed = parseRuntimeError(stored);
  if (!parsed) return undefined;
  const key = `${PREFIX}${parsed.code}` as MessageKey;
  const text = t(key, { detail: parsed.detail, seconds: parsed.detail });
  // `t` returns the key itself when a string is missing, which is exactly the
  // signal that this build has no sentence for a code a newer shell wrote.
  if (text === key) return stored;
  return text;
}
