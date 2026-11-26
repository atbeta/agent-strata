import { afterEach, expect, test } from "vitest";
import { createMemo } from "solid-js";
import { render } from "solid-js/web";
import { useTerminals } from "./use-terminals";
import { useSchedules } from "./use-schedules";
import { useDevProcesses } from "./dev-processes";

/**
 * The runtime half of the claim plugin-route-404.test.ts makes about the
 * shape of the reads: with every plugin route answering 404, reading the
 * panes must not throw.
 *
 * `bun test` resolves solid-js to its server build and cannot create a
 * resource, so the mount has to happen under vitest. The suite CI runs carries
 * the source-level half of the same claim.
 */

const originalFetch = globalThis.fetch;

function pluginRoutesAnswer404() {
  globalThis.fetch = (async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : ((input as { url?: string })?.url ?? "");
    if (url.includes("/plugins/")) {
      return Response.json({ error: "no such plugin" }, { status: 404 });
    }
    return Response.json(
      { sessions: [], shells: [], schedules: [], candidates: [], processes: [] },
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 40));
}

interface Reading {
  threw: boolean;
  message: string;
}

function read(fn: () => unknown): Reading {
  try {
    fn();
    return { threw: false, message: "" };
  } catch (error) {
    return { threw: true, message: String(error) };
  }
}

test("a plugin route that is not there must not take the session page down", async () => {
  pluginRoutesAnswer404();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const readings: Record<string, Reading> = {};
  let reRead: () => void = () => {};

  const dispose = render(() => {
    const terminals = useTerminals(() => "opencode:ses_1", () => true);
    const schedules = useSchedules(() => "opencode:ses_1", () => true);
    const dev = useDevProcesses(() => "opencode:ses_1", () => true);

    const probe = createMemo(() => {
      readings.terminals = read(() => (terminals as { count: () => number }).count());
      const s = schedules as { count?: () => number; rows?: unknown };
      readings.schedules = read(() =>
        typeof s.count === "function" ? s.count() : Array.isArray(s.rows) ? s.rows.length : 0,
      );
      readings.dev = read(() => (dev as { count: () => number }).count());
    });
    reRead = () => probe();
    return <div data-testid="probe" />;
  }, host);

  await settle();
  let escaped = "";
  try {
    reRead();
  } catch (error) {
    escaped = String(error);
  }
  console.log("READINGS " + JSON.stringify({ readings, escaped }));
  dispose();

  expect(escaped).toBe("");
  expect(readings.terminals?.threw).toBe(false);
  expect(readings.schedules?.threw).toBe(false);
  expect(readings.dev?.threw).toBe(false);
});
