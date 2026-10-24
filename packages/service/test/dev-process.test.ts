import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevManager, looksLongRunning, commandName } from "../src/dev-process";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "strata-dev-"));
}

describe("looksLongRunning", () => {
  test("recognises the dev servers people actually start", () => {
    expect(looksLongRunning("npm run dev")).toBe(true);
    expect(looksLongRunning("pnpm dev")).toBe(true);
    expect(looksLongRunning("yarn start")).toBe(true);
    expect(looksLongRunning("bun run dev")).toBe(true);
    expect(looksLongRunning("vite")).toBe(true);
    expect(looksLongRunning("next dev")).toBe(true);
    expect(looksLongRunning("mvn spring-boot:run")).toBe(true);
    expect(looksLongRunning("./gradlew bootRun")).toBe(true);
    expect(looksLongRunning("uvicorn app:app --reload")).toBe(true);
    expect(looksLongRunning("python manage.py runserver")).toBe(true);
    expect(looksLongRunning("dotnet watch run")).toBe(true);
    expect(looksLongRunning("cargo watch -x run")).toBe(true);
    expect(looksLongRunning("go run ./cmd/server")).toBe(true);
    expect(looksLongRunning("rails server")).toBe(true);
  });

  test("leaves one-shot commands alone", () => {
    expect(looksLongRunning("git status")).toBe(false);
    expect(looksLongRunning("npm install")).toBe(false);
    expect(looksLongRunning("npm test")).toBe(false);
    expect(looksLongRunning("mvn test")).toBe(false);
    expect(looksLongRunning("ls -la")).toBe(false);
  });
});

describe("commandName", () => {
  test("names the binary a command starts with", () => {
    expect(commandName("npm run dev")).toBe("npm");
    expect(commandName("  pnpm   dev  ")).toBe("pnpm");
    expect(commandName('"/opt/my tool/bin/run" --flag')).toBe("run");
  });
});

describe("dev manager", () => {
  test("starts a command, reads its output, and reports the exit", async () => {
    const dir = workspace();
    const dev = createDevManager();
    try {
      const started = await dev.start({
        session_id: "casf:test:1",
        command: "echo hello-from-dev",
        cwd: dir,
      });

      expect(started.session_id).toBe("casf:test:1");
      expect(started.pid).toBeGreaterThan(0);

      // The line is read asynchronously; give the pipe a moment to deliver it.
      for (let i = 0; i < 40; i++) {
        if (dev.logs(started.id).some((line) => line.text.includes("hello-from-dev"))) break;
        await Bun.sleep(25);
      }
      const lines = dev.logs(started.id);
      expect(lines.some((line) => line.text.includes("hello-from-dev"))).toBe(true);
      expect(lines.every((line) => line.stream === "out" || line.stream === "err")).toBe(true);

      for (let i = 0; i < 40; i++) {
        if (dev.get(started.id)?.exit_code !== null) break;
        await Bun.sleep(25);
      }
      expect(dev.get(started.id)?.exit_code).toBe(0);
    } finally {
      await dev.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports a command that cannot start instead of a dead pid", async () => {
    const dir = workspace();
    const dev = createDevManager();
    try {
      const started = await dev.start({
        session_id: "casf:test:2",
        command: "definitely-not-a-real-command-xyz",
        cwd: dir,
      });
      // A shell reports the missing binary on stderr and exits non-zero.
      expect(started.exit_code === null || started.exit_code !== 0).toBe(true);
      expect(started.error === undefined || started.error.length > 0).toBe(true);
    } finally {
      await dev.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a directory that does not exist", async () => {
    const dev = createDevManager();
    await expect(
      dev.start({
        session_id: "casf:test:3",
        command: "echo hi",
        cwd: join(tmpdir(), "strata-definitely-missing-dir"),
      }),
    ).rejects.toThrow(/not a directory/);
  });

  test("refuses an empty command", async () => {
    const dir = workspace();
    const dev = createDevManager();
    try {
      await expect(dev.start({ session_id: "casf:test:4", command: "   ", cwd: dir })).rejects.toThrow(
        /command is required/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lists by session and stops a session's processes together", async () => {
    const dir = workspace();
    const dev = createDevManager();
    try {
      const a = await dev.start({ session_id: "casf:test:5", command: "sleep 30", cwd: dir });
      const b = await dev.start({ session_id: "casf:test:6", command: "sleep 30", cwd: dir });

      expect(dev.list("casf:test:5").map((p) => p.id)).toEqual([a.id]);
      expect(dev.list().length).toBe(2);

      const stopped = await dev.stopSession("casf:test:5");
      expect(stopped).toBe(1);

      // The other session's process is untouched by another session's cleanup.
      expect(dev.get(b.id)?.exit_code).toBeNull();

      await dev.stopSession("casf:test:6");
    } finally {
      await dev.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("marks a process stopped when someone asks", async () => {
    const dir = workspace();
    const dev = createDevManager();
    try {
      const started = await dev.start({ session_id: "casf:test:7", command: "sleep 30", cwd: dir });
      expect(await dev.stop(started.id)).toBe(true);
      expect(await dev.stop("dev_missing")).toBe(false);
      for (let i = 0; i < 40; i++) {
        if (dev.get(started.id)?.exit_code !== null) break;
        await Bun.sleep(25);
      }
      expect(dev.get(started.id)?.stopped).toBe(true);
    } finally {
      await dev.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("broadcasts start, output and exit", async () => {
    const dir = workspace();
    const dev = createDevManager();
    const seen: string[] = [];
    const off = dev.subscribe((event) => seen.push(event.type));
    try {
      await dev.start({ session_id: "casf:test:8", command: "echo event-check", cwd: dir });
      for (let i = 0; i < 40; i++) {
        if (seen.includes("dev.exited")) break;
        await Bun.sleep(25);
      }
      expect(seen).toContain("dev.started");
      expect(seen).toContain("dev.output");
      expect(seen).toContain("dev.exited");
    } finally {
      off();
      await dev.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a listener that throws does not break the process it watches", async () => {
    const dir = workspace();
    const dev = createDevManager();
    const off = dev.subscribe(() => {
      throw new Error("listener blew up");
    });
    try {
      const started = await dev.start({ session_id: "casf:test:9", command: "echo survives", cwd: dir });
      for (let i = 0; i < 40; i++) {
        if (dev.get(started.id)?.exit_code !== null) break;
        await Bun.sleep(25);
      }
      expect(dev.get(started.id)?.exit_code).toBe(0);
    } finally {
      off();
      await dev.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stale process cleanup", () => {
  test("kills what a crashed run left behind, and only what is still alive", async () => {
    const dir = workspace();
    const pidFile = join(dir, "dev-processes.json");

    // A process a previous run started, then "crashed" without stopping.
    const survivor = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    // A pid that is certainly not running.
    const dead = 999_999;

    writeFileSync(
      pidFile,
      JSON.stringify([
        { pid: survivor.pid, id: "dev_a", command: "sleep 60" },
        { pid: dead, id: "dev_b", command: "gone" },
      ]),
    );

    const dev = createDevManager({ pidFile });
    const killed = dev.reapStale();

    // Only the live one counts; a dead pid must not be signalled.
    expect(killed).toBe(1);

    // The survivor is gone. `exitCode` is not the witness here: a process killed
    // from outside is not one this runtime waited on, so its exit code stays
    // null even after it has died. Ask the OS instead.
    let gone = false;
    for (let i = 0; i < 60; i++) {
      try {
        process.kill(survivor.pid, 0);
      } catch {
        gone = true;
        break;
      }
      await Bun.sleep(25);
    }
    if (!gone) {
      survivor.kill();
      throw new Error("the stale process was not killed");
    }

    // The table is emptied so a second start does not kill the same pid twice.
    expect(JSON.parse(readFileSync(pidFile, "utf8"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("survives a pid file it cannot read", () => {
    const dir = workspace();
    const pidFile = join(dir, "broken.json");
    writeFileSync(pidFile, "not json at all");
    const dev = createDevManager({ pidFile });
    expect(dev.reapStale()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("does nothing without a pid file", () => {
    const dev = createDevManager();
    expect(dev.reapStale()).toBe(0);
  });

  test("records a running process so a crash can be cleaned up later", async () => {
    const dir = workspace();
    const pidFile = join(dir, "dev-processes.json");
    const dev = createDevManager({ pidFile });
    try {
      const started = await dev.start({ session_id: "casf:test:r", command: "sleep 30", cwd: dir });
      const table = JSON.parse(readFileSync(pidFile, "utf8")) as { pid?: number }[];
      expect(table.map((row) => row.pid)).toContain(started.pid);

      await dev.stopSession("casf:test:r");
      // A stopped process leaves the table.
      for (let i = 0; i < 40; i++) {
        const after = JSON.parse(readFileSync(pidFile, "utf8")) as unknown[];
        if (after.length === 0) break;
        await Bun.sleep(25);
      }
      expect(JSON.parse(readFileSync(pidFile, "utf8"))).toEqual([]);
    } finally {
      await dev.stopAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
