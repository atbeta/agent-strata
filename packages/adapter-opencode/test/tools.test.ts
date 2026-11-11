import { describe, expect, test } from "bun:test";
import {
  OpencodeMapper,
} from "../src/index";
import type { Event } from "@opencode-ai/sdk/v2";
import { openStore } from "@agent-strata/store";
import { type ContentBlock } from "@agent-strata/schema";
import { sid, sessionCreated, msgUpdated, partUpdated } from "./helpers";

describe("OpencodeMapper", () => {
  test("a completed tool's attachments ride its result; a huge data payload stays a reference", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    m.handle(
      msgUpdated({
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
        time: { created: 20 }, providerID: "p", modelID: "m", agent: "build", mode: "build",
        path: { cwd: "/repo", root: "/repo" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    const huge = `data:image/png;base64,${"A".repeat(1_100_000)}`;
    const out = m.handle(
      partUpdated({
        id: "pt8", sessionID: sid, messageID: "a1", type: "tool", callID: "c1", tool: "browser",
        state: {
          status: "completed", input: { url: "https://x" }, output: "ok", title: "browser",
          metadata: {}, time: { start: 21, end: 31 },
          attachments: [
            {
              id: "att1", sessionID: sid, messageID: "a1", type: "file",
              mime: "image/png", filename: "shot.png",
              url: "data:image/png;base64,c2hvdA==",
            },
            {
              id: "att2", sessionID: sid, messageID: "a1", type: "file",
              mime: "image/png", filename: "big.png", url: huge,
            },
            {
              id: "att3", sessionID: sid, messageID: "a1", type: "file",
              mime: "image/png", filename: "remote.png", url: "https://x/r.png",
            },
          ],
        },
      }),
    );
    const tr = out.find((e) => e.type === "tool.result")!;
    const d = tr.data as { attachments?: ContentBlock[] };
    expect(d.attachments).toEqual([
      // Small inline image keeps its bytes; a megabyte-plus payload keeps only
      // its name; a remote URL never inlines — the CSP only draws data:/blob:.
      { type: "image", mime: "image/png", data: "c2hvdA==" },
      { type: "file_ref", path: "big.png", mime: "image/png" },
      { type: "file_ref", path: "remote.png", mime: "image/png" },
    ]);
  });

  test("a screenshot too big to inline keeps a way back to its bytes", () => {
    // A Playwright screenshot is routinely past the inline cap, and dropping
    // its bytes left a filename and nothing to look at — the one thing a
    // screenshot is for. The sink is handed the bytes and the block keeps the
    // id it returns.
    const spilled: { mime: string; base64: string }[] = [];
    const m = new OpencodeMapper({
      spill: (mime, base64) => {
        spilled.push({ mime, base64 });
        return "abc123.png";
      },
    });
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    m.handle(
      msgUpdated({
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
        time: { created: 20 }, providerID: "p", modelID: "m", agent: "build", mode: "build",
        path: { cwd: "/repo", root: "/repo" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    const out = m.handle(
      partUpdated({
        id: "pt9", sessionID: sid, messageID: "a1", type: "tool", callID: "c1", tool: "browser",
        state: {
          status: "completed", input: { url: "https://x" }, output: "ok", title: "browser",
          metadata: {}, time: { start: 21, end: 31 },
          attachments: [{
            id: "att1", sessionID: sid, messageID: "a1", type: "file",
            mime: "image/png", filename: "shot.png",
            url: `data:image/png;base64,${"B".repeat(1_100_000)}`,
          }],
        },
      }),
    );
    const d = out.find((e) => e.type === "tool.result")!.data as { attachments?: ContentBlock[] };
    expect(d.attachments).toEqual([
      { type: "file_ref", path: "shot.png", mime: "image/png", attachment: "abc123.png" },
    ]);
    // The bytes actually reached the sink, not just the reference.
    expect(spilled).toHaveLength(1);
    expect(spilled[0]!.mime).toBe("image/png");
    expect(spilled[0]!.base64.startsWith("BBBB")).toBe(true);
  });

  test("without a sink the block degrades to what it was before", () => {
    // An adapter wired to something that cannot store bytes must not lose the
    // reference: the transcript still says a screenshot was taken.
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    m.handle(
      msgUpdated({
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
        time: { created: 20 }, providerID: "p", modelID: "m", agent: "build", mode: "build",
        path: { cwd: "/repo", root: "/repo" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    const out = m.handle(
      partUpdated({
        id: "pt10", sessionID: sid, messageID: "a1", type: "tool", callID: "c1", tool: "browser",
        state: {
          status: "completed", input: {}, output: "ok", title: "browser",
          metadata: {}, time: { start: 21, end: 31 },
          attachments: [{
            id: "att1", sessionID: sid, messageID: "a1", type: "file",
            mime: "image/png", filename: "shot.png",
            url: `data:image/png;base64,${"B".repeat(1_100_000)}`,
          }],
        },
      }),
    );
    const d = out.find((e) => e.type === "tool.result")!.data as { attachments?: ContentBlock[] };
    expect(d.attachments).toEqual([{ type: "file_ref", path: "shot.png", mime: "image/png" }]);
  });


  test("todo.updated -> plan.updated drops unknown statuses; patch -> file.changed", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const out = m.handle({
      id: "t",
      type: "todo.updated",
      properties: {
        sessionID: sid,
        todos: [
          { content: "a", status: "pending", priority: "high" },
          { content: "b", status: "cancelled", priority: "low" },
          { content: "c", status: "completed", priority: "low" },
        ],
      },
    } as unknown as Event);
    expect((out[0]!.data as { entries: object[] }).entries).toEqual([
      { content: "a", status: "pending" },
      { content: "c", status: "completed" },
    ]);
    const fc = m.handle(partUpdated({
      id: "pp", sessionID: sid, messageID: "a1", type: "patch", hash: "h", files: ["x.ts", "y.ts"],
    }));
    expect(fc.map((e) => [e.id, e.type])).toEqual([
      ["opencode:pp:file:x.ts", "file.changed"],
      ["opencode:pp:file:y.ts", "file.changed"],
    ]);
  });

  test("a file change is stamped when it happened, not when we connected", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 1_700_000_000_000, completed: 1_700_000_060_000 },
      providerID: "anthropic", modelID: "claude", agent: "build", mode: "build",
      path: { cwd: "/repo", root: "/repo" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    const fc = m.handle(partUpdated({
      id: "pp", sessionID: sid, messageID: "a1", type: "patch", hash: "h", files: ["x.ts"],
    }));
    // Without a source clock the store takes the ingest clock, so replaying a
    // session on every connect moved every file change to the connect moment
    // and the session list sorted by that.
    expect(fc[0]!.ts).toBe("2023-11-14T22:14:20.000Z");
  });

  test("a patch with no message time keeps the ingest clock rather than inventing one", () => {
    const store = openStore(":memory:");
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const fc = m.handle(partUpdated({
      id: "pp", sessionID: sid, messageID: "never-seen", type: "patch", hash: "h", files: ["x.ts"],
    }));
    // No source clock means no clock: the event says nothing about when it
    // happened. The write stamps it, and the store reads a clock on a
    // re-sent event as the source's own — a filled-in one here would rewrite
    // the stored timestamp with the moment of the re-send.
    expect(fc[0]!.ts).toBeUndefined();
    store.append(fc);
    const stored = store.read({ session_id: `opencode:${sid}` }).find((e) => e.type === "file.changed")!;
    expect(stored.ts).toBeTruthy();
    expect(Number.isNaN(Date.parse(stored.ts))).toBe(false);
    // and it must not be a made-up epoch either
    expect(Date.parse(stored.ts)).toBeGreaterThan(1_700_000_000_000);
    store.close();
  });


describe("file changes come from the call that made them", () => {
  const assistant = () =>
    msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  const patch = "Index: D:\\r\\x.ts\n===\n--- D:\\r\\x.ts\n+++ D:\\r\\x.ts\n@@ -1 +1 @@\n-a\n+b\n";

  test("an edit records OpenCode's own diff, and the patch part does not repeat it", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(assistant());
    const out = [
      m.handle(partUpdated({
        id: "pe", sessionID: sid, messageID: "a1", type: "tool", callID: "c-edit", tool: "edit",
        state: {
          status: "completed",
          input: { filePath: "D:\\r\\x.ts", oldString: "a", newString: "b" },
          output: "", title: "",
          metadata: { diff: patch, filediff: { file: "D:\\r\\x.ts", patch, additions: 1, deletions: 1 } },
          time: { start: 1, end: 2 },
        },
      })),
      m.handle(partUpdated({
        id: "pp", sessionID: sid, messageID: "a1", type: "patch", hash: "h", files: ["D:/r/x.ts", "D:/r/y.ts"],
      })),
    ].flat();
    const changes = out.filter((e) => e.type === "file.changed");
    expect(changes.map((e) => e.data)).toEqual([
      { path: "D:\\r\\x.ts", change: "modify", diff: patch, call_id: "c-edit" },
      { path: "D:/r/y.ts", change: "modify" },
    ]);
    expect(changes[0]!.id).toBe("opencode:pe:file");
  });

  test("a write records the whole file and says whether it is new", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(assistant());
    const out = m.handle(partUpdated({
      id: "pw", sessionID: sid, messageID: "a1", type: "tool", callID: "c-write", tool: "write",
      state: {
        status: "completed", input: { filePath: "/r/new.ts", content: "a\nb\n" }, output: "", title: "",
        metadata: { filepath: "/r/new.ts", exists: false }, time: { start: 1, end: 2 },
      },
    }));
    const change = out.find((e) => e.type === "file.changed")!;
    expect(change.data).toMatchObject({ path: "/r/new.ts", change: "add", whole_file: true, call_id: "c-write" });
    expect((change.data as { diff: string }).diff).toContain("+a");
  });

  test("a failed edit records no change", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(assistant());
    const out = m.handle(partUpdated({
      id: "pf", sessionID: sid, messageID: "a1", type: "tool", callID: "c-fail", tool: "edit",
      state: {
        status: "error", input: { filePath: "/r/x.ts", oldString: "a", newString: "b" },
        error: "oldString not found", time: { start: 1, end: 2 },
      },
    }));
    expect(out.some((e) => e.type === "file.changed")).toBe(false);
  });
});


describe("a task tool names the child session it opened", () => {
  const assistant = () =>
    msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });

  const toolPart = (
    id: string,
    callID: string,
    tool: string,
    state: object,
  ) =>
    partUpdated({
      id, sessionID: sid, messageID: "a1", type: "tool", callID, tool, state,
    });

  test("a child named one update after the call started still lands on it", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(assistant());
    const part = (metadata: object) =>
      toolPart("ptask2", "c-late", "task", {
        status: "running",
        input: { description: "explore the repo" },
        metadata,
        time: { start: 21 },
      });
    // The part runs before the subagent session exists, so this first update
    // has no id in it — which used to be the last chance to read one.
    const started = m.handle(part({ model: { modelID: "m", providerID: "p" } }));
    const first = started.find((e) => e.type === "tool.call")!;
    expect(first.data).not.toHaveProperty("child_session_id");

    const named = m.handle(part({ sessionId: "ses_kid" }));
    const restated = named.find((e) => e.type === "tool.call")!;
    expect(restated.data).toMatchObject({ call_id: "c-late", child_session_id: "opencode:ses_kid" });
    // A restatement the store keeps, and the projector folds into one call.
    expect(restated.id).not.toBe(first.id);

    const again = m.handle(part({ sessionId: "ses_kid" }));
    expect(again.filter((e) => e.type === "tool.call")).toHaveLength(0);
  });

  test("copies sessionId onto the call and the result, and leaves other tools alone", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(assistant());
    const meta = { sessionId: "ses_kid" };
    const running = m.handle(toolPart("ptask", "c-task", "task", {
      status: "running",
      input: { prompt: "go" },
      metadata: meta,
      time: { start: 21 },
    }));
    const completed = m.handle(toolPart("ptask", "c-task", "task", {
      status: "completed",
      input: { prompt: "go" },
      output: "done",
      title: "task",
      metadata: meta,
      time: { start: 21, end: 31 },
    }));
    const call = running.find((e) => e.type === "tool.call")!;
    const result = completed.find((e) => e.type === "tool.result")!;
    expect(call.data).toMatchObject({ child_session_id: "opencode:ses_kid" });
    expect(result.data).toMatchObject({ child_session_id: "opencode:ses_kid" });

    const bashRunning = m.handle(toolPart("pbash", "c-bash", "bash", {
      status: "running",
      input: { command: "ls" },
      metadata: meta,
      time: { start: 21 },
    }));
    const bashDone = m.handle(toolPart("pbash", "c-bash", "bash", {
      status: "completed",
      input: { command: "ls" },
      output: "files",
      title: "ls",
      metadata: meta,
      time: { start: 21, end: 31 },
    }));
    expect(bashRunning.find((e) => e.type === "tool.call")!.data).not.toHaveProperty("child_session_id");
    expect(bashDone.find((e) => e.type === "tool.result")!.data).not.toHaveProperty("child_session_id");
  });
});

});
