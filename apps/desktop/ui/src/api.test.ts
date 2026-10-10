import { describe, expect, test } from "bun:test";
import { exportFileName, opencodePath } from "./api";

describe("an exported session", () => {
  test("is saved under a name any file system takes", () => {
    expect(exportFileName("opencode:ses_1")).toBe("strata-opencode_ses_1.ndjson");
    expect(exportFileName("acp:claude-code:a/b")).toBe("strata-acp_claude-code_a_b.ndjson");
  });
});

describe("a read of a session's opencode backend", () => {
  test("names the session and the path", () => {
    expect(opencodePath("opencode:ses_1", "/vcs")).toBe("/sessions/opencode%3Ases_1/opencode/vcs");
  });

  test("carries its query", () => {
    expect(opencodePath("opencode:ses_1", "/find/file", { query: "a b", limit: 5 })).toBe(
      "/sessions/opencode%3Ases_1/opencode/find/file?query=a+b&limit=5",
    );
  });

  test("a file search carries its query and limit", () => {
    expect(opencodePath("opencode:ses_1", "/find/file", { query: "a", limit: 20, dirs: "false" })).toBe(
      "/sessions/opencode%3Ases_1/opencode/find/file?query=a&limit=20&dirs=false",
    );
  });
});
