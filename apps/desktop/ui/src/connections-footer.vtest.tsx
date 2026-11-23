import { afterEach, expect, test, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { LOCALE_TAG, locale, setLocale, t } from "./i18n";
import { ConnectionsFooter, type ConnectionsCtl, type ManualSync } from "./use-connections";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mountFooter(opts: { ticks?: Map<string, { done: number; total: number }>; lastPullAt?: number } = {}) {
  const [manualSync, setManualSync] = createSignal<ManualSync>();
  const [ticks, setTicks] = createSignal(opts.ticks ?? new Map<string, { done: number; total: number }>());
  const syncNow = vi.fn();
  const connections = Object.assign(
    () => ({
      connections: [{ id: "opencode:a", backend: "opencode", baseUrl: "http://127.0.0.1:4096", capabilities: {} }],
      attempts: [],
    }),
    { error: undefined },
  );
  const conns = {
    conns: connections,
    phase: () => "connected",
    connected: () => true,
    connErr: () => "",
    syncShown: () => true,
    syncTicks: ticks,
    manualSync,
    lastPullAt: () => opts.lastPullAt,
    syncNow,
  } as unknown as ConnectionsCtl;
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <ConnectionsFooter conns={conns} />, host);
  const dot = () => host.querySelector<HTMLButtonElement>("button[aria-busy]")!;
  return { dot, syncNow, setManualSync, setTicks };
}

test("the dot is a button that asks for a sync", () => {
  const { dot, syncNow } = mountFooter();
  expect(dot()).toBeTruthy();
  expect(dot().getAttribute("aria-busy")).toBe("false");
  expect(dot().getAttribute("aria-label")).toBe(t("sidebar.sync.now"));
  dot().click();
  expect(syncNow).toHaveBeenCalledTimes(1);
});

test("the offer names when the last sync was, in the window's language rather than the system's", () => {
  const today = new Date();
  const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 5).getTime();
  const was = locale();
  try {
    for (const next of ["en", "zh"] as const) {
      setLocale(next);
      const { dot } = mountFooter({ lastPullAt: at });
      const time = new Intl.DateTimeFormat(LOCALE_TAG[next], { hour: "2-digit", minute: "2-digit" }).format(at);
      expect(dot().getAttribute("aria-label")).toBe(`${t("sidebar.sync.now")} · ${t("sidebar.sync.last", { time })}`);
      dispose?.();
      dispose = undefined;
      document.body.innerHTML = "";
    }
  } finally {
    setLocale(was);
  }
});

test("a sync the reader asked for spins at once and then says what it found", () => {
  const { dot, setManualSync } = mountFooter();
  setManualSync({ phase: "running" });
  expect(dot().getAttribute("aria-busy")).toBe("true");
  expect(dot().getAttribute("aria-label")).toBe(t("sidebar.sync.busy"));
  setManualSync({ phase: "done", imported: 3 });
  expect(dot().getAttribute("aria-busy")).toBe("false");
  expect(dot().getAttribute("aria-label")).toBe(t("sidebar.sync.done", { count: 3 }));
  setManualSync({ phase: "done", imported: 0 });
  expect(dot().getAttribute("aria-label")).toBe(t("sidebar.sync.upToDate"));
  setManualSync({ phase: "failed" });
  expect(dot().getAttribute("aria-label")).toBe(t("sidebar.sync.failed"));
});

test("an announced sync spins and shows its progress instead", () => {
  const { dot, setTicks } = mountFooter();
  setTicks(new Map([["opencode:a", { done: 2, total: 9 }]]));
  expect(dot().getAttribute("aria-busy")).toBe("true");
  expect(dot().getAttribute("aria-label")).toBe(t("sidebar.sync.progress", { done: 2, total: 9 }));
});
