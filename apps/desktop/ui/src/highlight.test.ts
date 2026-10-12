import { describe, expect, test } from "bun:test";
import { grammarFor, tokenize } from "./highlight";

describe("a filename or fence label", () => {
  test("maps common extensions onto a grammar", () => {
    expect(grammarFor("src/main.rs")).toBe("rust");
    expect(grammarFor("app.py")).toBe("py");
    expect(grammarFor("styles.css")).toBe("css");
    expect(grammarFor("query.sql")).toBe("sql");
    expect(grammarFor("notes.md")).toBe("md");
    expect(grammarFor("config.yaml")).toBe("yaml");
    expect(grammarFor("page.html")).toBe("html");
    expect(grammarFor("main.go")).toBe("go");
  });

  test("still accepts a fence label", () => {
    expect(grammarFor("typescript")).toBe("ts");
    expect(grammarFor("bash")).toBe("sh");
    expect(grammarFor("json")).toBe("json");
  });

  test("leaves an unknown file plain", () => {
    expect(grammarFor("image.png")).toBeNull();
    expect(grammarFor(undefined)).toBeNull();
  });
});

describe("tokens", () => {
  test("colours a rust keyword and a markdown heading", () => {
    expect(tokenize("fn main() {}", "rust").some((t) => t.kind === "keyword" && t.text === "fn")).toBe(true);
    const heading = tokenize("# Title\nbody", "md");
    expect(heading[0]).toEqual({ kind: "keyword", text: "# Title" });
  });
});
