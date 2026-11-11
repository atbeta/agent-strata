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

  test("the startup gate counts a sync the stream has not reported", () => {
    const src = readFileSync(join(import.meta.dir, "use-startup.ts"), "utf8");
    expect(src).toContain("syncTicks().size > 0 || opts.conns.syncBusy()");
  });

  test("the connection type carries the fields /connections now sends", () => {
    const src = readFileSync(join(import.meta.dir, "api.ts"), "utf8");
    expect(src).toContain('sync?: "starting" | "syncing" | "idle"');
    expect(src).toContain("syncDone?: number");
    expect(src).toContain("syncTotal?: number");
  });
});
