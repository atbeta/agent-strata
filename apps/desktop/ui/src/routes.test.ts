import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sameRoute, sessionBackHref } from "./routes";

describe("the way back from settings", () => {
  test("names the session the reader left", () => {
    expect(sessionBackHref("s1", () => true)).toBe("/session/s1");
    expect(sessionBackHref("a/b", () => true)).toBe("/session/a%2Fb");
  });

  test("is withheld when there is no session, or it is gone", () => {
    expect(sessionBackHref(undefined, () => true)).toBeUndefined();
    expect(sessionBackHref("", () => true)).toBeUndefined();
    expect(sessionBackHref("s1", () => false)).toBeUndefined();
  });
});

describe("leaving a session that is going away", () => {
  test("the same screen read twice is one route, so the late hashchange moves nothing", () => {
    expect(sameRoute({ name: "fleet" }, { name: "fleet" })).toBe(true);
    expect(sameRoute({ name: "session", id: "a" }, { name: "session", id: "a" })).toBe(true);
    expect(sameRoute({ name: "session", id: "a" }, { name: "session", id: "b" })).toBe(false);
    expect(sameRoute({ name: "session", id: "a" }, { name: "fleet" })).toBe(false);
  });

  test("the window moves the screen with the address, not a frame later", () => {
    const app = readFileSync(join(import.meta.dir, "App.tsx"), "utf8");
    expect(app).toContain("createSignal<Route>(parseHash(), { equals: sameRoute })");
    const leave = app.slice(app.indexOf("const leaveToOverview = () => {"), app.indexOf("const [clock"));
    expect(leave).toContain('location.hash = "/";');
    expect(leave).toContain("setRoute(parseHash());");
    expect(app).toContain("leave: leaveToOverview,");
  });
});
