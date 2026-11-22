import { describe, expect, test } from "bun:test";
import { PtyManager } from "../src/manager";
import type { PtyProcess, PtySpawnInput } from "../src/types";

function fixture() {
  let input: PtySpawnInput | undefined;
  let resolveExit: (code: number) => void = () => {};
  const writes: (string | Uint8Array)[] = [];
  const sizes: [number, number][] = [];
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const child: PtyProcess = {
    pid: 123,
    exited,
    terminal: {
      write(data) {
        writes.push(data);
        return typeof data === "string" ? data.length : data.byteLength;
      },
      resize(cols, rows) {
        sizes.push([cols, rows]);
      },
      close() {},
    },
    kill() {},
  };
  const manager = new PtyManager({
    spawn(options) {
      input = options;
      return child;
    },
    terminate: async () => {
      resolveExit(0);
    },
    platform: "darwin",
  });
  return { manager, child, input: () => input!, writes, sizes, resolveExit: (code: number) => resolveExit(code) };
}

const createInput = {
  sessionId: "s1",
  title: "shell",
  argv: ["/bin/sh"],
  command: "/bin/sh",
  cwd: "/work",
  rows: 24,
  cols: 80,
};

describe("PTY lifetime", () => {
  test("detaching a listener does not kill the process, and replay uses the same output", async () => {
    const f = fixture();
    const info = f.manager.create(createInput);
    expect(f.input().detached).toBe(true);
    f.input().onData(new TextEncoder().encode("before"));
    const first = f.manager.attach("s1", info.id, () => {});
    first.unsubscribe();
    f.input().onData(new TextEncoder().encode("-after"));
    const second = f.manager.attach("s1", info.id, () => {});
    expect(new TextDecoder().decode(second.replay)).toBe("before-after");
    expect(f.manager.get("s1", info.id).status).toBe("running");
    f.manager.write("s1", info.id, "pwd\n");
    f.manager.resize("s1", info.id, 40, 120);
    expect(f.writes).toEqual(["pwd\n"]);
    expect(f.sizes).toEqual([[120, 40]]);
    await f.manager.close("s1", info.id);
    expect(f.manager.list("s1")).toEqual([]);
  });

  test("another session cannot read or write a terminal by id", () => {
    const f = fixture();
    const info = f.manager.create(createInput);
    expect(() => f.manager.get("s2", info.id)).toThrow("no terminal");
    expect(() => f.manager.write("s2", info.id, "x")).toThrow("no terminal");
    expect(f.manager.list("s2")).toEqual([]);
  });

  test("session cleanup closes every owned terminal", async () => {
    const f = fixture();
    f.manager.create(createInput);
    f.manager.create({ ...createInput, sessionId: "s2" });
    await f.manager.closeSession("s1");
    expect(f.manager.list("s1")).toEqual([]);
    expect(f.manager.list("s2")).toHaveLength(1);
    await f.manager.closeAll();
  });
});
