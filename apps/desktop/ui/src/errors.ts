import { createSignal } from "solid-js";
import { t } from "./i18n";

/** The browser's fetch failure is "Load failed" — say what is actually unreachable. */
export function explain(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "Load failed" || msg === "Failed to fetch") return t("error.serviceUnreachable");
  return msg;
}

/**
 * How long a one-line action result stays on screen.
 *
 * Long enough to read twice, short enough that it cannot outlive the thing it
 * reports on — an error that never leaves is how "broken" starts meaning
 * "happened once, a while ago".
 */
const FADE_MS = 10_000;

/**
 * A single action's result line — an error or a quiet confirmation.
 *
 * News, not a status: it answers for {@link FADE_MS} and steps aside on its
 * own, and the next attempt replaces it or clears it early. Every button that
 * can fail gets the same line and the same goodbye.
 *
 * Not for problems that persist: a load that failed, a value still invalid, a
 * backend still down are states, and a state stays until it heals — putting
 * one here would hide the problem, not report it.
 */
export function fadeSignal<T>(empty: T, ms = FADE_MS): [get: () => T, set: (v: T) => void] {
  const [value, setValue] = createSignal<T>(empty);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = (v: T) => {
    clearTimeout(timer);
    setValue(() => v);
    timer = v === empty ? undefined : setTimeout(() => setValue(() => empty), ms);
  };
  return [value, set];
}

/**
 * The same line, one per element — a list of rows keeps each row's failure
 * under that row rather than collapsing them into a single global slot. An
 * empty text clears the key, same as passing the empty value to
 * {@link fadeSignal}.
 */
export function fadeKeyed(ms = FADE_MS): [
  get: () => Record<string, string>,
  set: (key: string, text: string) => void,
] {
  const [map, setMap] = createSignal<Record<string, string>>({});
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const clear = (key: string) => {
    setMap((m) => {
      if (!(key in m)) return m;
      const next = { ...m };
      delete next[key];
      return next;
    });
  };
  const set = (key: string, text: string) => {
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (!text) {
      clear(key);
      return;
    }
    setMap((m) => ({ ...m, [key]: text }));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        clear(key);
      }, ms),
    );
  };
  return [map, set];
}
