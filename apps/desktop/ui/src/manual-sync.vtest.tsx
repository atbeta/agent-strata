import { afterEach, expect, test, vi } from "vitest";
import { render } from "solid-js/web";
import { MANUAL_SYNC_MIN_MS, useConnections, type ConnectionsCtl } from "./use-connections";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function mountController(): ConnectionsCtl {
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ connections: [], attempts: [] })));
  const host = document.createElement("div");
  document.body.appendChild(host);
  let ctl: ConnectionsCtl | undefined;
  dispose = render(() => {
    ctl = useConnections({ currentDir: () => undefined, onChanged: () => {} });
    return <></>;
  }, host);
  return ctl!;
}

test("a fast manual sync stays running for one full spin", () => {
  vi.useFakeTimers();
  const ctl = mountController();
  ctl.startManualSync();
  ctl.settleManualSync({ phase: "done", imported: 0 });
  expect(ctl.manualSync()?.phase).toBe("running");
  vi.advanceTimersByTime(MANUAL_SYNC_MIN_MS - 1);
  expect(ctl.manualSync()?.phase).toBe("running");
  vi.advanceTimersByTime(1);
  expect(ctl.manualSync()).toEqual({ phase: "done", imported: 0 });
});

test("an earlier result cannot replace a newer click", () => {
  vi.useFakeTimers();
  const ctl = mountController();
  ctl.startManualSync();
  vi.advanceTimersByTime(400);
  ctl.settleManualSync({ phase: "done", imported: 1 });
  vi.advanceTimersByTime(300);
  ctl.startManualSync();
  vi.advanceTimersByTime(200);
  ctl.settleManualSync({ phase: "failed" });
  vi.advanceTimersByTime(100);
  expect(ctl.manualSync()?.phase).toBe("running");
  vi.advanceTimersByTime(699);
  expect(ctl.manualSync()?.phase).toBe("running");
  vi.advanceTimersByTime(1);
  expect(ctl.manualSync()).toEqual({ phase: "failed" });
});
