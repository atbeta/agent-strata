import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { backendHeadline, sidebarEmptyKind, viewPhase } from "./connection-status";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("viewPhase", () => {
  test("the first frame is pending, not disconnected", () => {
    expect(viewPhase(undefined, undefined)).toBe("pending");
    expect(backendHeadline("pending")).toBe("connecting");
  });

  test("a service that never answers is not the same as a backend nobody connected", () => {
    expect(viewPhase(undefined, new Error("down"))).toBe("unreachable");
    expect(backendHeadline("unreachable")).toBe("unreachable");
  });

  test("attaching stays on the connecting line", () => {
    expect(viewPhase({ phase: "attaching", connections: [] }, undefined)).toBe("attaching");
    expect(backendHeadline("attaching")).toBe("connecting");
  });

  test("a given-up attempt is a failure, and idle is the only none", () => {
    expect(backendHeadline(viewPhase({ phase: "failed", connections: [] }, undefined))).toBe("failed");
    expect(backendHeadline("idle")).toBe("none");
    expect(backendHeadline("missing")).toBe("missing");
  });

  test("an older payload without a phase still distinguishes connected from idle", () => {
    expect(viewPhase({ connections: [{ id: "c" } as never] }, undefined)).toBe("connected");
    expect(viewPhase({ connections: [] }, undefined)).toBe("idle");
  });
});

describe("sidebarEmptyKind", () => {
  test("a session-list error stays an error", () => {
    expect(sidebarEmptyKind({ phase: "pending", listSettled: false, listError: true })).toBe("listError");
  });

  test("the connect sentence waits until we know nothing is coming", () => {
    expect(sidebarEmptyKind({ phase: "pending", listSettled: false, listError: false })).toBe("connecting");
    expect(sidebarEmptyKind({ phase: "attaching", listSettled: false, listError: false })).toBe("connecting");
    expect(sidebarEmptyKind({ phase: "failed", listSettled: true, listError: false })).toBe("failed");
    expect(sidebarEmptyKind({ phase: "idle", listSettled: false, listError: false })).toBe("needBackend");
    expect(sidebarEmptyKind({ phase: "idle", listSettled: true, listError: false })).toBe("none");
  });

  test("a connected list that has not arrived yet does not claim there are no sessions", () => {
    expect(sidebarEmptyKind({ phase: "connected", listSettled: false, listError: false })).toBe("hidden");
    expect(sidebarEmptyKind({ phase: "connected", listSettled: true, listError: false })).toBe("none");
  });
});

describe("the connect panel", () => {
  test("the corner shows live status and leaves management to settings", () => {
    const footer = read("use-connections.tsx");
    expect(footer).toContain('location.hash = "/settings/backends"');
    expect(footer).toContain("conn.tier");
    expect(footer).not.toContain("conn.placement");
    expect(footer).not.toContain("data-connect-keep");
    expect(footer).not.toContain("LAUNCHING");
    const page = read("backend-settings.tsx");
    expect(page).toContain("settings.backends.disconnect");
    expect(page).toContain("settings.backends.forget");
    expect(page).toContain("connect.kind.acp");
    expect(page).toContain("settings.backends.history");
    // the engine is the app's foundation, apart from the added servers
    expect(page).toContain("settings.engine.title");
    expect(page).toContain("conn.placement === \"embed\"");
    // a remote server names its missing capability where it is added and listed
    expect(page).toContain("connect.remoteNotice");
    expect(page).toContain("settings.backends.pluginsMissing");
    // an engine switched off is the setting, not an outage
    expect(page).toContain("settings.engine.off");
    expect(page).toContain("/settings/opencode");
    // and the session itself carries the tier where the reader works
    const header = read("session-header.tsx");
    expect(header).toContain("session.remote.badge");
    expect(header).toContain("session.remote.tip");
    const detail = read("session-detail.tsx");
    expect(detail).toContain("conn.tier === \"remote\"");
  });
});
