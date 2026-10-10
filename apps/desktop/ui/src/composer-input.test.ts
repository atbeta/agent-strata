import { describe, expect, test } from "bun:test";
import {
  attachmentProblem,
  commandOf,
  insertPick,
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
    expect(promptParts("", [], [shot])).toHaveLength(1);
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
    expect(attachmentProblem({ type: "image/png", size: 5 * 1024 * 1024 + 1 })).toBe("size");
  });

  test("a file becomes a data URL of its own type", async () => {
    const a = await toAttachment(new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }), "k");
    expect(a).toEqual({ id: "k", name: "x.png", mime: "image/png", url: "data:image/png;base64,AQID" });
  });
});
