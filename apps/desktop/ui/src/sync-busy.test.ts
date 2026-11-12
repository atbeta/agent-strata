import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("the snapshot's sync flag", () => {
  test("use-connections reads it off the conn, exports it, and polls while the stream is quiet", () => {
    const src = readFileSync(join(import.meta.dir, "use-connections.tsx"), "utf8");
    expect(src).toContain("const syncBusy = () =>");
    expect(src).toContain('c.sync === "starting" || c.sync === "syncing"');
    expect(src).toContain("if (!syncBusy() || syncTicks().size > 0) return;");
    expect(src).toContain("setInterval(() => void refetchConns(), 1_000)");
    const returned = src.slice(src.indexOf("return {"), src.indexOf("export type ConnectionsCtl"));
    expect(returned).toContain("syncBusy,");
  });

  test("the startup gate does not wait on a sync at all", () => {
    // The list is read from the local store, so an import adds to a window
    // that is already usable. Making the launch wait on it kept the window on
    // the launch surface for as long as the backend took to walk its projects.
    const gate = readFileSync(join(import.meta.dir, "startup.ts"), "utf8");
    expect(gate).not.toContain('"sync"');
    const boot = readFileSync(join(import.meta.dir, "use-startup.ts"), "utf8");
    expect(boot).not.toContain("syncBusy()");
    expect(boot).not.toContain("syncTicks()");
  });

  test("the connection type carries the fields /connections now sends", () => {
    const src = readFileSync(join(import.meta.dir, "api.ts"), "utf8");
    expect(src).toContain('sync?: "starting" | "syncing" | "idle"');
    expect(src).toContain("syncDone?: number");
    expect(src).toContain("syncTotal?: number");
  });
});
