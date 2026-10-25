import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseWindowsShell, createDevManager, looksLongRunning, commandName } from "../src/dev-process";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "strata-dev-"));
}

/**
 * Remove a scratch directory.
 *
 * Windows keeps a lock on a directory for a moment after the process that had
 * it as its working directory is killed, so the removal is retried rather
 * than turned into a failure that has nothing to do with what is tested.
 */
function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

/** A port nothing is holding, so a test can ask for one without colliding. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/**
 * Whether anything accepts a connection on a loopback port.
 *
 * Both families are asked, because a server that binds "localhost" on Windows
 * lands on ::1 and a probe that only asked 127.0.0.1 would call a working
 * server dead.
 */
function accepts(port: number): Promise<boolean> {
  const tryOne = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(400);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  return Promise.all([tryOne("127.0.0.1"), tryOne("::1")]).then((answers) => answers.some(Boolean));
}

/**
 * The processes below a root, by parent link.
 *
 * The whole point of a stop is that the tree goes with it, and the only way
 * to know that is to ask the operating system what is still there. A stop that
 * reports itself clean while a runtime is still holding the port is the
 * failure this is here to catch.
 */
function descendants(root: number): number[] {
  const pairs = processTree();
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of pairs) {
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const found = new Set<number>();
  const walk = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      walk(child);
    }
  };
  walk(root);
  return [...found];
}

/** Every process on the machine, as (pid, parent pid). */
function processTree(): [number, number][] {
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress";
    const out = Bun.spawnSync(["powershell", "-NoLogo", "-NoProfile", "-Command", script], {
      stdout: "pipe",
      stderr: "ignore",
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.stdout.toString());
    } catch {
      return [];
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const pairs: [number, number][] = [];
    for (const row of rows as { ProcessId?: number; ParentProcessId?: number }[]) {
      if (typeof row?.ProcessId === "number") pairs.push([row.ProcessId, row.ParentProcessId ?? 0]);
    }
    return pairs;
  }
  const out = Bun.spawnSync(["ps", "-eo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  const pairs: [number, number][] = [];
  for (const line of out.stdout.toString().split("\n")) {
    const parts = line.trim().split(/\s+/).map(Number);
    const pid = parts[0];
    const ppid = parts[1];
    if (pid !== undefined && ppid !== undefined && Number.isInteger(pid) && Number.isInteger(ppid)) {
      pairs.push([pid, ppid]);
    }
  }
  return pairs;
}

/** Whether a pid still names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      cleanup(dir);
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
      cleanup(dir);
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
      cleanup(dir);
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
      cleanup(dir);
    }
  });

  test("marks a process stopped when someone asks", async () => {
    const dir = workspace();
    const dev = createDevManager();
    try {
      const started = await dev.start({ session_id: "casf:test:7", command: "sleep 30", cwd: dir });
      const result = await dev.stop(started.id);
      // The answer is what happened, not what was asked for: a stop that
      // leaves something running has to say so.
      expect(result.stopped).toBe(true);
      expect(result.clean).toBe(true);
      expect(result.residual).toEqual([]);
      expect((await dev.stop("dev_missing")).stopped).toBe(false);
      for (let i = 0; i < 40; i++) {
        if (dev.get(started.id)?.exit_code !== null) break;
        await Bun.sleep(25);
      }
      expect(dev.get(started.id)?.stopped).toBe(true);
      expect(dev.get(started.id)?.state).toBe("stopped");
    } finally {
      await dev.stopAll();
      cleanup(dir);
    }
  });

  test("stops the whole tree, not just the process it was handed", async () => {
    const dir = workspace();
    const dev = createDevManager();
    // The shape a dev command really has: a supervisor, a shell, and a
    // runtime that is the one holding the port. The runtime is the one a
    // naive stop leaves behind.
    const port = await freePort();
    const script = join(dir, "server.cjs");
    writeFileSync(
      script,
      `const http = require("http");\n` +
        `http.createServer((q, s) => s.end("ok")).listen(${port}, "::1");\n`,
    );
    try {
      const started = await dev.start({
        session_id: "casf:test:tree",
        command: `node "${script}"`,
        cwd: dir,
        port,
        waitMs: 20_000,
      });
      expect(started.ready).toBe("yes");

      // What the operating system says is there, before the stop: the shell
      // and the runtime below it. The tree is what has to go.
      const tree = descendants(started.pid!);
      expect(tree.length).toBeGreaterThan(0);

      const result = await dev.stop(started.id);
      expect(result.clean).toBe(true);
      expect(result.residual).toEqual([]);
      expect(result.port_free).toBe(true);

      // The port is free, which is the fact the next command depends on.
      expect(await accepts(port)).toBe(false);

      // And nothing of the tree is left running. This is the check the report
      // asked for: "端口空 + 无残留进程".
      const survivors = [started.pid!, ...tree].filter((pid) => alive(pid));
      expect(survivors).toEqual([]);
    } finally {
      await dev.stopAll();
      cleanup(dir);
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
      cleanup(dir);
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
      cleanup(dir);
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

    // The bare array is the shape an older build wrote, and it is still on
    // disk after an upgrade — and it is exactly the file that tells the next
    // run which processes to clean up.
    writeFileSync(
      pidFile,
      JSON.stringify([
        { pid: survivor.pid, id: "dev_a", session_id: "casf:old:1", command: "sleep 60" },
        { pid: dead, id: "dev_b", session_id: "casf:old:2", command: "gone" },
      ]),
    );

    const dev = createDevManager({ pidFile });
    const killed = await dev.reapStale();

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

    // The record stays, because a record that vanishes cannot be asked about:
    // the live one is an orphan that was cleaned up, and the dead one is lost.
    const table = JSON.parse(readFileSync(pidFile, "utf8")) as {
      version: number;
      processes: { id: string; state: string }[];
    };
    expect(table.version).toBe(2);
    expect(table.processes.find((row) => row.id === "dev_a")?.state).toBe("orphaned");
    expect(table.processes.find((row) => row.id === "dev_b")?.state).toBe("lost");
    cleanup(dir);
  });

  test("survives a pid file it cannot read", async () => {
    const dir = workspace();
    const pidFile = join(dir, "broken.json");
    writeFileSync(pidFile, "not json at all");
    const dev = createDevManager({ pidFile });
    expect(await dev.reapStale()).toBe(0);
    cleanup(dir);
  });

  test("does nothing without a pid file", async () => {
    const dev = createDevManager();
    expect(await dev.reapStale()).toBe(0);
  });

  test("records a running process so a crash can be cleaned up later", async () => {
    const dir = workspace();
    const pidFile = join(dir, "dev-processes.json");
    const dev = createDevManager({ pidFile });
    try {
      const started = await dev.start({ session_id: "casf:test:r", command: "sleep 30", cwd: dir });
      const table = JSON.parse(readFileSync(pidFile, "utf8")) as {
        version: number;
        processes: { pid?: number; state: string }[];
      };
      expect(table.version).toBe(2);
      expect(table.processes.map((row) => row.pid)).toContain(started.pid);
      expect(table.processes.find((row) => row.pid === started.pid)?.state).toBe("running");

      await dev.stopSession("casf:test:r");
      // A stopped command keeps its record: it is the only thing that can
      // answer "what happened to it" after the fact.
      for (let i = 0; i < 40; i++) {
        const after = JSON.parse(readFileSync(pidFile, "utf8")) as {
          processes: { pid?: number; state: string }[];
        };
        if (after.processes.find((row) => row.pid === started.pid)?.state === "stopped") break;
        await Bun.sleep(25);
      }
      const after = JSON.parse(readFileSync(pidFile, "utf8")) as {
        processes: { pid?: number; state: string }[];
      };
      expect(after.processes.find((row) => row.pid === started.pid)?.state).toBe("stopped");
    } finally {
      await dev.stopAll();
      cleanup(dir);
    }
  });
});

describe("the registry outlives the service", () => {
  test("a stopped command is still there to be asked about", async () => {
    const dir = workspace();
    const pidFile = join(dir, "dev-processes.json");
    const first = createDevManager({ pidFile });
    const started = await first.start({ session_id: "casf:restart:1", command: "sleep 30", cwd: dir });
    await first.stop(started.id);

    // A second run of the service, reading the same file.
    const second = createDevManager({ pidFile });
    expect(await second.reapStale()).toBe(0);

    const row = second.list().find((entry) => entry.id === started.id);
    expect(row).toBeDefined();
    expect(row?.state).toBe("stopped");
    cleanup(dir);
  });

  test("a command that vanished on its own is lost, not running", async () => {
    const dir = workspace();
    const pidFile = join(dir, "dev-processes.json");
    writeFileSync(
      pidFile,
      JSON.stringify({
        version: 2,
        processes: [
          {
            id: "dev_gone",
            session_id: "casf:restart:2",
            command: "sleep 30",
            cwd: dir,
            pid: 999_999,
            started_at: Date.now(),
            state: "running",
          },
        ],
      }),
    );
    const dev = createDevManager({ pidFile });
    expect(await dev.reapStale()).toBe(0);
    const row = dev.list().find((entry) => entry.id === "dev_gone");
    expect(row?.state).toBe("lost");
    cleanup(dir);
  });

  test("a command still running after a restart is an orphan, and is cleaned up", async () => {
    const dir = workspace();
    const pidFile = join(dir, "dev-processes.json");
    const first = createDevManager({ pidFile });
    const started = await first.start({ session_id: "casf:restart:3", command: "sleep 30", cwd: dir });
    expect(started.pid).toBeGreaterThan(0);

    // The next run of the service finds it still running, and cleans it up.
    const second = createDevManager({ pidFile });
    expect(await second.reapStale()).toBe(1);
    const row = second.list().find((entry) => entry.id === started.id);
    expect(row?.state).toBe("orphaned");

    // Stopping it afterwards does not rewrite what happened to it: it was
    // found running by a later run, and that is the story.
    const stopped = await second.stop(started.id);
    expect(stopped.clean).toBe(true);
    expect(second.list().find((entry) => entry.id === started.id)?.state).toBe("orphaned");

    // The tree went with it: the pid the file named is gone.
    let gone = false;
    for (let i = 0; i < 60; i++) {
      try {
        process.kill(started.pid!, 0);
      } catch {
        gone = true;
        break;
      }
      await Bun.sleep(25);
    }
    expect(gone).toBe(true);
    await first.stopAll();
    cleanup(dir);
  });
});

describe("one port, one tree", () => {
  test("refuses a second command on a port this table is already serving", async () => {
    const dir = workspace();
    const dev = createDevManager();
    const port = await freePort();
    const script = join(dir, "server.cjs");
    writeFileSync(
      script,
      `const http = require("http");\n` +
        `http.createServer((q, s) => s.end("ok")).listen(${port}, "::1");\n`,
    );
    try {
      const first = await dev.start({
        session_id: "casf:test:port",
        command: `node "${script}"`,
        cwd: dir,
        port,
        waitMs: 20_000,
      });
      expect(first.ready).toBe("yes");

      // The second command cannot have the port, and is told which one has it.
      await expect(
        dev.start({
          session_id: "casf:test:port",
          command: `node "${script}"`,
          cwd: dir,
          port,
        }),
      ).rejects.toThrow(/already served by/);
    } finally {
      await dev.stopAll();
      cleanup(dir);
    }
  });

  test("refuses a port that is held by something this table knows nothing about", async () => {
    const dir = workspace();
    const dev = createDevManager();
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = server.port!;
    try {
      await expect(
        dev.start({ session_id: "casf:test:port2", command: "sleep 30", cwd: dir, port }),
      ).rejects.toThrow(/already in use by pid/);
    } finally {
      server.stop(true);
      await dev.stopAll();
      cleanup(dir);
    }
  });
});

describe("output handling", () => {
  test("a GBK line from a Chinese console is decoded, not mangled", async () => {
    const dir = workspace();
    const dev = createDevManager();
    try {
      // `启动成功` in GBK. cmd.exe on a Chinese Windows writes this, and UTF-8
      // decoding would turn it into replacement characters.
      //
      // The bytes are written by node rather than by a shell printf: whether
      // a given printf understands an octal escape depends on which one the
      // machine has, and a test about decoding should not depend on that.
      const started = await dev.start({
        session_id: "casf:test:gbk",
        command: `node -e "process.stdout.write(Buffer.from([0xC6,0xF4,0xB6,0xAF,0xB3,0xC9,0xB9,0xA6,0x0A]))"`,
        cwd: dir,
      });
      for (let i = 0; i < 60; i++) {
        if (dev.logs(started.id).some((l) => l.text.includes("启动成功"))) break;
        await Bun.sleep(25);
      }
      expect(dev.logs(started.id).map((l) => l.text)).toContain("启动成功");
    } finally {
      await dev.stopAll();
      cleanup(dir);
    }
  });

  test("colour escapes never reach the log", async () => {
    const dir = workspace();
    const dev = createDevManager();
    try {
      const started = await dev.start({
        session_id: "casf:test:ansi",
        // The escape is written by node for the same reason as above: the
        // question is what the log does with a colour code, not which shell
        // is on the machine.
        command: `node -e "process.stdout.write('\\u001b[32mready\\u001b[0m\\n')"`,
        cwd: dir,
      });
      for (let i = 0; i < 60; i++) {
        if (dev.logs(started.id).some((l) => l.text.includes("ready"))) break;
        await Bun.sleep(25);
      }
      const texts = dev.logs(started.id).map((l) => l.text);
      expect(texts).toContain("ready");
      expect(texts.every((t) => !t.includes("\u001b"))).toBe(true);
    } finally {
      await dev.stopAll();
      cleanup(dir);
    }
  });
});

describe("readiness", () => {
  test("a named port that answers makes start wait for it and say so", async () => {
    const dir = workspace();
    const dev = createDevManager();
    // A server that opens its port only after a delay, which is the case a
    // stopwatch gets wrong in both directions.
    const port = await freePort();
    const script = join(dir, "server.cjs");
    writeFileSync(
      script,
      `const http = require("http");\n` +
        `setTimeout(() => http.createServer((q, s) => s.end("ok")).listen(${port}), 400);\n`,
    );
    try {
      const began = Date.now();
      const started = await dev.start({
        session_id: "casf:test:ready",
        command: `node "${script}"`,
        cwd: dir,
        port,
        waitMs: 15_000,
      });
      expect(started.port).toBe(port);
      expect(started.ready).toBe("yes");
      // It waited for the port rather than for a stopwatch.
      expect(Date.now() - began).toBeGreaterThanOrEqual(400);
      expect(typeof started.ready_ms).toBe("number");
    } finally {
      await dev.stopAll();
      cleanup(dir);
    }
  });

  test("a server that only listens on ::1 is still found", async () => {
    const dir = workspace();
    const dev = createDevManager();
    const port = await freePort();
    const script = join(dir, "server.cjs");
    // Vite binds "localhost", which on Windows lands on ::1 and nowhere else.
    // A probe that only asked 127.0.0.1 would call this server dead, and the
    // answer it produced would be about the probe rather than the server.
    writeFileSync(
      script,
      `const http = require("http");\n` +
        `http.createServer((q, s) => s.end("ok")).listen(${port}, "::1");\n`,
    );
    try {
      const started = await dev.start({
        session_id: "casf:test:ipv6",
        command: `node "${script}"`,
        cwd: dir,
        port,
        waitMs: 20_000,
      });
      expect(started.ready).toBe("yes");
    } finally {
      await dev.stopAll();
      cleanup(dir);
    }
  });

  test("no port to wait for means start returns without burning the budget", async () => {
    const dir = workspace();
    const dev = createDevManager();
    try {
      const began = Date.now();
      const started = await dev.start({
        session_id: "casf:test:noport",
        command: "sleep 30",
        cwd: dir,
      });
      // A watcher has no port. Waiting 30s for one would make every start look
      // hung, so this must come back in well under a second.
      expect(Date.now() - began).toBeLessThan(3_000);
      expect(started.ready).toBe("unknown");
    } finally {
      await dev.stopAll();
      cleanup(dir);
    }
  });

  test("a port printed by the server is picked up", async () => {
    const dir = workspace();
    const dev = createDevManager();
    try {
      const started = await dev.start({
        session_id: "casf:test:announce",
        command: "echo 'Listening on http://localhost:45999' && sleep 30",
        cwd: dir,
      });
      expect(started.port).toBe(45999);
    } finally {
      await dev.stopAll();
      cleanup(dir);
    }
  });
});

describe("shell selection on Windows", () => {
  test("pwsh wins when it is installed", () => {
    const picked = chooseWindowsShell({ pwsh: "C:\\pwsh.exe", powershell: "C:\\ps.exe", comspec: "C:\\cmd.exe" });
    expect(picked.name).toBe("pwsh");
    expect(picked.path).toBe("C:\\pwsh.exe");
  });

  test("Windows PowerShell is next", () => {
    const picked = chooseWindowsShell({ pwsh: null, powershell: "C:\\ps.exe", comspec: "C:\\cmd.exe" });
    expect(picked.name).toBe("powershell");
  });

  test("cmd is the last resort, not the default", () => {
    const picked = chooseWindowsShell({ pwsh: null, powershell: null, comspec: "C:\\Windows\\system32\\cmd.exe" });
    expect(picked.name).toBe("cmd");
    expect(picked.path).toBe("C:\\Windows\\system32\\cmd.exe");
  });

  test("a machine with no COMSPEC still gets a usable cmd", () => {
    const picked = chooseWindowsShell({});
    expect(picked.name).toBe("cmd");
    expect(picked.path).toBe("cmd.exe");
  });
});
