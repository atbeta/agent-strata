import { describe, expect, test } from "bun:test";
import { PtyManager, type PtyCreateInput, type PtyManagerOptions } from "../src/manager";
import type { PtyProcess } from "../src/types";

const input: PtyCreateInput = {
  sessionId: "s",
  title: "probe",
  argv: ["/bin/sh"],
  command: "/bin/sh",
  cwd: "/work",
  mode: "shared",
  rows: 24,
  cols: 80,
};

function fixture(options: PtyManagerOptions) {
  const children = new Map<number, (code: number) => void>();
  const manager = new PtyManager({
    ...options,
    spawn() {
      let resolve: (code: number) => void = () => {};
      const child: PtyProcess = {
        pid: children.size + 1,
        exited: new Promise<number>((done) => {
          resolve = done;
        }),
        terminal: {
          write: (data) => typeof data === "string" ? data.length : data.byteLength,
          resize() {},
          close() {},
        },
        kill() {},
      };
      children.set(child.pid, resolve);
      return child;
    },
    terminate: async (child) => {
      children.get(child.pid)?.(0);
      return "exited";
    },
    platform: "darwin",
  });
  return { manager, exit: (info: { pid?: number }, code = 0) => children.get(info.pid!)?.(code) };
}

describe("exited terminal reclamation", () => {
  test("the global quota counts running processes, not stale entries", async () => {
    const f = fixture({ maxProcesses: 2, maxExited: 8, exitTtlMs: 60_000 });
    const first = f.manager.create(input);
    f.manager.create(input);
    expect(() => f.manager.create(input)).toThrow("too many terminals");
    f.exit(first);
    await Bun.sleep(0);
    expect(f.manager.list().filter((info) => info.status === "exited")).toHaveLength(1);
    const replacement = f.manager.create(input);
    expect(replacement.status).toBe("running");
    await f.manager.closeAll();
  });

  test("an exited terminal stays readable during its grace period, then is reaped", async () => {
    const f = fixture({ maxExited: 8, exitTtlMs: 20 });
    const info = f.manager.create(input);
    f.manager.attach("s", info.id, () => {}).unsubscribe();
    f.exit(info);
    await Bun.sleep(0);
    expect(f.manager.get("s", info.id).status).toBe("exited");
    const attached = f.manager.attach("s", info.id, () => {});
    attached.unsubscribe();
    await Bun.sleep(50);
    expect(f.manager.list("s")).toEqual([]);
    await f.manager.closeAll();
  });

  test("the exited record cap drops the oldest record first", async () => {
    const f = fixture({ maxExited: 1, exitTtlMs: 60_000 });
    const first = f.manager.create(input);
    f.exit(first);
    await Bun.sleep(0);
    const second = f.manager.create(input);
    f.exit(second);
    await Bun.sleep(0);
    expect(f.manager.list("s").map((info) => info.id)).toEqual([second.id]);
    await f.manager.closeAll();
  });
});
