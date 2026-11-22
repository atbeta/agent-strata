import { describe, expect, test } from "bun:test";
import { manifest } from "../src/index";

describe("terminal tool guidance", () => {
  test("create is only for interactive work, not a generic command runner", () => {
    const create = manifest.tools.find((tool) => tool.name === "create")!;
    expect(create.description).toContain("only when the program needs terminal input");
    expect(create.description).toContain("one-shot non-interactive");
    expect(create.description).toContain("dev_start");
  });

  test("read points dev process ids to dev_logs and does not claim command completion", () => {
    const read = manifest.tools.find((tool) => tool.name === "read")!;
    expect(read.description).toContain("dev_logs");
    expect(read.description).toContain("not a command-completion signal");
    expect(read.description).toContain("linear text stream, not a screen snapshot");
    expect(read.timeout_ms).toBe(45_000);
    const wait = read.input.properties as { wait_ms: { description: string } };
    expect(wait.wait_ms.description).toContain("30000");
  });

  test("write waits with an explicit reason and all tools stay inside shared terminals", () => {
    const write = manifest.tools.find((tool) => tool.name === "write")!;
    expect(write.description).toContain("wait_reason");
    expect(write.description).toContain("shared");
    expect(write.description).toContain("submit:true");
    expect(write.description).toContain("may trim");
    expect(write.timeout_ms).toBe(45_000);
    const signal = manifest.tools.find((tool) => tool.name === "signal")!;
    expect(signal.description).toContain("foreground process group");
    expect(signal.description).toContain("shell itself");
    const close = manifest.tools.find((tool) => tool.name === "close")!;
    expect(close.description).toContain("shared");
    expect(close.description).toContain("confirmed");
  });
});
