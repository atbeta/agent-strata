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
    expect(GUIDANCE).toContain("does not\nmean the command finished");
  });
});
