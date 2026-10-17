import { describe, expect, test } from "bun:test";
import {
  isShellAvailable,
  markShellWarned,
  readTerminalShell,
  readWarnedShell,
  resolveShell,
  shellChoices,
  shouldWarnFallback,
  writeTerminalShell,
  type ShellStorage,
} from "./terminal-shell";
import type { PtyShell } from "./api";

function memStorage(seed: Record<string, string> = {}): ShellStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const shell = (name: string, acceptable = true, path = `/bin/${name}`): PtyShell => ({ name, path, acceptable });

describe("the stored default shell", () => {
  test("is a name, and it survives a round trip", () => {
    const storage = memStorage();
    expect(readTerminalShell(storage)).toBe("");
    writeTerminalShell("pwsh", storage);
    expect(readTerminalShell(storage)).toBe("pwsh");
  });

  test("going back to the backend default removes the key rather than storing empty", () => {
    const storage = memStorage();
    writeTerminalShell("pwsh", storage);
    writeTerminalShell("", storage);
    expect(storage.data.size).toBe(0);
    expect(readTerminalShell(storage)).toBe("");
  });

  test("a window with storage disabled still gets a working default", () => {
    const broken: ShellStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(readTerminalShell(broken)).toBe("");
    expect(() => writeTerminalShell("pwsh", broken)).not.toThrow();
  });
});

describe("what the backend will run", () => {
  test("is the acceptable list, not the whole of PATH", () => {
    const listed = [shell("pwsh"), shell("cmd"), shell("weird", false)];
    expect(shellChoices(listed).map((s) => s.name)).toEqual(["pwsh", "cmd"]);
    expect(isShellAvailable("pwsh", listed)).toBe(true);
    expect(isShellAvailable("weird", listed)).toBe(false);
  });

  test("a shell with no path behind its name is not a choice", () => {
    // opencode can name something it will not hand back an executable for.
    const listed = [shell("pwsh", true, "")];
    expect(shellChoices(listed)).toEqual([]);
    expect(isShellAvailable("pwsh", listed)).toBe(false);
  });

  test("no preference means nothing is sent, and nothing is a fallback", () => {
    expect(resolveShell("", [shell("pwsh")])).toEqual({ shell: undefined, fellBack: false });
  });

  test("a preference the backend offers is sent by name", () => {
    expect(resolveShell("pwsh", [shell("pwsh"), shell("cmd")])).toEqual({
      shell: "pwsh",
      fellBack: false,
    });
  });

  test("a preference the backend dropped falls back and says so", () => {
    expect(resolveShell("pwsh", [shell("cmd")])).toEqual({ shell: undefined, fellBack: true });
    expect(resolveShell("pwsh", [shell("pwsh", false)])).toEqual({ shell: undefined, fellBack: true });
  });
});

describe("the one-time notice", () => {
  test("fires once per preference value, not once per session", () => {
    expect(shouldWarnFallback("pwsh", "")).toBe(true);
    expect(shouldWarnFallback("pwsh", "pwsh")).toBe(false);
    // Back to no preference there is nothing to be alarmed about.
    expect(shouldWarnFallback("", "")).toBe(false);
    // A different missing shell is news again.
    expect(shouldWarnFallback("cmd", "pwsh")).toBe(true);
  });

  test("remembers which shell it already reported", () => {
    const storage = memStorage();
    expect(readWarnedShell(storage)).toBe("");
    markShellWarned("pwsh", storage);
    expect(readWarnedShell(storage)).toBe("pwsh");
    expect(shouldWarnFallback("pwsh", readWarnedShell(storage))).toBe(false);
  });
});
