import { describe, expect, test } from "bun:test";
import { shellArgv } from "../src/shells";
import type { PtyShell } from "../src/types";

const shell = (name: string): PtyShell => ({ name, path: `/bin/${name}`, acceptable: true });

describe("agent and user shell profiles", () => {
  test("agent-created interactive shells skip user configuration", () => {
    expect(shellArgv(shell("zsh"), undefined, "darwin", { profile: false })).toEqual(["/bin/zsh", "-f"]);
    expect(shellArgv(shell("bash"), undefined, "linux", { profile: false })).toEqual([
      "/bin/bash",
      "--noprofile",
      "--norc",
    ]);
    expect(shellArgv(shell("fish"), undefined, "linux", { profile: false })).toEqual(["/bin/fish", "--no-config"]);
  });

  test("panel-created shells keep the user's normal profile", () => {
    expect(shellArgv(shell("zsh"), undefined, "darwin", { profile: true })).toEqual(["/bin/zsh"]);
    expect(shellArgv(shell("zsh"))).toEqual(["/bin/zsh"]);
  });

  test("command execution keeps shell -c semantics", () => {
    expect(shellArgv(shell("zsh"), "printf ok", "darwin", { profile: false })).toEqual([
      "/bin/zsh",
      "-f",
      "-c",
      "printf ok",
    ]);
    expect(shellArgv(shell("bash"), "printf ok", "linux", { profile: false })).toEqual([
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      "printf ok",
    ]);
    expect(shellArgv(shell("pwsh"), undefined, "win32", { profile: false })).toEqual([
      "/bin/pwsh",
      "-NoLogo",
      "-NoProfile",
    ]);
  });
});
