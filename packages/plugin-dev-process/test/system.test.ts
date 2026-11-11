import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManager } from "../src/manager";
import { parseProcessStart, type Clock, type DevChild, type PortProbe, type System } from "../src/system";
import { insideWorkspace } from "../src/workspace";

function emptyOutput(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() });
}

describe("system boundaries", () => {
  test("parses the POSIX process clock as UTC", () => {
    expect(parseProcessStart("Sun Oct 25 16:22:14 2026")).toBe(Date.UTC(2026, 9, 25, 16, 22, 14));
    expect(parseProcessStart("not a process date")).toBeUndefined();
  });

  test("drives entry lifecycle through System, PortProbe and Clock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-system-"));
    let now = 1000;
    let killed = false;
    const spawnCalls: { command: string; cwd: string }[] = [];
    const treeKills: number[] = [];
    const ports: PortProbe = {
      accepts: async () => !killed,
      holders: async () => [],
    };
    const child = {
      pid: 4242,
      stdout: emptyOutput(),
      stderr: emptyOutput(),
      exited: new Promise<number>(() => {}),
      kill: () => {
        killed = true;
      },
    } as unknown as DevChild;
    const system: System = {
      ports,
      commandShell: () => "test-shell",
      spawn: (command, cwd) => {
        spawnCalls.push({ command, cwd });
        return child;
      },
      alive: () => !killed,
      killTree: (pid) => {
        killed = true;
        treeKills.push(pid);
      },
      processStartedAt: () => undefined,
    };
    const clock: Clock = {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    };
    try {
      const dev = createManager({}, system, clock);
      const started = await dev.start({ session_id: "s", command: "serve", cwd: dir, port: 8080 });
      expect(started.shell).toBe("test-shell");
      expect(started.ready).toBe("yes");
      expect(started.ready_ms).toBe(0);
      expect(spawnCalls).toEqual([{ command: "serve", cwd: dir }]);
      const stopped = await dev.stop(started.id);
      expect(stopped).toEqual({ stopped: true, clean: true, residual: [], port: 8080, port_free: true });
      expect(treeKills).toEqual([4242]);
      expect(dev.get(started.id)?.state).toBe("stopped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workspace lexical checks", () => {
  test("accepts descendants but not a sibling with the same prefix", () => {
    expect(insideWorkspace("/tmp/work", "/tmp/work")).toBe(true);
    expect(insideWorkspace("/tmp/work", "/tmp/work/web")).toBe(true);
    expect(insideWorkspace("/tmp/work", "/tmp/work-other")).toBe(false);
    expect(insideWorkspace("/tmp/work", "/tmp/work/../outside")).toBe(false);
  });
});
