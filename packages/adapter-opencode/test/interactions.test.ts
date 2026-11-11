import { describe, expect, test } from "bun:test";
import {
  OpencodeMapper,
} from "../src/index";
import type { Event } from "@opencode-ai/sdk/v2";
import { sid, sessionCreated } from "./helpers";

describe("OpencodeMapper", () => {
  test("question.asked maps options; idle emits session.status", () => {
    const m = new OpencodeMapper();
    const asked = m.handle({
      id: "q",
      type: "question.asked",
      properties: {
        id: "req1",
        sessionID: sid,
        questions: [
          {
            question: "Pick one",
            header: "Pick",
            options: [{ label: "a", description: "A" }],
            multiple: false,
          },
        ],
      },
    } as unknown as Event);
    expect(asked.some((e) => e.type === "session.started")).toBe(true);
    const q = asked.find((e) => e.type === "question.asked")!;
    expect(q.data).toMatchObject({
      request_id: "req1",
      questions: [{ header: "Pick", options: [{ label: "a", description: "A" }] }],
    });
    const idle = m.handle({
      id: "idle1",
      type: "session.idle",
      properties: { sessionID: sid },
    } as unknown as Event);
    expect(idle.find((e) => e.type === "session.status")!.data).toEqual({ state: "idle" });
  });


  test("permission.asked -> permission.requested; replied -> resolved with shared id", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const asked = m.handle({
      id: "pa",
      type: "permission.asked",
      properties: {
        id: "perm1", sessionID: sid, permission: "bash",
        patterns: ["rm -rf /"], metadata: {}, always: ["rm"],
        tool: { messageID: "a1", callID: "call1" },
      },
    } as unknown as Event);
    const req = asked.find((e) => e.type === "permission.requested")!;
    const rd = req.data as { request_id: string; call_id: string; tool: string; input: { command: string } };
    expect(rd).toMatchObject({ request_id: "perm1", call_id: "call1", tool: "bash" });
    expect(rd.input.command).toBe("rm -rf /");
    const replied = m.handle({
      id: "pr",
      type: "permission.replied",
      properties: { sessionID: sid, requestID: "perm1", reply: "reject" },
    } as unknown as Event);
    const res = replied.find((e) => e.type === "permission.resolved")!;
    expect(res.id).toBe("opencode:perm1:permission.resolved");
    expect(res.data).toMatchObject({ decision: "deny", by: "user", scope: "once" });
  });

});
