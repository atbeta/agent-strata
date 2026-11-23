import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");

describe("the snapshot's sync flag", () => {
  test("use-connections reads it off the conn, exports it, and polls while the stream is quiet", () => {
    const src = read("use-connections.tsx");
    expect(src).toContain("const syncBusy = () =>");
    expect(src).toContain('c.sync === "starting" || c.sync === "syncing"');
    expect(src).toContain("if (!syncBusy() || syncTicks().size > 0) return;");
    expect(src).toContain("setInterval(() => void refetchConns(), 1_000)");
    const returned = src.slice(src.indexOf("return {"), src.indexOf("export type ConnectionsCtl"));
    expect(returned).toContain("syncBusy,");
  });

  test("a tick the stream lost is found by asking the service, not by the snapshot in hand", () => {
    const src = read("use-connections.tsx");
    // The snapshot in hand may have been read before the sync started, and
    // would answer `idle` for a sync that is running — clearing a live sync
    // and letting the token total climb again, row by row. So the check is
    // a request of its own.
    expect(src).toContain('getJson<ConnectionsResponse>("/connections")');
    // It runs only while a tick is up, which means it was sent after the
    // sync.started that made the tick.
    expect(src).toContain("const ids = [...syncTicks().keys()];");
    expect(src).toContain("if (ids.length === 0) return;");
    // The ids are taken before the request, so a tick that appeared while
    // it was in flight is not judged by rows that predate it.
    expect(src).toContain("const known = new Map(ids.map((id) => [id, true]));");
    expect(src).toContain("staleSyncTicks(known, rows.connections)");
  });

  test("the last tick to go ends the sync the same way whichever way it went", () => {
    const src = read("use-connections.tsx");
    // One path: the service said sync.finished. The other: the tick was
    // found stale. Both end the same way — the strip comes down and the
    // list is read once more.
    const drop = src.slice(src.indexOf("const dropTick"), src.indexOf("const onSyncEvent"));
    expect(drop).toContain("clearTimeout(syncGrace);");
    expect(drop).toContain("setSyncShown(false);");
    expect(drop).toContain("opts.onChanged();");
    expect(drop).toContain("opts.onSyncOver?.();");
    // The finished event and the check both go through it.
    expect(src).toContain("dropTick(id);");
    expect(src).toContain("for (const id of staleSyncTicks(known, rows.connections)) dropTick(id);");
    const returned = src.slice(src.indexOf("return {"), src.indexOf("export type ConnectionsCtl"));
    expect(returned).toContain("reconcileTicks,");
  });

  test("the stream asks the check again as soon as it reconnects", () => {
    const app = read("App.tsx");
    // The browser reconnects on its own; a socket that broke mid-sync never
    // delivered sync.finished. Reconciling at once is the difference between
    // a tick that clears itself and one that holds the list still for good.
    expect(app).toContain("es.onerror = () => {");
    expect(app).toContain("es.onopen = () => {");
    expect(app).toContain("void conns.reconcileTicks();");
  });

  test("the overview and the workspace list move when the sync ends, not only on the event", () => {
    const app = read("App.tsx");
    // The wrap-up can happen without an event, so the reads that hang off
    // it cannot live in the event handler.
    expect(app).toContain("onSyncOver: () => {");
    expect(app).toContain("setUsageKey((n) => n + 1);");
    expect(app).toContain("void ws.refetchWs();");
  });

  test("the slow pull is covered: a click, a reconnect and a finished turn each refresh on their own", () => {
    const app = read("App.tsx");
    // The footer's dot reaches the window's own pull, and any pull restarts the pace.
    expect(app).toContain('conns.bindSyncNow(() => pull("manual"));');
    expect(app).toContain("if (!pullDue({ reason, connected: conns.connected(), sinceLast })) return;");
    // Only a pull that landed moves the pace; a failed one is retried on the next tick.
    const settled = app.slice(app.indexOf("const job = syncBackend();"), app.indexOf("() => {\n            if (manual) conns.settleManualSync({ phase: \"failed\" });"));
    expect(settled).toContain("conns.setLastPullAt(Date.now());");
    expect(app.slice(app.indexOf("const pull = ("), app.indexOf("const job = syncBackend();"))).not.toContain("setLastPullAt");
    // A click that launch or a running sync holds back is run once they clear, not dropped.
    expect(app).toContain("setManualHeld(true);");
    expect(app).toContain("if (!manualHeld() || !boot.ready() || conns.syncTicks().size > 0) return;");
    expect(app).toContain('untrack(() => pull("manual"));');
    expect(app).toContain("setInterval(() => pull(\"timer\"), PULL_TICK_MS)");
    // A stream that comes back missed what was said while it was down.
    const reopen = app.slice(app.indexOf("es.onopen = () => {"), app.indexOf("opened = true;"));
    expect(reopen).toContain("if (opened) {");
    expect(reopen).toContain("list.refetch();");
    // The usage buckets move when a turn ends, not only when a sync does.
    expect(app).toContain("usageStale = true;");
    expect(app).toContain("if (usageStale) {");
  });

  test("the startup gate does not wait on a sync at all", () => {
    // The list is read from the local store, so an import adds to a window
    // that is already usable. Making the launch wait on it kept the window on
    // the launch surface for as long as the backend took to walk its projects.
    const gate = read("startup.ts");
    expect(gate).not.toContain('"sync"');
    const boot = read("use-startup.ts");
    expect(boot).not.toContain("syncBusy()");
    expect(boot).not.toContain("syncTicks()");
  });

  test("the connection type carries the fields /connections now sends", () => {
    const src = read("api.ts");
    expect(src).toContain('sync?: "starting" | "syncing" | "idle"');
    expect(src).toContain("syncDone?: number");
    expect(src).toContain("syncTotal?: number");
  });
});
