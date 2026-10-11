import { createSignal } from "solid-js";
import { shellPlatform } from "./shell";

/** A shortcut that always includes Ctrl (or ⌘ on a Mac). Plain keys stay with the focused control. */
export interface Chord {
  /** `key` value, compared case-insensitively. "`" matches the Backquote key. */
  key: string;
  shift?: boolean;
  alt?: boolean;
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
  if (e.repeat) return false;
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
