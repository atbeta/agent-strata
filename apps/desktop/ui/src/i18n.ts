import { createSignal } from "solid-js";
import { en } from "./locales/en";
import { zh, type MessageKey, type PluralKey } from "./locales/zh";

/**
 * Two languages, one shell.
 *
 * Chinese is the default because that is the language this window was built
 * in; English is the fallback for anything the backend or a browser hands us.
 * What this module deliberately does not do is translate data. Session titles,
 * model names, tool names, file paths and event payloads all arrive from the
 * backends and are shown verbatim — a translated model id is a broken model id.
 * Only the chrome around them is ours to translate.
 *
 * The two dictionaries cannot drift because `en` is typed against the key set
 * of `zh`: adding a string to one and forgetting the other is a compile error,
 * not a gap a reader finds. That matters here more than usual, because a missing
 * key would otherwise fall through to the raw key and render as `session.empty`
 * in the middle of the interface.
 */

export type Locale = "zh" | "en";

export const LOCALES: readonly Locale[] = ["zh", "en"] as const;

export const LOCALE_KEY = "strata.locale";

export const LOCALE_LABEL: Record<Locale, string> = {
  zh: "中文",
  en: "English",
};

/** BCP 47 tag for Intl and for `lang`. */
export const LOCALE_TAG: Record<Locale, string> = {
  zh: "zh-Hans",
  en: "en",
};

/**
 * Numbers and dates. Every format in this app used to be locale-less, which
 * meant a Chinese reader got an American `1,234` grouping and a `10/6` date
 * regardless of what the window was set to.
 */
export function num(n: number): string {
  return n.toLocaleString(current());
}

export function date(n: number | Date): string {
  return new Date(n).toLocaleDateString(LOCALE_TAG[current()], {
    month: "numeric",
    day: "numeric",
  });
}

/**
 * A moment, not just a day. Kept separate from `date` because an event
 * timestamp that loses its time-of-day is a different answer, not a shorter
 * one — and the seconds stay because the old locale-less `toLocaleString()`
 * showed them and dropping them would be a silent behaviour change.
 */
export function stamp(d: number | Date | string): string {
  return new Date(d).toLocaleString(LOCALE_TAG[current()], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function readStored(): Locale {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    if (v === "zh" || v === "en") return v;
  } catch {
    // Private mode can reject storage; fall back to the default like theme.ts does.
  }
  return "zh";
}

const [current, setCurrent] = createSignal<Locale>(readStored());

/** The active locale. Reading this inside a render pass subscribes to it. */
export const locale = current;

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { zh, en };

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  // Falling back to the key rather than to empty text: a missing string should
  // be visible and greppable, not leave a blank where a label belongs.
  const table = DICTIONARIES[current()] as Record<string, string>;
  const text = table[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/**
 * A counted thing. English distinguishes one from many and Chinese does not,
 * so the two shapes are separate keys rather than a rule: a plural engine
 * would be more machinery than this app needs for "1 file / 9 files".
 *
 *   tn("session.files", 9)  ->  "9 files"  /  "9 个文件"
 */
export function tn(key: PluralKey, n: number, vars?: Record<string, string | number>): string {
  const suffix = n === 1 ? "one" : "other";
  return t(`${key}.${suffix}` as MessageKey, { n, ...vars });
}

export function setLocale(next: Locale): void {
  if (next === current()) return;
  try {
    localStorage.setItem(LOCALE_KEY, next);
  } catch {
    // A session that cannot remember the choice still gets the new language.
  }
  setCurrent(next);
  applyLangTag(next);
};

/**
 * Screen readers pick a voice from `lang`, and the browser picks a CJK font
 * from it too. Leaving it as "en" while showing Chinese mispronounces the lot.
 *
 * Guarded because this module is imported by format helpers that the unit tests
 * import, and `bun test` has no DOM — a bare `document` here would make every
 * test that touches a string throw before it could assert anything.
 */
function applyLangTag(next: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = LOCALE_TAG[next];
}

applyLangTag(current());