import { describe, expect, test } from "bun:test";
import { setLocale } from "./i18n";
import { terminalDetail } from "./terminal-summary";

describe("terminal capsule detail", () => {
  test("a plain shell says who can use it and which folder it is in", () => {
    setLocale("zh");
    expect(terminalDetail({
      title: "终端 1",
      command: "/bin/zsh",
      cwd: "/work/agent-strata",
      mode: "user",
    })).toBe("终端 1 · 仅自己 · agent-strata");
  });

  test("a command that is not the shell is named, and a shared one says so", () => {
    setLocale("zh");
    expect(terminalDetail({
      title: "终端 2",
      command: "ssh prod",
      cwd: "/work/agent-strata",
      mode: "shared",
    })).toBe("终端 2 · 与 Agent 共享 · ssh prod · agent-strata");
  });

  test("a title that already is the command is not repeated", () => {
    setLocale("en");
    expect(terminalDetail({
      title: "ssh prod",
      command: "ssh prod",
      cwd: "/work/agent-strata",
      mode: "shared",
    })).toBe("ssh prod · Shared with the agent · agent-strata");
  });
});
