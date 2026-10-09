import { describe, expect, test } from "bun:test";
import { hasAnsi, stripAnsi } from "./ansi";
import { grammarFor, guessGrammar, tokenize, tokenizeDiff } from "./highlight";

/**
 * `structure` looks its strings up in `i18n`, which stamps
 * `document.documentElement.lang` while its module is evaluated — and the test
 * runtime has no DOM. The one property it touches is stood up here so the
 * dynamic import below resolves.
 */
const globals = globalThis as { document?: Document };
globals.document ??= { documentElement: {} } as Document;

const { asStructure, entriesOf, looksStructured, summaryOf } = await import("./structure");

describe("stripAnsi", () => {
  test("drops SGR colour codes but keeps the text between them", () => {
    expect(stripAnsi("\u001b[31;1mred\u001b[0m plain")).toBe("red plain");
  });

  test("drops OSC sequences whole", () => {
    expect(stripAnsi("\u001b]0;title\u0007body")).toBe("body");
  });

  test("drops the orphaned codes shell output arrives with", () => {
    // The ESC byte does not survive every hop between the shell and the drawer;
    // what is left is the parameter run, and that is what the reader saw.
    expect(stripAnsi("0m\u001b[31;1mC:\\x\u001b[0m> bun")).toBe("C:\\x> bun");
    expect(stripAnsi("[\u001b[31;1mred\u001b[0m")).toBe("[red");
  });

  test("leaves text that merely looks like a code alone", () => {
    expect(stripAnsi("took 120ms and 50m")).toBe("took 120ms and 50m");
    expect(stripAnsi("[link](http://x)")).toBe("[link](http://x)");
  });

  test("keeps tabs and newlines, which are the output's own formatting", () => {
    expect(stripAnsi("a\u001b[0m\tb\nc")).toBe("a\tb\nc");
  });

  test("is idempotent", () => {
    const once = stripAnsi("\u001b[32mok\u001b[0m");
    expect(stripAnsi(once)).toBe(once);
  });

  test("detection does not depend on call order", () => {
    // A /g regex keeps lastIndex between .test() calls, so a second call on the
    // same string used to answer false.
    const src = "\u001b[31mred\u001b[0m";
    expect(hasAnsi(src)).toBe(true);
    expect(hasAnsi(src)).toBe(true);
    expect(hasAnsi("plain")).toBe(false);
    expect(hasAnsi("plain")).toBe(false);
  });

  test("is stable across repeated strip calls", () => {
    const src = "\u001b[31;1mred\u001b[0m";
    expect(stripAnsi(src)).toBe(stripAnsi(src));
  });
});

describe("grammarFor", () => {
  test("maps fence labels onto grammars", () => {
    expect(grammarFor("json")).toBe("json");
    expect(grammarFor("TypeScript")).toBe("ts");
    expect(grammarFor("bash")).toBe("sh");
    expect(grammarFor("console")).toBe("sh");
    expect(grammarFor("python")).toBe("py");
  });

  test("returns null for labels it cannot serve", () => {
    expect(grammarFor(undefined)).toBeNull();
    expect(grammarFor("brainfuck")).toBeNull();
  });
});

describe("guessGrammar", () => {
  test("spots a JSON object", () => {
    expect(guessGrammar('{"name":"strata","port":7700}')).toBe("json");
  });

  test("spots a shell transcript", () => {
    expect(guessGrammar("$ bun run typecheck\nerror: x")).toBe("sh");
  });

  test("stays quiet on prose", () => {
    expect(guessGrammar("the session ended after three turns")).toBeNull();
    expect(guessGrammar("")).toBeNull();
  });
});

describe("tokenize", () => {
  const round = (src: string, grammar: Parameters<typeof tokenize>[1]) =>
    tokenize(src, grammar)
      .map((t) => t.text)
      .join("");

  test("never loses or duplicates a character", () => {
    // The highlighter must be transparent: the reader still gets the source.
    const samples = [
      'const a = "hi"; // note',
      '{"a":1,"b":[true,null,-2.5e3],"c":{"d":[]}}',
      "def f(x):\n  return f'{x} # not a comment'",
      "unterminated 'string",
      "/* block */ const x = 1;",
      "",
    ];
    for (const g of ["ts", "json", "py", "sh", null] as const) {
      for (const src of samples) expect(round(src, g)).toBe(src);
    }
  });

  test("does not swallow the rest of the file on an unterminated string", () => {
    const tokens = tokenize("oops 'open\nnext line", "ts");
    expect(tokens.map((t) => t.text).join("")).toContain("next line");
  });

  test("returns the input untouched with no grammar", () => {
    expect(tokenize("anything", null)).toEqual([{ kind: "plain", text: "anything" }]);
  });
});

describe("tokenizeDiff", () => {
  test("colours a unified diff", () => {
    const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-old", "+new", " keep"].join("\n");
    const tokens = tokenizeDiff(patch);
    expect(tokens).not.toBeNull();
    expect(tokens!.map((t) => t.text).join("")).toBe(patch);
    expect(tokens!.some((t) => t.kind === "del")).toBe(true);
    expect(tokens!.some((t) => t.kind === "add")).toBe(true);
  });

  test("ignores shell output that merely has a leading dash", () => {
    expect(tokenizeDiff("- item one\n- item two\nprogress")).toBeNull();
    expect(tokenizeDiff("plain output")).toBeNull();
  });
});

describe("structured payloads", () => {
  test("recognises a value that is already structured", () => {
    expect(looksStructured({ a: 1 })).toBe(true);
    expect(looksStructured([1, 2])).toBe(true);
  });

  test("recognises a string that parses as an object", () => {
    expect(looksStructured('{"call_id":"x"}')).toBe(true);
    expect(looksStructured('  \n{"call_id":"x"}')).toBe(true);
  });

  test("leaves prose and scalars alone", () => {
    expect(looksStructured("bun run typecheck")).toBe(false);
    expect(looksStructured("[not json")).toBe(false);
    expect(looksStructured("42")).toBe(false);
    expect(looksStructured(undefined)).toBe(false);
  });

  test("round-trips a JSON string back to its value", () => {
    expect(asStructure('{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(asStructure("not json")).toBe("not json");
  });

  test("lists object keys and array indices", () => {
    expect(entriesOf({ a: 1, b: 2 })).toEqual([["a", 1], ["b", 2]]);
    expect(entriesOf(["x", "y"])).toEqual([["0", "x"], ["1", "y"]]);
    expect(entriesOf("scalar")).toEqual([]);
  });

  test("sketches a collapsed container", () => {
    // A sketch stands in for the value, not for the interface, so it is JSON
    // in every language: `{a, b}`, never a translated brace.
    expect(summaryOf("array", ["0", "1", "2"])).toBe("[3]");
    expect(summaryOf("object", ["a", "b"])).toBe("{a, b}");
    expect(summaryOf("object", ["a", "b", "c", "d", "e"])).toBe("{a, b, c, d, …}");
    expect(summaryOf("object", [])).toBe("{}");
  });
});