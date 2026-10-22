import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mcpAddProblem,
  mcpAttention,
  mcpFollowUp,
  mcpRowAction,
  mcpShowAddForm,
  mcpShowLoading,
} from "./mcp-panel";

describe("which servers need the reader", () => {
  test("a quiet list leaves the header unmarked", () => {
    expect(mcpAttention([])).toBeUndefined();
    expect(mcpAttention(["connected", "disabled"])).toBeUndefined();
  });

  test("a failure or a registration block marks the header as an error", () => {
    expect(mcpAttention(["failed"])).toBe("error");
    expect(mcpAttention(["needs_client_registration"])).toBe("error");
    expect(mcpAttention(["needs_auth", "failed"])).toBe("error");
  });

  test("sign-in on its own marks the header as waiting", () => {
    expect(mcpAttention(["connected", "needs_auth"])).toBe("pending");
  });
});

describe("the one action on a row", () => {
  test("connected disconnects, stopped or failed connects, sign-in auths", () => {
    expect(mcpRowAction("connected")).toBe("disconnect");
    expect(mcpRowAction("disabled")).toBe("connect");
    expect(mcpRowAction("failed")).toBe("connect");
    expect(mcpRowAction("needs_auth")).toBe("auth");
  });

  test("registration has no button", () => {
    expect(mcpRowAction("needs_client_registration")).toBeUndefined();
  });
});

describe("what a connect just revealed", () => {
  test("landing on sign-in opens the code field", () => {
    expect(mcpFollowUp("connect", "needs_auth")).toBe("auth");
  });

  test("any other result leaves the row on its status", () => {
    expect(mcpFollowUp("connect", "failed")).toBe("stay");
    expect(mcpFollowUp("connect", "disabled")).toBe("stay");
    expect(mcpFollowUp("connect", "connected")).toBe("stay");
    expect(mcpFollowUp("disconnect", "needs_auth")).toBe("stay");
    expect(mcpFollowUp("connect", undefined)).toBe("stay");
  });
});

describe("the add form while typing", () => {
  test("an empty or accepted value stays quiet", () => {
    expect(mcpAddProblem("url", "", "")).toBeUndefined();
    expect(mcpAddProblem("url", "docs", "")).toBeUndefined();
    expect(mcpAddProblem("url", "docs", "https://mcp.example/rpc")).toBeUndefined();
    expect(mcpAddProblem("url", "docs", "https")).toBeUndefined();
    expect(mcpAddProblem("command", "docs", "npx -y pkg")).toBeUndefined();
    expect(mcpAddProblem("command", "a".repeat(64), "npx")).toBeUndefined();
  });

  test("a bad name is named before the address or the command", () => {
    expect(mcpAddProblem("url", "../docs", "https://mcp.example")).toBe("name");
    expect(mcpAddProblem("url", "docs..x", "https://mcp.example")).toBe("name");
    expect(mcpAddProblem("url", "bad name", "javascript:alert(1)")).toBe("name");
    expect(mcpAddProblem("url", "a".repeat(65), "https://mcp.example")).toBe("name");
  });

  test("a scheme that is not http(s), or an open quote, is said once the reader has typed it", () => {
    expect(mcpAddProblem("url", "docs", "javascript:alert(1)")).toBe("url");
    expect(mcpAddProblem("url", "docs", "https://")).toBe("url");
    expect(mcpAddProblem("command", "docs", 'npx "pkg')).toBe("command");
    expect(mcpAddProblem("command", "docs", Array.from({ length: 17 }, () => "a").join(" "))).toBe("command");
  });
});

describe("what the popover spends its height on", () => {
  test("the first open with nothing cached reads, and does not offer the form yet", () => {
    expect(mcpShowLoading(false, 0)).toBe(true);
    expect(mcpShowAddForm(false, 0, false)).toBe(false);
  });

  test("no servers means the form is the panel", () => {
    expect(mcpShowLoading(true, 0)).toBe(false);
    expect(mcpShowAddForm(true, 0, false)).toBe(true);
  });

  test("a list keeps the form closed until the reader asks", () => {
    expect(mcpShowLoading(true, 2)).toBe(false);
    expect(mcpShowAddForm(true, 2, false)).toBe(false);
    expect(mcpShowAddForm(true, 2, true)).toBe(true);
  });

  test("a list already on screen does not flip back to the reading line", () => {
    expect(mcpShowLoading(false, 2)).toBe(false);
    expect(mcpShowAddForm(false, 2, false)).toBe(false);
  });
});

describe("the panel copy stays on the row", () => {
  test("there is no empty-state sentence and no unchanged note", () => {
    const src = readFileSync(join(import.meta.dir, "session-tools.tsx"), "utf8");
    expect(src.includes("mcp.empty")).toBe(false);
    expect(src.includes("mcp.unchanged")).toBe(false);
    expect(src.includes("mcpShowLoading")).toBe(true);
    expect(src.includes("mcpShowAddForm")).toBe(true);
    expect(src.includes("mcpFollowUp")).toBe(true);
    expect(src.includes("mcpAddProblem")).toBe(true);
  });

  test("the header icon carries the attention mark", () => {
    const src = readFileSync(join(import.meta.dir, "session-detail.tsx"), "utf8");
    expect(src.includes("tools.attention()")).toBe(true);
  });

  test("a server error keeps the full sentence in a tip", () => {
    const src = readFileSync(join(import.meta.dir, "session-tools.tsx"), "utf8");
    const row = src.slice(src.indexOf("const note = () =>"), src.indexOf("mcpAuth()?.name"));
    expect(row).toContain("<Tip");
    expect(row).toContain("label={err()}");
  });

  test("the header mark stays a small dot", () => {
    const src = readFileSync(join(import.meta.dir, "session-tools.tsx"), "utf8");
    const mark = src.slice(src.indexOf("export function McpAttentionMark"), src.indexOf("export function useMcpTools"));
    expect(mark.includes("size-1.5")).toBe(true);
    expect(mark.includes("size-2")).toBe(false);
    expect(mark.includes("ring-")).toBe(false);
  });
});
