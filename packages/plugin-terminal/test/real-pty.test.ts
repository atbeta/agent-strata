import { describe, expect, test } from "bun:test";
import { PtyManager } from "../src/manager";

const posix = process.platform !== "win32";

async function waitFor(manager: PtyManager, id: string, wanted: string): Promise<string> {
  let output = "";
  for (let i = 0; i < 100; i++) {
    const page = manager.read("s", id, 0, 64 * 1024);
    output = new TextDecoder().decode(page.data);
    if (output.includes(wanted)) return output;
    await Bun.sleep(25);
  }
  throw new Error(`terminal did not print ${wanted}: ${output}`);
}

describe.skipIf(!posix)("native PTY", () => {
  test("a child sees a TTY and survives listener detach", async () => {
    const manager = new PtyManager();
    const info = manager.create({
      sessionId: "s",
      title: "probe",
      argv: ["/bin/sh", "-c", "printf 'tty='; if [ -t 0 ]; then echo yes; else echo no; fi; read line; printf 'got=%s\\n' \"$line\"; sleep 30"],
      command: "probe",
      cwd: process.cwd(),
      rows: 24,
      cols: 80,
    });
    try {
      await waitFor(manager, info.id, "tty=yes");
      const attached = manager.attach("s", info.id, () => {});
      attached.unsubscribe();
      manager.write("s", info.id, "hello\n");
      await waitFor(manager, info.id, "got=hello");
      const reattached = manager.attach("s", info.id, () => {});
      expect(new TextDecoder().decode(reattached.replay)).toContain("got=hello");
      reattached.unsubscribe();
      manager.resize("s", info.id, 30, 100);
    } finally {
      await manager.closeAll();
    }
    expect(manager.list("s")).toEqual([]);
  }, 10_000);
});
