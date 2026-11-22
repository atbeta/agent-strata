import { describe, expect, test } from "bun:test";
import { manifest } from "../src/index";
import { GUIDANCE } from "../src/guidance";

describe("execution tool guidance", () => {
  test("dev tools name their non-interactive boundary and PTY alternative", () => {
    const start = manifest.tools.find((tool) => tool.name === "start")!;
    expect(start.description).toContain("non-interactive long-running");
    expect(start.description).toContain("terminal_create");
    const logs = manifest.tools.find((tool) => tool.name === "logs")!;
    expect(logs.description).toContain("terminal_read");
  });

  test("the system prompt gives the model a three-way choice and id mapping", () => {
    expect(GUIDANCE).toContain("regular shell");
    expect(GUIDANCE).toContain("dev_start");
    expect(GUIDANCE).toContain("terminal_create");
    expect(GUIDANCE).toContain("process_id");
    expect(GUIDANCE).toContain("terminal_id");
    expect(GUIDANCE).toContain("output_idle");
    expect(GUIDANCE).toContain("submit:true");
    expect(GUIDANCE).toContain("newest next_offset");
    expect(GUIDANCE).toMatch(/neither\s+means the command finished/);
    expect(GUIDANCE).toContain("echo EXIT=$?");
    expect(GUIDANCE).toContain("top -b -n1");
    expect(GUIDANCE).toContain("=== STATUS ===");
    expect(GUIDANCE).toContain("30000");
  });

  test("the system prompt names the detach habit and stays shorter than a tool manual", () => {
    expect(GUIDANCE).toContain("Start-Process");
    expect(GUIDANCE).toContain("nohup");
    expect(GUIDANCE).toContain("already served");
    expect(GUIDANCE).toContain("marked lost");
    expect(GUIDANCE).toContain("shell is not running");
    expect(GUIDANCE).toContain("Development or test credentials");
    expect(GUIDANCE).toContain("real or production passwords");
    // Port, workdir, `$`, and restart stay on the tool descriptions.
    expect(GUIDANCE).not.toContain("Set-Location");
    expect(GUIDANCE).not.toContain("$true");
    expect(GUIDANCE.trim().length).toBeLessThan(1800);
  });
});
