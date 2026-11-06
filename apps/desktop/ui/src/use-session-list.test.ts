import { describe, expect, test } from "bun:test";
import { uniqueSuffixes } from "./use-session-list";

describe("uniqueSuffixes", () => {
  test("siblings under different parents use the parent segment alone", () => {
    const hints = uniqueSuffixes(["/Users/beta/alpha/app", "/Users/beta/beta/app"]);
    expect(hints.get("/Users/beta/alpha/app")).toBe("alpha");
    expect(hints.get("/Users/beta/beta/app")).toBe("beta");
  });

  test("same-named parents climb one more segment, both at the same depth", () => {
    const hints = uniqueSuffixes([
      "/Users/beta/relaycraft/relay-core",
      "/Users/beta/Projects/relaycraft/relay-core",
    ]);
    expect(hints.get("/Users/beta/relaycraft/relay-core")).toBe("~/relaycraft");
    expect(hints.get("/Users/beta/Projects/relaycraft/relay-core")).toBe("Projects/relaycraft");
  });

  test("a project at home reads as ~, and still tells its rival apart", () => {
    const hints = uniqueSuffixes(["/Users/beta/MCP", "/Users/beta/work/MCP"]);
    expect(hints.get("/Users/beta/MCP")).toBe("~");
    expect(hints.get("/Users/beta/work/MCP")).toBe("work");
  });

  test("three-way collisions climb until all three are unique", () => {
    const hints = uniqueSuffixes([
      "/Users/beta/a/x/p",
      "/Users/beta/b/x/p",
      "/Users/beta/c/x/p",
    ]);
    expect(hints.get("/Users/beta/a/x/p")).toBe("a/x");
    expect(hints.get("/Users/beta/b/x/p")).toBe("b/x");
    expect(hints.get("/Users/beta/c/x/p")).toBe("c/x");
  });

  test("trailing separators do not change the tail", () => {
    const hints = uniqueSuffixes(["/Users/beta/one/app/", "/Users/beta/two/app"]);
    expect(hints.get("/Users/beta/one/app/")).toBe("one");
    expect(hints.get("/Users/beta/two/app")).toBe("two");
  });
});
