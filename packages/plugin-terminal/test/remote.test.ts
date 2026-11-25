import { describe, expect, test } from "bun:test";
import { RemotePtyManager } from "../src/remote";
import type { PtyCreateInput } from "../src/manager";
import type { RemotePtyApi } from "../src/types";

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  private listeners = new Map<string, ((ev: never) => void)[]>();
  constructor(
    public url: string,
    public headers: Record<string, string>,
  ) {}
  addEventListener(type: string, fn: (ev: never) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener() {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, ev: object = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev as never);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  text(data: string) {
    this.emit("message", { data });
  }
  meta(cursor: number) {
    const bytes = new TextEncoder().encode(JSON.stringify({ cursor }));
    const frame = new Uint8Array(bytes.length + 1);
    frame.set(bytes, 1);
    this.emit("message", { data: frame.buffer });
  }
  drop(code = 1006) {
    this.emit("close", { code });
  }
}

function harness(maxReconnects = 5) {
  const sockets: FakeSocket[] = [];
  const calls = {
    create: [] as { directory: string; input: Record<string, unknown> }[],
    remove: [] as string[],
    resize: [] as { id: string; size: { rows: number; cols: number } }[],
    open: [] as { id: string; cursor?: number }[],
  };
  let nextId = 0;
  const api: RemotePtyApi = {
    shells: async () => [{ name: "bash", path: "/bin/bash", acceptable: true }],
    create: async (directory, input) => {
      calls.create.push({ directory, input: input as Record<string, unknown> });
      nextId += 1;
      return { id: `pty_r${nextId}`, title: input.title ?? "t", command: input.command ?? "", cwd: input.cwd ?? directory, status: "running" };
    },
    remove: async (_d, id) => {
      calls.remove.push(id);
    },
    resize: async (_d, id, size) => {
      calls.resize.push({ id, size });
    },
    open: async (_d, id, cursor) => {
      calls.open.push({ id, cursor });
      return { url: `ws://fake/pty/${id}/connect`, headers: { authorization: "Basic x" } };
    },
  };
  const manager = new RemotePtyManager({
    maxReconnects,
    webSocket: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { manager, api, calls, sockets };
}

function input(remote: { api: RemotePtyApi; directory: string }, over: Partial<PtyCreateInput> = {}): PtyCreateInput {
  return {
    sessionId: "s1",
    title: "t",
    argv: ["/bin/bash", "-l"],
    command: "/bin/bash",
    cwd: "/root/strata-test",
    rows: 24,
    cols: 80,
    mode: "user",
    remote,
    ...over,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("a terminal on the backend's machine", () => {
  test("create posts the split argv and bridged output becomes readable", async () => {
    const { manager, api, calls, sockets } = harness();
    const remote = { api, directory: "/root/strata-test" };
    const info = await manager.create(input(remote));
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]!.input.command).toBe("/bin/bash");
    expect(calls.create[0]!.input.args).toEqual(["-l"]);
    expect(calls.create[0]!.input.cwd).toBe("/root/strata-test");
    expect(info.status).toBe("running");
    await flush();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toContain("/connect");
    expect(sockets[0]!.headers.authorization).toBe("Basic x");
    sockets[0]!.open();
    sockets[0]!.meta(0);
    sockets[0]!.text("hello $ ");
    const page = manager.read("s1", info.id);
    expect(new TextDecoder().decode(page.data)).toBe("hello $ ");
  });

  test("the meta frame is bookkeeping, not terminal output", async () => {
    const { manager, api, sockets } = harness();
    const info = await manager.create(input({ api, directory: "/w" }));
    await flush();
    sockets[0]!.open();
    sockets[0]!.meta(42);
    const page = manager.read("s1", info.id);
    expect(page.data.byteLength).toBe(0);
  });

  test("input written before the socket opens is not lost", async () => {
    const { manager, api, sockets } = harness();
    const info = await manager.create(input({ api, directory: "/w" }));
    await flush();
    manager.write("s1", info.id, "ls\n");
    expect(sockets[0]!.sent).toHaveLength(0);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toEqual(["ls\n"]);
  });

  test("a server close ends the terminal; a network drop resumes at the cursor", async () => {
    const { manager, api, calls, sockets } = harness();
    const events: string[] = [];
    manager.onChange((info) => events.push(info.status));
    const info = await manager.create(input({ api, directory: "/w" }));
    await flush();
    sockets[0]!.open();
    sockets[0]!.meta(0);
    sockets[0]!.text("abc");
    // a network drop: reconnect with the consumed cursor
    sockets[0]!.drop(1006);
    await Bun.sleep(1100);
    expect(calls.open.length).toBeGreaterThanOrEqual(2);
    expect(calls.open.at(-1)!.cursor).toBe(3);
    expect(manager.get("s1", info.id).status).toBe("running");
    // a fresh socket comes up; the server ends the process
    sockets.at(-1)!.open();
    sockets.at(-1)!.emit("close", { code: 1000 });
    expect(manager.get("s1", info.id).status).toBe("exited");
    expect(events).toContain("exited");
  });

  test("reconnects give up eventually and the terminal is declared lost", async () => {
    const { manager, api, sockets } = harness(1);
    const info = await manager.create(input({ api, directory: "/w" }));
    await flush();
    sockets[0]!.open();
    sockets[0]!.drop(1006);
    // first reconnect is scheduled; kill it too, exhausting the budget
    await Bun.sleep(1100);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    sockets.at(-1)!.drop(1006);
    await Bun.sleep(100);
    expect(manager.get("s1", info.id).status).toBe("exited");
  });

  test("resize and close reach the backend, close tolerates an already-gone session", async () => {
    const { manager, api, calls, sockets } = harness();
    const info = await manager.create(input({ api, directory: "/w" }));
    await flush();
    sockets[0]!.open();
    await manager.resize("s1", info.id, 40, 120);
    expect(calls.resize).toEqual([{ id: info.id, size: { rows: 40, cols: 120 } }]);
    const result = await manager.close("s1", info.id);
    expect(result.cleanup).toBe("exited");
    expect(calls.remove).toEqual([info.id]);
  });

  test("SIGINT is the control character; SIGTERM says why it cannot", async () => {
    const { manager, api, sockets } = harness();
    const info = await manager.create(input({ api, directory: "/w" }));
    await flush();
    sockets[0]!.open();
    await manager.signal("s1", info.id, "SIGINT");
    expect(sockets[0]!.sent).toContain("\x03");
    await expect(manager.signal("s1", info.id, "SIGTERM")).rejects.toThrow("remote terminal");
  });

  test("agent scoping still applies across the wire", async () => {
    const { manager, api, sockets } = harness();
    const info = await manager.create(input({ api, directory: "/w" }, { mode: "user" }));
    await flush();
    sockets[0]!.open();
    expect(() => manager.readAgent("s1", info.id)).toThrow();
    manager.setMode("s1", info.id, "shared");
    expect(manager.readAgent("s1", info.id).next_offset).toBe(0);
  });

  test("a failed first connect is retried, not left a zombie", async () => {
    const sockets: FakeSocket[] = [];
    let failures = 0;
    const api: RemotePtyApi = {
      shells: async () => [],
      create: async (directory, input) => ({
        id: "pty_f1",
        title: input.title ?? "t",
        command: input.command ?? "",
        cwd: input.cwd ?? directory,
        status: "running",
      }),
      remove: async () => {},
      resize: async () => {},
      open: async () => {
        failures += 1;
        if (failures < 2) throw new Error("connect-token endpoint unreachable");
        return { url: "ws://fake/pty/pty_f1/connect", headers: {} };
      },
    };
    const manager = new RemotePtyManager({
      webSocket: (url, headers) => {
        const socket = new FakeSocket(url, headers);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const info = await manager.create(input({ api, directory: "/w" }));
    await flush();
    // one failure, then the retried attempt succeeds and output flows
    await Bun.sleep(1200);
    expect(failures).toBeGreaterThanOrEqual(2);
    expect(manager.get("s1", info.id).status).toBe("running");
    sockets.at(-1)!.open();
    sockets.at(-1)!.meta(0);
    sockets.at(-1)!.text("alive");
    expect(new TextDecoder().decode(manager.read("s1", info.id).data)).toBe("alive");
  });

  test("a first connect that never succeeds is declared lost, not a zombie", async () => {
    const api: RemotePtyApi = {
      shells: async () => [],
      create: async (directory, input) => ({
        id: "pty_f2",
        title: input.title ?? "t",
        command: input.command ?? "",
        cwd: input.cwd ?? directory,
        status: "running",
      }),
      remove: async () => {},
      resize: async () => {},
      open: async () => {
        throw new Error("connect-token endpoint unreachable");
      },
    };
    const manager = new RemotePtyManager({ maxReconnects: 1, webSocket: (u, h) => new FakeSocket(u, h) as unknown as WebSocket });
    const info = await manager.create(input({ api, directory: "/w" }));
    await flush();
    await Bun.sleep(1200);
    expect(manager.get("s1", info.id).status).toBe("exited");
  });
});
