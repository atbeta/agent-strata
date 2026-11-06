import { describe, expect, test } from "bun:test";
import { sessionBackHref } from "./routes";

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
