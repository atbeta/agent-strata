import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attachmentProblem,
  builtinCommands,
  handoffTargets,
  resolveHandoff,
  commandOf,
  commandParts,
  slashMenuEnter,
  slashRowSelect,
  insertPick,
  MAX_ATTACHMENTS,
  matchCommands,
  nextAgent,
  stepAgent,
  promptParts,
  explainSend,
  restoreFailed,
  toAttachment,
  triggerAt,
  COMPOSER_MAX_HEIGHT,
  composerResize,
  composerValueWrite,
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
    expect(commandOf("/Compact", ["compact"])).toEqual({ name: "compact", args: "" });
  });

  test("a command takes the files the draft still mentions, without mentions, and the attachments", () => {
    const shot = { id: "1", name: "s.png", mime: "image/png", url: "data:image/png;base64,AA==" };
    expect(commandParts("/review @a.ts and @b.ts", ["a.ts", "gone.ts"], [shot])).toEqual([
      { type: "file_ref", path: "a.ts" },
      { type: "attachment", mime: "image/png", url: "data:image/png;base64,AA==", filename: "s.png" },
    ]);
    expect(commandParts("/init", [], [])).toEqual([]);
  });

  test("commands that start with the query come first", () => {
    const list = [{ name: "review" }, { name: "init" }, { name: "mcp-search:web" }, { name: "customize-opencode" }];
    expect(matchCommands(list, "i").map((c) => c.name)).toEqual(["init", "review", "customize-opencode"]);
    expect(matchCommands(list, "").map((c) => c.name)).toEqual(["review", "init", "mcp-search:web", "customize-opencode"]);
  });

  test("built-in commands follow what the session can do", () => {
    expect(builtinCommands({})).toEqual(["export", "new"]);
    expect(
      builtinCommands({ summarize: true, revert: true, abort: true, fork: true, hasTurns: true, manage: true, share: true, terminal: true }),
    ).toEqual(["compact", "summarize", "undo", "interrupt", "fork", "rename", "share", "unshare", "terminal", "export", "new"]);
  });

  test("redo waits for a reverted state and fork waits for a turn", () => {
    expect(builtinCommands({ revert: true })).toEqual(["undo", "export", "new"]);
    expect(builtinCommands({ revert: true, reverted: true })).toEqual(["undo", "redo", "export", "new"]);
    expect(builtinCommands({ fork: true })).toEqual(["export", "new"]);
    expect(builtinCommands({ fork: true, hasTurns: true })).toEqual(["fork", "export", "new"]);
    expect(builtinCommands({ handoff: true })).toEqual(["handoff", "export", "new"]);
  });
});

describe("who can receive a handoff", () => {
  const codex = { id: "acp:codex:1", label: "Codex", detail: "acp://codex", prompt: true };
  const opencode = { id: "opencode:http://127.0.0.1:4096", label: "OpenCode", detail: "http://127.0.0.1:4096", prompt: true };

  test("drops the backend that already runs the session, and one that cannot prompt", () => {
    expect(handoffTargets([codex, opencode, { ...opencode, id: "dead", prompt: false }], opencode.id)).toEqual([
      { id: codex.id, label: "Codex" },
    ]);
  });

  test("two backends with the same name keep the address", () => {
    const other = { ...codex, id: "acp:codex:2", detail: "acp://codex --other" };
    expect(handoffTargets([codex, other], undefined).map((t) => t.label)).toEqual([
      "Codex acp://codex",
      "Codex acp://codex --other",
    ]);
  });

  test("an empty argument means the only backend, and a name picks one of several", () => {
    const targets = handoffTargets([codex, opencode], undefined);
    expect(resolveHandoff(targets, "")).toBeUndefined();
    expect(resolveHandoff([targets[0]!], "")).toEqual(targets[0]);
    expect(resolveHandoff(targets, "codex")?.id).toBe(codex.id);
    expect(resolveHandoff(targets, "nope")).toBeUndefined();
  });
});

describe("enter on a slash command", () => {
  const commands = [
    { name: "compact", source: "builtin" as const },
    { name: "summarize", source: "builtin" as const },
    { name: "rename", source: "builtin" as const },
    { name: "export", source: "builtin" as const },
    { name: "init", source: "command" as const },
  ];

  test("a finished /compact runs, whichever row is highlighted", () => {
    expect(slashMenuEnter({ draft: "/compact", highlighted: "export", commands })).toEqual({
      action: "run",
      name: "compact",
      args: "",
    });
    expect(slashMenuEnter({ draft: "/Compact", highlighted: "compact", commands })).toEqual({
      action: "run",
      name: "compact",
      args: "",
    });
    expect(slashMenuEnter({ draft: "/summarize", commands })).toEqual({
      action: "run",
      name: "summarize",
      args: "",
    });
  });

  test("enter on the highlighted no-argument command runs it before the name is finished", () => {
    expect(slashMenuEnter({ draft: "/comp", highlighted: "compact", commands })).toEqual({
      action: "run",
      name: "compact",
      args: "",
    });
  });

  test("a command that still wants words is completed, and a finished server command runs", () => {
    expect(slashMenuEnter({ draft: "/in", highlighted: "init", commands })).toEqual({
      action: "insert",
      name: "init",
    });
    expect(slashMenuEnter({ draft: "/init", highlighted: "export", commands })).toEqual({
      action: "run",
      name: "init",
      args: "",
    });
    expect(slashMenuEnter({ draft: "/init be brief", highlighted: "export", commands })).toEqual({
      action: "run",
      name: "init",
      args: "be brief",
    });
    expect(slashMenuEnter({ draft: "/rename", highlighted: "rename", commands })).toEqual({
      action: "insert",
      name: "rename",
    });
    expect(slashMenuEnter({ draft: "/rename Notes", highlighted: "export", commands })).toEqual({
      action: "run",
      name: "rename",
      args: "Notes",
    });
    const handoff = [{ name: "handoff", source: "builtin" as const, argument: true }];
    expect(slashMenuEnter({ draft: "/handoff", commands: handoff })).toEqual({ action: "insert", name: "handoff" });
    expect(slashMenuEnter({ draft: "/handoff Codex", commands: handoff })).toEqual({
      action: "run",
      name: "handoff",
      args: "Codex",
    });
  });

  test("an unknown line is a normal prompt, and choosing a row follows the same rule", () => {
    expect(slashMenuEnter({ draft: "/nope", commands })).toEqual({ action: "prompt" });
    expect(slashRowSelect({ name: "compact", commands })).toEqual({ action: "run", name: "compact", args: "" });
    expect(slashRowSelect({ name: "init", commands })).toEqual({ action: "insert", name: "init" });
    expect(slashRowSelect({ name: "rename", commands })).toEqual({ action: "insert", name: "rename" });
  });

  test("the composer asks that decision on enter", () => {
    const src = readFileSync(join(import.meta.dir, "session-composer.tsx"), "utf8");
    expect(src).toContain("slashMenuEnter(");
    expect(src).not.toContain('menuItems()[menuActive()]?.value === tr.query');
  });
});

describe("a send that failed", () => {
  test("a refusal that must not repeat the draft becomes the fallback", () => {
    expect(explainSend("Error: prompt was not accepted", "kept")).toBe("kept");
    expect(explainSend("", "kept")).toBe("kept");
    expect(explainSend("Error: session not found", "kept")).toBe("session not found");
  });

  const shot = (i: number) => ({ id: String(i), name: `s${i}.png`, mime: "image/png", url: "data:image/png;base64,AA==" });
  const out = (text: string, picked: string[] = [], attachments: ReturnType<typeof shot>[] = []) => ({ text, picked, attachments });

  test("comes back as the draft when nothing was typed since", () => {
    expect(restoreFailed(out("@a.ts fix", ["a.ts"], [shot(1)]), out(""))).toEqual({
      draft: out("@a.ts fix", ["a.ts"], [shot(1)]),
      dropped: 0,
    });
    expect(restoreFailed(out("lost"), out("  \n "))).toEqual({ draft: out("lost"), dropped: 0 });
  });

  test("goes in front of what was typed since, keeping both", () => {
    expect(restoreFailed(out("first @a.ts", ["a.ts", "b.ts"], [shot(1)]), out("then @b.ts", ["b.ts"], [shot(2)]))).toEqual({
      draft: out("first @a.ts\nthen @b.ts", ["a.ts", "b.ts"], [shot(1), shot(2)]),
      dropped: 0,
    });
    expect(restoreFailed(out("", [], [shot(1)]), out("typed")).draft.text).toBe("typed");
  });

  test("keeps no more attachments than a prompt can carry", () => {
    const failed = Array.from({ length: 7 }, (_, i) => shot(i));
    const typed = Array.from({ length: 5 }, (_, i) => shot(10 + i));
    const r = restoreFailed(out("x", [], failed), out("y", [], typed));
    expect(r.draft.attachments).toEqual([...failed, ...typed.slice(0, 3)]);
    expect(r.dropped).toBe(2);
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

  /**
   * The composer binds Tab to this while there is somewhere to step to. Once
   * there is not, it has to answer undefined so the key reaches the browser:
   * a wrapping step here is what made the input a focus trap.
   */
  test("stops at the ends so Tab can leave the composer", () => {
    expect(stepAgent(["build", "plan"], "build", 1)).toBe("plan");
    expect(stepAgent(["build", "plan"], "plan", -1)).toBe("build");
    expect(stepAgent(["build", "plan"], "plan", 1)).toBeUndefined();
    expect(stepAgent(["build", "plan"], "build", -1)).toBeUndefined();
    expect(stepAgent(["only"], "only", 1)).toBeUndefined();
    expect(stepAgent(["only"], "only", -1)).toBeUndefined();
    expect(stepAgent([], "", 1)).toBeUndefined();
  });

  test("starts from the ends when nothing is picked", () => {
    expect(stepAgent(["build", "plan"], "", 1)).toBe("build");
    expect(stepAgent(["build", "plan"], "", -1)).toBe("plan");
  });
});

describe("attachments", () => {
  test("any file up to 5 MB", () => {
    expect(attachmentProblem({ type: "image/png", size: 10 })).toBeUndefined();
    expect(attachmentProblem({ type: "application/pdf", size: 10 })).toBeUndefined();
    // Not a guess at what a model can read: OpenCode passes a file part
    // through whatever its type, and the model decides what to make of it.
    expect(attachmentProblem({ type: "text/plain", size: 10 })).toBeUndefined();
    expect(attachmentProblem({ type: "application/typescript", size: 10 })).toBeUndefined();
    expect(attachmentProblem({ type: "", size: 10 })).toBeUndefined();
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

  test("a file the OS has no type for still goes, as octet-stream", async () => {
    // `.ts`, `.gitignore`, an extension no handler is registered for: refusing
    // these was refusing on the strength of the desktop's icon table.
    const a = await toAttachment(new File([new Uint8Array([1, 2, 3])], "x.ts"), "k");
    expect(a.mime).toBe("application/octet-stream");
    expect(a.url).toBe("data:application/octet-stream;base64,AQID");
  });
});

describe("composer field while typing", () => {
  test("a key that still fits does not resize the box", () => {
    expect(composerResize({ scrollHeight: 40, clientHeight: 40, textShrunk: false, singleLine: false })).toEqual({
      action: "keep",
    });
    expect(composerResize({ scrollHeight: 41, clientHeight: 40, textShrunk: false, singleLine: false })).toEqual({
      action: "keep",
    });
  });

  test("a wrapped line grows to the content, and stops at the cap", () => {
    expect(composerResize({ scrollHeight: 72, clientHeight: 40, textShrunk: false, singleLine: false })).toEqual({
      action: "grow",
      height: 72,
    });
    expect(composerResize({ scrollHeight: 400, clientHeight: 180, textShrunk: false, singleLine: false })).toEqual({
      action: "grow",
      height: COMPOSER_MAX_HEIGHT,
    });
    expect(composerResize({ scrollHeight: 400, clientHeight: COMPOSER_MAX_HEIGHT, textShrunk: false, singleLine: false })).toEqual({
      action: "keep",
    });
  });

  test("backspace on one line stays put, and a shorter wrapped draft is remeasured", () => {
    expect(composerResize({ scrollHeight: 40, clientHeight: 40, textShrunk: true, singleLine: true })).toEqual({
      action: "keep",
    });
    expect(composerResize({ scrollHeight: 80, clientHeight: 80, textShrunk: true, singleLine: false })).toEqual({
      action: "measure",
    });
  });

  test("a hidden box is left alone", () => {
    expect(composerResize({ scrollHeight: 40, clientHeight: 0, textShrunk: true, singleLine: false })).toEqual({
      action: "keep",
    });
  });

  test("the field is written only when the draft arrived from outside an IME composition", () => {
    expect(composerValueWrite({ composing: true, domValue: "你", draft: "你好" })).toBe(false);
    expect(composerValueWrite({ composing: false, domValue: "你好", draft: "你好" })).toBe(false);
    expect(composerValueWrite({ composing: false, domValue: "旧的", draft: "编辑回来的" })).toBe(true);
  });

  test("the textarea is not a controlled value, and growth goes through composerResize", () => {
    const src = readFileSync(join(import.meta.dir, "session-composer.tsx"), "utf8");
    expect(src.includes("value={c().draft()}")).toBe(false);
    expect(src.includes("composerResize")).toBe(true);
    expect(src.includes("composerValueWrite")).toBe(true);
  });
});
