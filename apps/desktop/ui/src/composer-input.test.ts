import { describe, expect, test } from "bun:test";
import {
  attachmentProblem,
  commandOf,
  insertPick,
  MAX_ATTACHMENTS,
  matchCommands,
  nextAgent,
  promptParts,
  toAttachment,
  triggerAt,
} from "./composer-input";

describe("what the caret is typing", () => {
  test("an @ at a word start opens files, anywhere in the draft", () => {
    expect(triggerAt("look at @src/a", 14)).toEqual({ kind: "file", query: "src/a", start: 8, end: 14 });
    expect(triggerAt("@", 1)).toEqual({ kind: "file", query: "", start: 0, end: 1 });
    expect(triggerAt("mail me@x.com", 13)).toBeUndefined();
    expect(triggerAt("@a b", 4)).toBeUndefined();
  });

  test("an @ after punctuation, CJK or a line break opens files too", () => {
    expect(triggerAt("(@sr", 4)).toEqual({ kind: "file", query: "sr", start: 1, end: 4 });
    expect(triggerAt("请看@sr", 5)).toEqual({ kind: "file", query: "sr", start: 2, end: 5 });
    expect(triggerAt("line\n@sr", 8)).toEqual({ kind: "file", query: "sr", start: 5, end: 8 });
    expect(triggerAt("@node_modules/@ty", 17)).toEqual({ kind: "file", query: "node_modules/@ty", start: 0, end: 17 });
  });

  test("a / opens commands only as the draft's first word", () => {
    expect(triggerAt("/in", 3)).toEqual({ kind: "command", query: "in", start: 0, end: 3 });
    expect(triggerAt("/init now", 9)).toBeUndefined();
    expect(triggerAt("a /b", 4)).toBeUndefined();
  });
});

describe("taking a suggestion", () => {
  test("replaces the whole word under the caret and leaves one space", () => {
    expect(insertPick("see @RE", { kind: "file", query: "RE", start: 4, end: 7 }, "README.md")).toEqual({
      text: "see @README.md ",
      caret: 15,
    });
    expect(insertPick("@REnope tail", { kind: "file", query: "RE", start: 0, end: 3 }, "README.md")).toEqual({
      text: "@README.md tail",
      caret: 11,
    });
    expect(insertPick("/in", { kind: "command", query: "in", start: 0, end: 3 }, "init")).toEqual({
      text: "/init ",
      caret: 6,
    });
  });

  test("keeps a line break or wide space after the word", () => {
    expect(insertPick("@RE\nnext line", { kind: "file", query: "RE", start: 0, end: 3 }, "README.md")).toEqual({
      text: "@README.md \nnext line",
      caret: 11,
    });
    expect(insertPick("@RE\u3000x", { kind: "file", query: "RE", start: 0, end: 3 }, "README.md")).toEqual({
      text: "@README.md \u3000x",
      caret: 11,
    });
  });

  test("leaves closing punctuation after the caret where it was", () => {
    expect(insertPick("(@sr)", { kind: "file", query: "sr", start: 1, end: 4 }, "src/a.ts")).toEqual({
      text: "(@src/a.ts)",
      caret: 10,
    });
    expect(insertPick("看@sr，然后", { kind: "file", query: "sr", start: 1, end: 4 }, "src/a.ts")).toEqual({
      text: "看@src/a.ts，然后",
      caret: 10,
    });
    expect(insertPick("@sr.ts x", { kind: "file", query: "sr", start: 0, end: 3 }, "src/a.ts")).toEqual({
      text: "@src/a.ts x",
      caret: 10,
    });
    expect(insertPick("@sr x", { kind: "file", query: "sr", start: 0, end: 3 }, "src/a.ts")).toEqual({
      text: "@src/a.ts x",
      caret: 10,
    });
  });
});

describe("what goes out", () => {
  test("words, then the files the draft still mentions, then attachments", () => {
    const shot = { id: "1", name: "s.png", mime: "image/png", url: "data:image/png;base64,AA==" };
    expect(promptParts("  @a.ts vs @b.ts  ", ["a.ts", "b.ts", "gone.ts"], [shot])).toEqual([
      { type: "text", text: "@a.ts vs @b.ts" },
      { type: "file_ref", path: "a.ts", mention: { start: 0, end: 5 } },
      { type: "file_ref", path: "b.ts", mention: { start: 9, end: 14 } },
      { type: "attachment", mime: "image/png", url: "data:image/png;base64,AA==", filename: "s.png" },
    ]);
    expect(promptParts("@a.tsx", ["a.ts"], [])).toEqual([{ type: "text", text: "@a.tsx" }]);
    expect(promptParts("", [], [shot])).toEqual([
      { type: "attachment", mime: "image/png", url: "data:image/png;base64,AA==", filename: "s.png" },
    ]);
  });

  test("a mention ends at punctuation or CJK and starts after anything but an address", () => {
    const ref = (draft: string) => promptParts(draft, ["a.ts"], []).filter((p) => p.type === "file_ref");
    expect(ref("look at @a.ts, ok")).toEqual([{ type: "file_ref", path: "a.ts", mention: { start: 8, end: 13 } }]);
    expect(ref("check @a.ts.")).toEqual([{ type: "file_ref", path: "a.ts", mention: { start: 6, end: 11 } }]);
    expect(ref("(@a.ts)")).toEqual([{ type: "file_ref", path: "a.ts", mention: { start: 1, end: 6 } }]);
    expect(ref("@a.ts的内容")).toEqual([{ type: "file_ref", path: "a.ts", mention: { start: 0, end: 5 } }]);
    expect(ref("请看@a.ts")).toEqual([{ type: "file_ref", path: "a.ts", mention: { start: 2, end: 7 } }]);
    expect(ref("see @a.ts。")).toEqual([{ type: "file_ref", path: "a.ts", mention: { start: 4, end: 9 } }]);
    expect(ref("@a.ts.bak")).toEqual([]);
    expect(ref("x@a.ts")).toEqual([]);
  });

  test("a draft naming a listed command runs it with the rest as arguments", () => {
    expect(commandOf("/init  be brief ", ["init", "review"])).toEqual({ name: "init", args: "be brief" });
    expect(commandOf("/init", ["init"])).toEqual({ name: "init", args: "" });
    expect(commandOf("/nope x", ["init"])).toBeUndefined();
    expect(commandOf("say /init", ["init"])).toBeUndefined();
  });

  test("commands that start with the query come first", () => {
    const list = [{ name: "review" }, { name: "init" }, { name: "mcp-search:web" }, { name: "customize-opencode" }];
    expect(matchCommands(list, "i").map((c) => c.name)).toEqual(["init", "review", "customize-opencode"]);
    expect(matchCommands(list, "").map((c) => c.name)).toEqual(["review", "init", "mcp-search:web", "customize-opencode"]);
  });
});

describe("tab through agents", () => {
  test("wraps both ways and starts from the ends when nothing is picked", () => {
    expect(nextAgent(["build", "plan"], "build", 1)).toBe("plan");
    expect(nextAgent(["build", "plan"], "plan", 1)).toBe("build");
    expect(nextAgent(["build", "plan"], "build", -1)).toBe("plan");
    expect(nextAgent(["build", "plan"], "", 1)).toBe("build");
    expect(nextAgent(["build", "plan"], "", -1)).toBe("plan");
    expect(nextAgent([], "", 1)).toBeUndefined();
  });
});

describe("attachments", () => {
  test("only images and PDFs up to 5 MB", () => {
    expect(attachmentProblem({ type: "image/png", size: 10 })).toBeUndefined();
    expect(attachmentProblem({ type: "application/pdf", size: 10 })).toBeUndefined();
    expect(attachmentProblem({ type: "text/plain", size: 10 })).toBe("type");
    expect(attachmentProblem({ type: "image/png", size: 5 * 1024 * 1024 })).toBeUndefined();
    expect(attachmentProblem({ type: "image/png", size: 5 * 1024 * 1024 + 1 })).toBe("size");
    expect(MAX_ATTACHMENTS).toBe(10);
  });

  test("a file becomes a data URL of its own type", async () => {
    const a = await toAttachment(new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }), "k");
    expect(a).toEqual({ id: "k", name: "x.png", mime: "image/png", url: "data:image/png;base64,AQID" });
  });

  test("a file larger than one chunk encodes whole", async () => {
    const bytes = new Uint8Array(0x8000 + 1).map((_, i) => (i * 7) % 256);
    const a = await toAttachment(new File([bytes], "big.pdf", { type: "application/pdf" }), "k");
    expect(a.url).toBe(`data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`);
  });

  test("a file without a type is refused", async () => {
    await expect(toAttachment(new File([new Uint8Array([1])], "x"), "k")).rejects.toThrow();
  });
});
