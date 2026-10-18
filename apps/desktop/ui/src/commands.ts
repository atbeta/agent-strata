import { createSignal } from "solid-js";
import { shellPlatform } from "./shell";

/** A shortcut that always includes Ctrl (or ⌘ on a Mac). Plain keys stay with the focused control. */
export interface Chord {
  /** `key` value, compared case-insensitively. "`" matches the Backquote key. */
  key: string;
  shift?: boolean;
  alt?: boolean;
  /** Held keys repeat. Other chords fire once. */
  repeat?: boolean;
}

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
}

/** Where a command sits in the palette. Derived from the id, never written. */
export type CommandGroup = "app" | "session" | "pane";

export interface AppCommand {
  id: string;
  title: () => string;
  chord?: Chord;
  /** omitted means the command is shown and its shortcut is live */
  enabled?: () => boolean;
  /** omitted means the command appears in the palette */
  listed?: boolean;
  run: () => void;
}

/**
 * The group a command belongs to, read off its id.
 *
 * Every command has always been registered as `app.something`,
 * `session.something` or `pane.something`, so the grouping was already there —
 * written into every id and read by nobody. A palette that lists "switch
 * session" above "split pane" above "new session" with no order is a wall to
 * read, and the reader has to already know the app to know where to look.
 *
 * Derived rather than declared, because a declared group is one more thing to
 * remember at every registration and the one place it could be wrong is a new
 * command whose group was simply not filled in.
 */
export function commandGroup(cmd: AppCommand): CommandGroup | undefined {
  const prefix = cmd.id.split(".")[0];
  return prefix === "app" || prefix === "session" || prefix === "pane" ? prefix : undefined;
}

/** Group order in the palette: what the window is, then the session, then the panes. */
export const GROUP_ORDER: readonly CommandGroup[] = ["app", "session", "pane"];

const registry = new Map<string, AppCommand>();
const [revision, setRevision] = createSignal(0);

export function registerCommand(cmd: AppCommand): () => void {
  registry.set(cmd.id, cmd);
  setRevision((n) => n + 1);
  return () => {
    if (registry.get(cmd.id) === cmd) {
      registry.delete(cmd.id);
      setRevision((n) => n + 1);
    }
  };
}

export function commandList(): AppCommand[] {
  revision();
  return [...registry.values()].filter((cmd) => cmd.listed !== false && (!cmd.enabled || cmd.enabled()));
}

export function chordPressed(e: KeyLike, chord: Chord): boolean {
  if (e.repeat && !chord.repeat) return false;
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (e.altKey !== (chord.alt === true)) return false;
  if (e.shiftKey !== (chord.shift === true)) return false;
  if (chord.key === "`") return e.code === "Backquote";
  return e.key.toLowerCase() === chord.key.toLowerCase();
}

export function commandForChord(e: KeyLike): AppCommand | undefined {
  for (const cmd of registry.values()) {
    if (!cmd.chord || (cmd.enabled && !cmd.enabled())) continue;
    if (chordPressed(e, cmd.chord)) return cmd;
  }
  return undefined;
}

export function formatChord(chord: Chord): string {
  const mac = shellPlatform() === "macos" || (typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent) && shellPlatform() !== "windows" && shellPlatform() !== "linux");
  const key = chord.key === "`" ? "`" : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
  if (mac) return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}⌘${key}`;
  const parts = ["Ctrl"];
  if (chord.shift) parts.push("Shift");
  if (chord.alt) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}
