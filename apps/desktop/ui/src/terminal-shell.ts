import type { PtyShell } from "./api";

/**
 * Which shell a new terminal opens with.
 *
 * The stored value is a name, never a path. The backend owns the list of shells
 * it will accept and resolves the name to an executable itself, so a preference
 * saved here cannot outlive its meaning by pointing somewhere new.
 *
 * A name the backend has stopped offering is not an error worth raising on every
 * spawn: the terminal still opens, on the backend's own default, and the reader
 * is told once. A preference that silently stops applying is worse than one that
 * reports itself, and one that blocks the terminal outright is worse still.
 */

export const TERMINAL_SHELL_KEY = "strata.terminal-shell";

const WARNED_KEY = "strata.terminal-shell-warned";

export interface ShellStorage extends Pick<Storage, "getItem" | "setItem" | "removeItem"> {}

export function readTerminalShell(storage: ShellStorage = localStorage): string {
  try {
    return storage.getItem(TERMINAL_SHELL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeTerminalShell(name: string, storage: ShellStorage = localStorage): void {
  try {
    if (name) storage.setItem(TERMINAL_SHELL_KEY, name);
    else storage.removeItem(TERMINAL_SHELL_KEY);
  } catch {
    // A window with storage disabled still gets a working default.
  }
}

/**
 * The shells this reader may ask for. The backend marks a shell un-acceptable for
 * reasons it does not always explain — a login shell it will not broker, a binary
 * it found but will not run — so the mark is the whole test, not a hint.
 */
export function shellChoices(shells: readonly PtyShell[]): PtyShell[] {
  return shells.filter((s) => s.acceptable && s.path.length > 0 && s.name.length > 0);
}

export function isShellAvailable(name: string, shells: readonly PtyShell[]): boolean {
  return shellChoices(shells).some((s) => s.name === name);
}

/** What to actually send, given what the reader chose and what the backend has. */
export function resolveShell(
  stored: string,
  shells: readonly PtyShell[],
): { shell: string | undefined; fellBack: boolean } {
  if (!stored) return { shell: undefined, fellBack: false };
  if (isShellAvailable(stored, shells)) return { shell: stored, fellBack: false };
  return { shell: undefined, fellBack: true };
}

/**
 * Once per preference value rather than once per session: a reader who chose
 * pwsh and then uninstalled it hears about it once, and again if they go
 * looking for a shell that is also gone. Storing the name rather than a flag
 * keeps this to one key and still re-warns for a different shell.
 */
export function shouldWarnFallback(stored: string, warned: string): boolean {
  return stored.length > 0 && stored !== warned;
}

export function readWarnedShell(storage: ShellStorage = localStorage): string {
  try {
    return storage.getItem(WARNED_KEY) ?? "";
  } catch {
    return "";
  }
}

export function markShellWarned(name: string, storage: ShellStorage = localStorage): void {
  try {
    storage.setItem(WARNED_KEY, name);
  } catch {
    // Warning every session beats never warning at all.
  }
}
