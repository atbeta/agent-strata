import { describe, expect, test } from "bun:test";
import { opencodePath } from "./api";

describe("a read of a session's opencode backend", () => {
  test("names the session and the path", () => {
    expect(opencodePath("opencode:ses_1", "/vcs")).toBe("/sessions/opencode%3Ases_1/opencode/vcs");
  });

  test("carries its query", () => {
    expect(opencodePath("opencode:ses_1", "/find/file", { query: "a b", limit: 5 })).toBe(
      "/sessions/opencode%3Ases_1/opencode/find/file?query=a+b&limit=5",
    );
  });
});
