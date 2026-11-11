import { expect } from "bun:test";
import type { Event } from "@opencode-ai/sdk/v2";
import { projectSession } from "@agent-strata/projector";
import type { EventInput } from "@agent-strata/schema";
import type { openStore } from "@agent-strata/store";
import { snapshotEvents } from "../src/index";

export const sid = "ses_1";

// A real frame id is unique per emission — two `message.updated` for one
// message still arrive as two frames. Test helpers mint theirs the same way,
// so the mapper's re-delivery dedup sees only actual copies.
let evtSeq = 0;
export const freshId = (hint: string) => `${hint}-${evtSeq++}`;

export const sessionCreated = (): Event =>
  ({
    id: freshId("e"),
    type: "session.created",
    properties: {
      sessionID: sid,
      info: { id: sid, directory: "/repo", title: "T", time: { created: 1, updated: 1 } },
    },
  }) as unknown as Event;

export const msgUpdated = (info: object): Event =>
  ({ id: freshId(`m-${(info as {id:string}).id}`), type: "message.updated", properties: { sessionID: sid, info } }) as unknown as Event;

export const partUpdated = (part: object): Event =>
  ({ id: freshId(`p-${(part as {id:string}).id}`), type: "message.part.updated", properties: { sessionID: sid, part, time: 0 } }) as unknown as Event;

export const basicFixture = (): Event[] => [
  sessionCreated(),
  msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }),
  partUpdated({ id: "pt1", sessionID: sid, messageID: "u1", type: "text", text: "hello", time: { start: 10 } }),
  msgUpdated({
    id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
    time: { created: 20 }, providerID: "anthropic", modelID: "claude", agent: "build",
    mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }),
  partUpdated({ id: "pt2", sessionID: sid, messageID: "a1", type: "reasoning", text: "hmm", time: { start: 20 } }),
  partUpdated({ id: "pt3", sessionID: sid, messageID: "a1", type: "text", text: "answer" }),
  partUpdated({
    id: "pt4", sessionID: sid, messageID: "a1", type: "tool", callID: "call1", tool: "bash",
    state: { status: "running", input: { command: "ls" }, time: { start: 21 } },
  }),
  partUpdated({
    id: "pt4", sessionID: sid, messageID: "a1", type: "tool", callID: "call1", tool: "bash",
    state: { status: "completed", input: { command: "ls" }, output: "files", title: "ls", metadata: {}, time: { start: 21, end: 31 } },
  }),
  msgUpdated({
    id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
    time: { created: 20, completed: 50 }, providerID: "anthropic", modelID: "claude", agent: "build",
    mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0.25, finish: "stop", variant: "high",
    tokens: { input: 100, output: 40, reasoning: 5, cache: { read: 3, write: 2 } },
  }),
  {
    id: "t1",
    type: "todo.updated",
    properties: { sessionID: sid, todos: [{ content: "a", status: "pending", priority: "high" }] },
  } as unknown as Event,
  {
    id: "pa",
    type: "permission.asked",
    properties: {
      id: "perm1", sessionID: sid, permission: "bash",
      patterns: ["ls"], metadata: {}, always: [],
      tool: { messageID: "a1", callID: "call1" },
    },
  } as unknown as Event,
  {
    id: "pr",
    type: "permission.replied",
    properties: { sessionID: sid, requestID: "perm1", reply: "once" },
  } as unknown as Event,
];

// OpenCode's stored record of a session, as GET /session/:id and /session/:id/message return it
export const snapshotFixture = (): Event[] => {
  const info = { id: sid, directory: "/repo", title: "T", time: { created: 1, updated: 2 } };
  const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
  const messages = [
    {
      info: { id: "u1", sessionID: sid, role: "user", time: { created: 10 } },
      parts: [{ id: "pt1", sessionID: sid, messageID: "u1", type: "text", text: "hello" }],
    },
    {
      info: {
        id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
        time: { created: 20, completed: 50 }, providerID: "p", modelID: "m", cost: 0.1, tokens, finish: "stop",
      },
      parts: [
        { id: "pt2", sessionID: sid, messageID: "a1", type: "text", text: "answer" },
        {
          id: "pt3", sessionID: sid, messageID: "a1", type: "tool", callID: "call1", tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "files", title: "ls", metadata: {}, time: { start: 21, end: 31 } },
        },
      ],
    },
    {
      info: {
        id: "a2", sessionID: sid, role: "assistant", parentID: "u1",
        time: { created: 60 }, providerID: "p", modelID: "m", cost: 0, tokens,
      },
      parts: [{ id: "pt4", sessionID: sid, messageID: "a2", type: "text", text: "still writ" }],
    },
  ];
  return snapshotEvents(sid, info, messages as never);
};

export function recordingSink() {
  const appended: EventInput[] = [];
  const published: EventInput[] = [];
  return {
    appended,
    published,
    sink: {
      append: (events: EventInput[]) => appended.push(...events),
      publish: (events: EventInput[]) => published.push(...events),
    },
  };
}

export function waitForEvent(
  onEvent: (cb: (evt: Event) => void) => void,
  predicate: (evt: Event) => boolean,
  description: string,
  timeoutMs = 120_000,
) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${description} within ${timeoutMs}ms`)), timeoutMs);
    onEvent((evt) => {
      if (!predicate(evt)) return;
      clearTimeout(timer);
      resolve();
    });
  });
}

export function waitForIdle(
  sessionID: string,
  onEvent: (cb: (evt: Event) => void) => void,
  timeoutMs = 120_000,
) {
  return waitForEvent(onEvent, (evt) => {
    const props = evt.properties as { sessionID?: string; status?: { type: string } };
    if (props.sessionID !== sessionID) return false;
    return evt.type === "session.idle" || (evt.type === "session.status" && props.status?.type === "idle");
  }, `session ${sessionID} did not reach idle`, timeoutMs);
}

export function expectAllowPath(evs: ReturnType<ReturnType<typeof openStore>["read"]>) {
  expect(evs[0]?.type).toBe("session.started");
  expect(JSON.stringify(evs.find((e) => e.type === "turn.user")!.data)).toContain(
    "echo agent-strata-e2e",
  );
  expect(evs.some((e) => e.type === "permission.requested")).toBe(true);
  const res = evs.find((e) => e.type === "permission.resolved")!;
  expect((res.data as { decision: string }).decision).toBe("allow");
  const tc = evs.find((e) => e.type === "tool.call")!;
  expect((tc.data as { tool: string }).tool).toBe("bash");
  const tr = evs.find((e) => e.type === "tool.result")!;
  const trd = tr.data as { status: string; output?: string };
  expect(trd.status).toBe("ok");
  expect(trd.output).toContain("agent-strata-e2e");
  const assistants = evs.filter((e) => e.type === "turn.assistant");
  expect(assistants.length).toBeGreaterThanOrEqual(2);
  const last = assistants.at(-1)!.data as {
    model?: string;
    stop_reason?: string;
    usage?: { input: number; output: number; cache_read?: number };
    content?: { type: string; text?: string }[];
  };
  expect(last.model).toBe("deepseek/deepseek-flash");
  expect(last.stop_reason).not.toBe("tool-calls");
  expect(
    (last.content ?? []).some((b) => b.type === "text" && b.text?.includes("agent-strata-e2e")),
  ).toBe(true);
  expect(
    assistants.some(
      (e) =>
        ((e.data as { usage?: { cache_read?: number } }).usage?.cache_read ?? 0) > 0,
    ),
  ).toBe(true);

  const view = projectSession(evs);
  const pending = [...view.turns.flatMap((t) => t.tool_calls), ...view.orphans].filter(
    (c) => c.status === "pending",
  );
  expect(pending.length).toBe(0);
  expect(view.totals.input).toBeGreaterThan(0);
  expect(view.totals.output).toBeGreaterThan(0);
  expect(view.totals.tool_calls).toBeGreaterThan(0);
  expect(view.totals.cost_usd).toBeGreaterThan(0);
}
