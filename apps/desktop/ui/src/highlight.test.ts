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

  test("a line comment stops at the newline and the next line still reads", () => {
    const out = tokenize("let x = 1 // trailing\nlet y = 2", "ts");
    expect(out.some((t) => t.kind === "comment" && t.text === "// trailing")).toBe(true);
    expect(out.filter((t) => t.kind === "keyword").map((t) => t.text)).toEqual(["let", "let"]);
  });

  test("a line comment with no newline after it runs to the end", () => {
    expect(tokenize("let x = 1 // end", "ts").some((t) => t.kind === "comment" && t.text === "// end")).toBe(true);
  });

  test("a block comment closes and what follows it still reads", () => {
    const out = tokenize("/* gone */ let y = 2", "ts");
    expect(out.some((t) => t.kind === "comment" && t.text === "/* gone */")).toBe(true);
    expect(out.filter((t) => t.kind === "keyword").map((t) => t.text)).toEqual(["let"]);
  });

  test("an unclosed block comment takes the rest rather than stopping short", () => {
    expect(tokenize("let a = 1\n/* never closed", "ts").some((t) => t.kind === "comment" && t.text === "/* never closed")).toBe(true);
  });

  test("an escaped quote does not end the string", () => {
    expect(tokenize('let s = "a\\"b"; let t = 2', "ts").some((t) => t.kind === "string" && t.text === '"a\\"b"')).toBe(true);
  });

  test("an unterminated string stops at the newline instead of swallowing the rest", () => {
    const out = tokenize('let s = "open\nlet t = 2', "ts");
    expect(out.some((t) => t.kind === "string" && t.text === '"open')).toBe(true);
    expect(out.filter((t) => t.kind === "keyword").map((t) => t.text)).toEqual(["let", "let"]);
  });

  test("a heading with no newline after it runs to the end", () => {
    expect(tokenize("# Title", "md")[0]).toEqual({ kind: "keyword", text: "# Title" });
  });

  test("a '#' mid-line is not a heading", () => {
    expect(tokenize("a # mid-line", "md").some((t) => t.kind === "keyword")).toBe(false);
  });

  /**
   * The one invariant that covers every offset in the scanner: whatever it
   * decides a token is, the pieces still have to spell the original. An index
   * off by a delimiter's length drops or repeats a character here, whatever it
   * does to the colours.
   */
  test("every grammar puts the source back together unchanged", () => {
    const samples = [
      "let x = 1 // trailing\nlet y = 2",
      "/* a */ /* b */ let z = 'q' /* unclosed",
      'const s = "a\\"b"; let n = 1.5e10;',
      "def f():\n    # note\n    return 'x'\n",
      "a\n# not a heading\nb",
      "<div class=\"x\"><!-- c --></div>",
      "SELECT 1 -- note\n/* block */ FROM t;",
      "}{)(;:punctuation everywhere;{}",
      "unterminated string at the very end: \"",
      "unterminated line comment at the very end //",
      "多字节文本 mixed with ascii and 123",
    ];
    for (const grammar of ["ts", "rust", "py", "md", "json", "html", "sql", "sh", "css", "lua", "yaml", "toml", "go", "c", "java", "rb", "php"] as const) {
      for (const src of samples) {
        expect(tokenize(src, grammar).map((t) => t.text).join("")).toBe(src);
      }
    }
  });

  test("no grammar at all leaves the text whole", () => {
    expect(tokenize("anything at all", null)).toEqual([{ kind: "plain", text: "anything at all" }]);
  });
});
