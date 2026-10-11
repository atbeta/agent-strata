import { afterEach, describe, expect, test } from "bun:test";
import { chordPressed, commandForChord, formatChord, registerCommand, type KeyLike } from "./commands";

function key(partial: Partial<KeyLike>): KeyLike {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...partial,
  };
}

describe("command chords", () => {
  const drop: (() => void)[] = [];
  afterEach(() => {
    for (const fn of drop) fn();
    drop.length = 0;
  });

  test("Ctrl+K is search and Ctrl+Shift+P is not", () => {
    expect(chordPressed(key({ key: "k", ctrlKey: true, code: "KeyK" }), { key: "k" })).toBe(true);
    expect(chordPressed(key({ key: "p", ctrlKey: true, shiftKey: true, code: "KeyP" }), { key: "k" })).toBe(false);
    expect(chordPressed(key({ key: "P", ctrlKey: true, shiftKey: true, code: "KeyP" }), { key: "p", shift: true })).toBe(true);
    expect(chordPressed(key({ key: "p", ctrlKey: true, code: "KeyP" }), { key: "p", shift: true })).toBe(false);
  });

  test("the terminal chord is the Backquote key without shift", () => {
    expect(chordPressed(key({ key: "`", code: "Backquote", ctrlKey: true }), { key: "`" })).toBe(true);
    expect(chordPressed(key({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }), { key: "`" })).toBe(false);
  });

  test("a held key does not repeat the command", () => {
    expect(chordPressed(key({ key: "k", ctrlKey: true, code: "KeyK", repeat: true }), { key: "k" })).toBe(false);
  });

  test("a disabled command keeps its shortcut quiet", () => {
    drop.push(
      registerCommand({
        id: "test.quiet",
        title: () => "quiet",
        chord: { key: "k" },
        enabled: () => false,
        run: () => {},
      }),
    );
    expect(commandForChord(key({ key: "k", ctrlKey: true, code: "KeyK" }))).toBeUndefined();
  });

  test("unregistering removes the command", () => {
    const unregister = registerCommand({
      id: "test.gone",
      title: () => "gone",
      chord: { key: "k" },
      run: () => {},
    });
    expect(commandForChord(key({ key: "k", ctrlKey: true, code: "KeyK" }))?.id).toBe("test.gone");
    unregister();
    expect(commandForChord(key({ key: "k", ctrlKey: true, code: "KeyK" }))).toBeUndefined();
  });

  test("a chord reads as Ctrl on this machine", () => {
    expect(formatChord({ key: "p", shift: true })).toBe("Ctrl+Shift+P");
    expect(formatChord({ key: "`" })).toBe("Ctrl+`");
  });
});
