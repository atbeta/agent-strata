import { describe, expect, test } from "bun:test";
import { mcpAddRequest, safeMcpError } from "../src/mcp-add";

describe("mcp add body", () => {
  test("a command line becomes a local server", () => {
    expect(mcpAddRequest({ name: "files", command: 'npx -y "@scope/pkg" .' })).toEqual({
      name: "files",
      config: { type: "local", command: ["npx", "-y", "@scope/pkg", "."] },
    });
  });

  test("an https address becomes a remote server", () => {
    expect(mcpAddRequest({ name: "docs", url: "https://mcp.example/rpc" })).toEqual({
      name: "docs",
      config: { type: "remote", url: "https://mcp.example/rpc" },
    });
  });

  test("a config object, a bad name, and a non-http url are refused", () => {
    expect(mcpAddRequest({ name: "docs", config: { type: "remote", url: "https://mcp.example" } })).toEqual({
      error: "command or url",
    });
    expect(mcpAddRequest({ name: "../docs", url: "https://mcp.example" })).toEqual({ error: "invalid name" });
    expect(mcpAddRequest({ name: "docs", url: "javascript:alert(1)" })).toEqual({ error: "invalid url" });
    expect(mcpAddRequest({ name: "docs", command: "npx", url: "https://mcp.example" })).toEqual({
      error: "command or url",
    });
  });

  test("an error that repeats the address is replaced", () => {
    const url = "https://mcp.example/secret-token";
    expect(safeMcpError(new Error(`refused ${url}`), { url })).toBe("mcp add failed");
    expect(safeMcpError(new Error("connection refused"), { url })).toBe("connection refused");
  });
});
