import { describe, expect, test } from "bun:test";
import { mcpAuthCode, mcpAuthStartView } from "../src/mcp-auth";

describe("mcp auth", () => {
  test("the page receives the login URL and not the oauth state", () => {
    expect(
      mcpAuthStartView({
        authorizationUrl: "https://idp.example/authorize?x=1",
        oauthState: "state-secret-value",
      }),
    ).toEqual({ url: "https://idp.example/authorize?x=1" });
  });

  test("an empty URL means the server is already signed in", () => {
    expect(mcpAuthStartView({ authorizationUrl: "", oauthState: "state-secret-value" })).toEqual({ ok: true });
  });

  test("a non-http URL is refused", () => {
    expect(() => mcpAuthStartView({ authorizationUrl: "javascript:alert(1)" })).toThrow("mcp auth failed");
  });

  test("the pasted code is trimmed and bounded", () => {
    expect(mcpAuthCode("  abc  ")).toBe("abc");
    expect(mcpAuthCode("")).toBeUndefined();
    expect(mcpAuthCode("x".repeat(2049))).toBeUndefined();
  });
});
