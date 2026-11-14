import { describe, expect, test } from "bun:test";
import {
  OpencodeMapper,
  snapshotEvents,
  OPENCODE_REBUILT_TYPES,
} from "../src/index";
import type { Event } from "@opencode-ai/sdk/v2";
import { openStore } from "@agent-strata/store";
import { type EventInput } from "@agent-strata/schema";
import { sid, freshId, sessionCreated, msgUpdated, partUpdated } from "./helpers";

describe("OpencodeMapper", () => {
  test("a compaction part emits one session.compacted", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const part = { id: "pc1", sessionID: sid, messageID: "a1", type: "compaction", auto: true };
    const first = m.handle(partUpdated(part));
    const evs = first.filter((e) => e.type === "session.compacted");
    expect(evs).toHaveLength(1);
    expect(evs[0]!.id).toBe("opencode:pc1:compaction");
    expect(evs[0]!.data).toEqual({ message_id: "a1", auto: true });
    const second = m.handle(partUpdated(part));
    expect(second.filter((e) => e.type === "session.compacted")).toEqual([]);
    expect(OPENCODE_REBUILT_TYPES).toContain("session.compacted");
  });

  test("a compaction part is stamped by the message that asked for it", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const created = Date.parse("2026-05-12T09:00:00.000Z");
    m.handle(
      msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created } }),
    );
    const part = { id: "pc2", sessionID: sid, messageID: "u1", type: "compaction", auto: true };
    const evs = m.handle(partUpdated(part)).filter((e) => e.type === "session.compacted");
    // No ingest clock — connecting today must not pull the session to the top.
    expect(evs[0]!.ts).toBe(new Date(created).toISOString());
  });

  test("a compaction part ahead of its message takes the session clock", () => {
    const m = new OpencodeMapper();
    const updated = Date.parse("2026-09-20T08:00:00.000Z");
    const info = {
      id: sid,
      directory: "/repo",
      title: "Snapshot",
      time: { created: 1, updated },
    };
    const messages = [
      {
        info: { id: "u1", sessionID: sid, role: "user", time: { created: 10 } },
        parts: [
          { id: "pt1", sessionID: sid, messageID: "u1", type: "text", text: "hi" },
          { id: "pc9", sessionID: sid, messageID: "u1", type: "compaction", auto: true },
        ],
      },
    ];
    const out = snapshotEvents(sid, info as never, messages as never).flatMap((e) =>
      m.handle(e),
    );
    const ev = out.find((e) => e.type === "session.compacted");
    // Parts replay before their message on import — the session's own updated
    // clock is the fallback, still never the ingest moment.
    expect(ev?.ts).toBe(new Date(updated).toISOString());
  });

  test("a compaction part keeps the overflow flag the wire sends", () => {
    // The SDK type stops at `auto`; the payload still carries `overflow`, and
    // that is the difference between "past the threshold" and "blew the
    // context mid-request" — the two reasons OpenCode compacts on its own.
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const part = {
      id: "pc3",
      sessionID: sid,
      messageID: "a1",
      type: "compaction",
      auto: true,
      overflow: true,
    };
    const evs = m.handle(partUpdated(part)).filter((e) => e.type === "session.compacted");
    expect(evs[0]!.data).toEqual({ message_id: "a1", auto: true, overflow: true });
  });

  test("an unfinished summary message is the live compaction signal", () => {
    // Post-rewrite servers never write `session.time.compacting` — the
    // summary:true assistant message itself is what says the compact is on.
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    const open = m.handle(
      msgUpdated({
        id: "a1",
        sessionID: sid,
        role: "assistant",
        parentID: "u1",
        summary: true,
        time: { created: 20 },
        providerID: "p",
        modelID: "m",
        agent: "build",
        tokens,
      }),
    );
    expect(
      open.some((e) => e.type === "session.status" && (e.data as { state: string }).state === "compacting"),
    ).toBe(true);
    // A busy frame inside the same run says nothing about the compact: the
    // summarising call is the busy span, so the state stays.
    const mid = m.handle({
      id: freshId("s"),
      type: "session.status",
      properties: { sessionID: sid, status: { type: "busy" } },
    } as unknown as Event);
    expect(mid.filter((e) => e.type === "session.status")).toEqual([]);
    // Completing the summary returns the session to plain busy — idle is for
    // the idle/settle path to announce, not for the message to.
    const done = m.handle(
      msgUpdated({
        id: "a1",
        sessionID: sid,
        role: "assistant",
        parentID: "u1",
        summary: true,
        time: { created: 20, completed: 40 },
        providerID: "p",
        modelID: "m",
        agent: "build",
        finish: "stop",
        tokens,
      }),
    );
    expect(done.find((e) => e.type === "session.status")?.data).toEqual({ state: "busy" });
    // And the completed message names itself the summary, so the transcript
    // can label it rather than draw it as one more reply.
    const ta = done.find((e) => e.type === "turn.assistant");
    expect(ta && (ta.data as { summary?: boolean }).summary).toBe(true);
  });

  test("a completed summary message clears compaction before it resumes", () => {
    // Import order lands the close before the open: a stored session replays
    // part updates first, so the completed summary arrives once, both flags
    // set, and must not leave the session stuck in compacting.
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const info = { id: sid, directory: "/repo", title: "T", time: { created: 1, updated: 2 } };
    const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
    const messages = [
      { info: { id: "u1", sessionID: sid, role: "user", time: { created: 10 } }, parts: [{ id: "pt1", sessionID: sid, messageID: "u1", type: "text", text: "hi" }] },
      {
        info: {
          id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
          summary: true, time: { created: 20, completed: 40 },
          providerID: "p", modelID: "m", agent: "build", finish: "stop", tokens,
        },
        parts: [{ id: "pt2", sessionID: sid, messageID: "a1", type: "text", text: "summary body" }],
      },
    ];
    const out = snapshotEvents(sid, info as never, messages as never).flatMap((e) => m.handle(e));
    expect(out.filter((e) => e.type === "session.status" && (e.data as { state: string }).state === "compacting")).toEqual([]);
    const ta = out.find((e) => e.type === "turn.assistant" && !(e.data as { partial?: boolean }).partial);
    expect(ta && (ta.data as { summary?: boolean }).summary).toBe(true);
  });

  test("the legacy compacting clock still announces and closes", () => {
    // Pre-rewrite servers set `time.compacting` while the operation ran and
    // cleared it after. The writer is gone from current code, but the field
    // is still declared — keep reading it for the servers that send it.
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const t0 = Date.parse("2026-10-20T10:00:00.000Z");
    const on = m.handle({
      id: freshId("s"),
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: { id: sid, directory: "/repo", title: "T", time: { created: 1, updated: t0, compacting: t0 } },
      },
    } as unknown as Event);
    expect(on.find((e) => e.type === "session.status")?.data).toEqual({ state: "compacting" });
    const off = m.handle({
      id: freshId("s"),
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: { id: sid, directory: "/repo", title: "T", time: { created: 1, updated: t0 + 5000 } },
      },
    } as unknown as Event);
    expect(off.find((e) => e.type === "session.status")?.data).toEqual({ state: "busy" });
  });

  test("a retry status frame carries attempt, timing and the safe recovery action", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const next = Date.parse("2026-10-20T10:00:30.000Z");
    const action = {
      reason: "rate_limit",
      provider: "anthropic",
      title: "Usage limited",
      message: "Add credits or wait",
      label: "Open console",
      link: "https://console.anthropic.com/",
    };
    const frame = () => ({
      id: freshId("s"),
      type: "session.status",
      properties: {
        sessionID: sid,
        status: { type: "retry", attempt: 2, message: "rate limited", next, action },
      },
    });
    const out = m.handle(frame() as unknown as Event);
    const ev = out.find((e) => e.type === "session.status");
    expect(ev?.data).toEqual({
      state: "retry",
      retry: { attempt: 2, message: "rate limited", next, action },
    });
    // The same wait restated is a no-op — polling the status endpoint
    // re-describes the retry without moving it.
    expect(m.handle(frame() as unknown as Event).filter((e) => e.type === "session.status")).toEqual([]);
    // Work resuming retires the retry: the next busy frame is the answer.
    const busy = m.handle({
      id: freshId("s"),
      type: "session.status",
      properties: { sessionID: sid, status: { type: "busy" } },
    } as unknown as Event);
    expect(busy.find((e) => e.type === "session.status")?.data).toEqual({ state: "busy" });
  });

  test("session.error stores a safe diagnostic and stills the session", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    const out = m.handle({
      id: freshId("s"),
      type: "session.error",
      properties: {
        sessionID: sid,
        error: {
          name: "ProviderAuthError",
          data: { message: "bad key", statusCode: 401, isRetryable: false, providerID: "anthropic" },
        },
      },
    } as unknown as Event);
    const ev = out.find((e) => e.type === "session.error");
    expect(ev?.data).toEqual({
      error: {
        name: "ProviderAuthError",
        message: "bad key",
        statusCode: 401,
        isRetryable: false,
        providerID: "anthropic",
      },
    });
  });

  test("a deliberate stop closes the session without a failure", () => {
    // The backend reports the abort it ran as MessageAbortedError; stored as a
    // diagnostic it would paint a clean stop as a crashed session.
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20 }, providerID: "p", modelID: "m", agent: "build", mode: "build",
      path: { cwd: "/repo", root: "/repo" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    const out = m.handle({
      id: freshId("s"),
      type: "session.error",
      properties: {
        sessionID: sid,
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
    } as unknown as Event);
    // The reply still open when the stop landed is closed, not left to vanish —
    // and it is marked stopped, because the close was the reader's own doing.
    expect(out.find((e) => e.type === "turn.assistant")?.data).toMatchObject({
      msg_id: "a1",
      stop_reason: "stopped",
    });
    expect(out.find((e) => e.type === "session.error")?.data).toEqual({ error: null });
  });

  test("an AbortError whose message is not an abort stays a failure", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const out = m.handle({
      id: freshId("s"),
      type: "session.error",
      properties: {
        sessionID: sid,
        error: { name: "AbortError", data: { message: "provider closed the stream" } },
      },
    } as unknown as Event);
    expect(out.find((e) => e.type === "session.error")?.data).toMatchObject({
      error: { name: "AbortError", message: "provider closed the stream" },
    });
  });

  test("a real failure still stores its diagnostic", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    const out = m.handle({
      id: freshId("s"),
      type: "session.error",
      properties: {
        sessionID: sid,
        error: { name: "ProviderAuthError", data: { message: "bad key" } },
      },
    } as unknown as Event);
    expect(out.find((e) => e.type === "session.error")?.data).toEqual({
      error: { name: "ProviderAuthError", message: "bad key" },
    });
  });

  test("idle closes an open assistant message as interrupted", () => {
    // A run that ends with a message still open completed nothing: the
    // partial stream was never stored, so without a final the reply simply
    // vanishes. The close keeps what was written and marks the cut.
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    const open = {
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 20 }, providerID: "p", modelID: "m", agent: "build", mode: "build",
      path: { cwd: "/repo", root: "/repo" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    m.handle(msgUpdated(open));
    m.handle(partUpdated({ id: "pt1", sessionID: sid, messageID: "a1", type: "text", text: "half a reply" }));
    const out = m.handle(
      { id: freshId("i"), type: "session.idle", properties: { sessionID: sid } } as unknown as Event,
    );
    const ta = out.find((e) => e.type === "turn.assistant")!;
    expect(ta.data).toMatchObject({
      turn_id: "u1",
      msg_id: "a1",
      stop_reason: "interrupted",
      content: [{ type: "text", text: "half a reply" }],
    });
    // A completion that lands anyway still emits its own final — it replaces
    // the interrupted one by msg_id.
    const done = m.handle(
      msgUpdated({ ...open, time: { created: 20, completed: 40 }, finish: "stop", cost: 0.1 }),
    );
    const final = done.find((e) => e.type === "turn.assistant")!;
    expect(final.data).toMatchObject({ msg_id: "a1", stop_reason: "stop" });
  });

  test("idle with nothing open emits no assistant event", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    const out = m.handle(
      { id: freshId("i"), type: "session.idle", properties: { sessionID: sid } } as unknown as Event,
    );
    expect(out.filter((e) => e.type === "turn.assistant")).toEqual([]);
  });


  test("a fresh generation's first idle is announced even without seeing the busy", () => {
    // The store's `busy` outlives the mapper that wrote it. A restart, or a
    // fresh connect, starts with an empty ledger while the projection still
    // says running — and a guard that only trusted its own memory refused the
    // one frame able to clear it. Measured on a session stuck that way: the
    // stop button went through the same path and changed nothing, while the
    // official client — which asks the server rather than remembering — drew
    // the session as idle.
    const m = new OpencodeMapper();
    const out = m.handle({
      id: "idle-gen1",
      type: "session.idle",
      properties: { sessionID: sid },
    } as unknown as Event);
    expect(out.find((e) => e.type === "session.status")?.data).toEqual({ state: "idle" });
  });

  test("the second idle in one generation stays quiet", () => {
    // The correction is once per generation. The backend re-issues idle under
    // fresh ids for one transition, and again on reconnect; announcing each
    // would stack duplicates on a session that is already idle.
    const m = new OpencodeMapper();
    m.handle({ id: "idle-a", type: "session.idle", properties: { sessionID: sid } } as unknown as Event);
    const again = m.handle({
      id: "idle-b",
      type: "session.idle",
      properties: { sessionID: sid },
    } as unknown as Event);
    expect(again.find((e) => e.type === "session.status")).toBeUndefined();
  });

  test("a new run gets its own idle after the correction was spent", () => {
    // Work reset the latch, so the idle that ends this run is the busy→idle
    // edge again — not swallowed as a duplicate of the earlier correction.
    const m = new OpencodeMapper();
    m.handle({ id: "idle-pre", type: "session.idle", properties: { sessionID: sid } } as unknown as Event);
    m.handle(msgUpdated({ id: "u9", sessionID: sid, role: "user", time: { created: 10 } }));
    const ended = m.handle({
      id: "idle-post",
      type: "session.idle",
      properties: { sessionID: sid },
    } as unknown as Event);
    expect(ended.find((e) => e.type === "session.status")?.data).toEqual({ state: "idle" });
  });

  test("an idle re-delivered on the slower bus cannot eat the next run's busy", () => {
    // Measured on a live pair of buses: the project bus had finished run one
    // and was already carrying the next turn while the global bus was still
    // delivering run one's tail. Back when an idle re-armed a "finished" latch,
    // those stale copies landed after the new turn started and the run's own
    // busy was dropped as a stale claim — the run read as never having
    // started. A goal continuation hits this on every step: it sends the next
    // prompt the moment the idle lands, well inside the other bus's lag.
    const m = new OpencodeMapper();
    const states = (out: EventInput[]) =>
      out.filter((e) => e.type === "session.status").map((e) => (e.data as { state: string }).state);
    const status = (id: string, state: string) =>
      m.handle({
        id, type: "session.status", properties: { sessionID: sid, status: { type: state } },
      } as unknown as Event);
    const idle = (id: string) =>
      m.handle({ id, type: "session.idle", properties: { sessionID: sid } } as unknown as Event);
    const user = (id: string) =>
      m.handle(msgUpdated({ id, sessionID: sid, role: "user", time: { created: 1 } }));
    const assistant = (id: string, time: object) =>
      m.handle(msgUpdated({
        id, sessionID: sid, role: "assistant", parentID: "u2",
        time, providerID: "anthropic", modelID: "claude",
        agent: "build", mode: "build", path: { cwd: "/repo", root: "/repo" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }));

    // Run one's busy is opened by the user message itself; the frame that
    // confirms it has nothing left to say.
    expect(states(user("u1"))).toEqual(["busy"]);
    expect(states(status("b1", "busy"))).toEqual([]);
    expect(states(status("i1", "idle"))).toEqual(["idle"]);
    // The idle's companion frame is a re-issue under a second id — no new
    // transition, so nothing new to say.
    expect(states(idle("i2"))).toEqual([]);
    // The next turn is already underway when the second bus re-delivers run
    // one's idles — the same frames, under the same ids.
    expect(states(user("u2"))).toEqual(["busy"]);
    expect(states(status("i1", "idle"))).toEqual([]);
    expect(states(idle("i2"))).toEqual([]);
    expect(states(status("b2", "busy"))).toEqual([]);
    // A stale idle re-issued under a fresh id does interrupt once — it is
    // indistinguishable from a real end — but the run's next evidence speaks
    // again, so it cannot leave the run invisible.
    expect(states(status("i9", "idle"))).toEqual(["idle"]);
    expect(states(assistant("a2", { created: 2 }))).toEqual(["busy"]);
  });


describe("the two opencode buses do not agree on when a session is idle", () => {
  /**
   * Measured against a live server, on one run in D:\Code\lector:
   *
   *   DIR     session.status  busy
   *   GLOBAL  session.status  busy
   *   ...
   *   DIR     session.status  idle
   *   DIR     session.idle    IDLE
   *   GLOBAL  session.status  busy      <- still arriving, long after idle
   *
   * The global bus keeps carrying the state of a session that has already
   * finished. A desktop session list has to follow every project, so it follows
   * the global bus — and it then reads the last state that arrived, which for a
   * busy project is a `busy` belonging to a run that ended. That is the whole of
   * "the tools are still going and every list says idle": the projection is
   * correct about the events it was given, and the events were wrong.
   *
   * The per-directory bus is in step with the run. So the global bus stays the
   * one that discovers sessions, and the per-directory bus is the one allowed
   * to say a session is idle.
   */
  test("a late busy claim cannot undo the idle a finished turn reported", async () => {
    const { connectOpencode } = await import("../src/index");
    const enc = new TextEncoder();
    const sse = (chunks: string[]) =>
      new ReadableStream<Uint8Array>({
        start(ctrl) {
          for (const c of chunks) ctrl.enqueue(enc.encode(`data: ${c}\n\n`));
          // stays open
        },
      });

    const created = (id: string) =>
      `{"directory":"/repo","payload":{"id":"c-${id}","type":"session.created","properties":{"sessionID":"${id}","info":{"id":"${id}","directory":"/repo","title":"T","time":{"created":1,"updated":1}}}}}`;
    const status = (id: string, ev: string, state: string) =>
      `{"directory":"/repo","payload":{"id":"${ev}","type":"session.status","properties":{"sessionID":"${id}","status":{"type":"${state}"}}}}`;
    const userMsg = (id: string, ev: string) =>
      `{"directory":"/repo","payload":{"id":"${ev}","type":"message.updated","properties":{"sessionID":"${id}","info":{"id":"u1","sessionID":"${id}","role":"user","time":{"created":10}}}}}`;

    const sid = "ses_race";
    const fakeFetch = async (input: Request | URL | string) => {
      const req = input instanceof Request ? input : new Request(String(input));
      const url = req.url;
      if (url.includes("/global/event")) {
        // One stream now. A real turn — the user message is the busy — then
        // idle, then the stale busy claim every busy server's tail emits.
        return new Response(
          sse([
            created(sid),
            userMsg(sid, "m1"),
            status(sid, "d1", "idle"),
            status(sid, "g-stale-busy", "busy"),
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.includes("/event")) {
        return new Response(sse([created(sid)]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json([]);
    };

    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: fakeFetch as typeof fetch,
      connectTimeoutMs: 5_000,
    });
    await Bun.sleep(400);
    conn.stop();

    const states = store
      .read({ session_id: `opencode:${sid}` })
      .filter((e) => e.type === "session.status")
      .map((e) => (e as { data: { state: string } }).data.state);
    // busy came from the message, idle from the frame, the stale claim died.
    expect(states).toEqual(["busy", "idle"]);
    store.close();
  });

  test("a user message re-delivered after the turn's idle cannot revive busy", () => {
    // The same `message.updated` frame is carried on both buses. When the
    // slower copy lands after the run's idle, replaying it re-asserts busy on
    // a finished turn — and nothing ever ends it. Reproduction from live
    // traffic: idle at t+0ms, the second copy of the user message at t+1ms,
    // session stuck busy until the process restarted.
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const userMsg = msgUpdated({
      id: "u1",
      sessionID: sid,
      role: "user",
      time: { created: 10 },
    });
    const run1 = [
      m.handle(userMsg), // dir bus: the turn starts — work evidence says busy
      m.handle(
        partUpdated({
          id: "pt1",
          sessionID: sid,
          messageID: "u1",
          type: "text",
          text: "hi",
          time: { start: 10 },
        }),
      ),
      m.handle({ id: "st-idle", type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } } as unknown as Event),
      m.handle({ id: "st-idle2", type: "session.idle", properties: { sessionID: sid } } as unknown as Event),
    ].flat();
    expect(run1.filter((e) => e.type === "session.status").map((e) => e.data.state)).toEqual([
      "busy",
      "idle",
    ]);
    // The global bus's copy of the user message arrives now — same frame id,
    // dropped by re-delivery dedup.
    const late = m.handle(userMsg);
    expect(late.filter((e) => e.type === "session.status")).toEqual([]);
    // And OpenCode's own bookkeeping update — a different frame id, the turn
    // already resolved — is not a new run either.
    const bookkeeping = m.handle(
      msgUpdated({
        id: "u1",
        sessionID: sid,
        role: "user",
        time: { created: 10 },
      }),
    );
    expect(
      bookkeeping.filter((e) => e.type === "session.status" && e.data.state === "busy"),
    ).toEqual([]);
    // The next turn is a NEW message id — its evidence still opens a run.
    const run2 = m.handle(
      msgUpdated({
        id: "u2",
        sessionID: sid,
        role: "user",
        time: { created: 20 },
      }),
    );
    expect(run2.filter((e) => e.type === "session.status").map((e) => e.data.state)).toEqual([
      "busy",
    ]);
  });
});


describe("reconciling a run the app was closed in the middle of", () => {
  /**
   * The correction at connect time has to act on sessions this connection never
   * watched, because that is the shape of the failure: a reply still arriving
   * when the app was closed leaves `busy` in the store and nothing after it.
   * The previous generation is gone, so an empty ledger is all this one has.
   */
  test("a store that still says running is corrected even though this generation never saw it", () => {
    const gen2 = new OpencodeMapper();
    const out = gen2.reconcileIdle([sid], () => ({
      running: true,
      seq: 7,
      ts: "2026-01-01T00:00:05.000Z",
    }));
    expect(out.map((e) => e.type)).toEqual(["session.status"]);
    expect((out[0]!.data as { state: string }).state).toBe("idle");
  });

  /**
   * Without that answer and without a ledger entry, there is nothing to
   * correct — a session the store never heard of must not gain a status event
   * out of nowhere.
   */
  test("a session nothing knows about is left alone", () => {
    const gen2 = new OpencodeMapper();
    expect(gen2.reconcileIdle([sid], () => ({ running: false, seq: 0 }))).toEqual([]);
    expect(gen2.reconcileIdle([sid])).toEqual([]);
  });

  /**
   * The event id carries the store's position, so the next restart after a real
   * turn writes a *different* id. A fixed id would be deduped by the store and
   * the second correction would silently do nothing.
   */
  test("the correction's id moves with the session, so a later one is not deduped", () => {
    const first = new OpencodeMapper().reconcileIdle([sid], () => ({ running: true, seq: 7 }));
    const later = new OpencodeMapper().reconcileIdle([sid], () => ({ running: true, seq: 12 }));
    expect(first[0]!.id).not.toBe(later[0]!.id);
    expect(first[0]!.id).toContain(":7");
    expect(later[0]!.id).toContain(":12");
  });

  /**
   * The event borrows the session's own clock. Stamped with now, it would win
   * `MAX(last_ts)` and lift a conversation from last week to the top of the
   * list the moment the app opened.
   */
  test("the correction carries the session's clock, not the current one", () => {
    const when = "2026-01-01T00:00:05.000Z";
    const out = new OpencodeMapper().reconcileIdle([sid], () => ({ running: true, seq: 7, ts: when }));
    expect(out[0]!.ts).toBe(when);
  });

  /**
   * The path that always worked keeps working: a session this generation did
   * watch go busy is corrected from memory, with no store answer needed.
   */
  test("a run this generation watched is still corrected from memory", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }));
    m.handle(partUpdated({ id: "pt1", sessionID: sid, messageID: "u1", type: "text", text: "hi", time: { start: 10 } }));
    const out = m.reconcileIdle([sid], () => ({ running: false, seq: 3 }));
    expect(out.some((e) => e.type === "session.status" && (e.data as { state: string }).state === "idle")).toBe(true);
  });
});

describe("a quiet session on a live connection", () => {
  /**
   * The settle guess was removed because silence alone cannot say a run ended
   * — a thinking model is quiet too. What fires now is the question instead:
   * a session that stopped talking while the store still calls it running has
   * its status read, and only an `idle` the backend itself reports lands.
   * Measured: a turn that ends in `permission.replied` + `session.updated`
   * emits no `session.idle`, so without the ask the running mark outlives
   * the run.
   */
  const quietProbeFetch = (
    status: () => Record<string, { type: string }>,
    statusCalls: { n: number },
  ) => {
    const enc = new TextEncoder();
    const frames = [
      sessionCreated(),
      msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } }),
      partUpdated({ id: "pt1", sessionID: sid, messageID: "u1", type: "text", text: "hi", time: { start: 10 } }),
      {
        id: freshId("pr"),
        type: "permission.replied",
        properties: { sessionID: sid, requestID: "perm1", reply: "once" },
      },
    ];
    return async (input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/global/event") || url.endsWith("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              for (const evt of frames) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.includes("/session/status")) {
        statusCalls.n += 1;
        return Response.json(status());
      }
      return Response.json([]);
    };
  };

  test("the backend's idle lands as the correction once the session goes quiet", async () => {
    const { connectOpencode } = await import("../src/index");
    const statusCalls = { n: 0 };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      // The frames below leave the store saying running; the backend's own
      // table says idle by the time the quiet probe asks. Nothing else in the
      // stream ever says idle, so the correction can only come from that read.
      fetch: quietProbeFetch(() => ({ [sid]: { type: "idle" } }), statusCalls) as typeof fetch,
      connectTimeoutMs: 5_000,
      quietProbeMs: 100,
    });
    const casf = `opencode:${sid}`;
    const deadline = Date.now() + 4_000;
    while (!store.sessionRunning(casf).running && Date.now() < deadline) await Bun.sleep(20);
    expect(store.sessionRunning(casf).running).toBe(true);
    while (store.sessionRunning(casf).running && Date.now() < deadline) await Bun.sleep(20);
    expect(store.sessionRunning(casf).running).toBe(false);
    // The connect read is skipped while the store has nothing running — there
    // is nothing to correct — so the quiet probe is the one that asks.
    expect(statusCalls.n).toBeGreaterThanOrEqual(1);
    conn.stop();
    store.close();
  });

  test("a quiet session the backend still calls busy is asked but believed", async () => {
    const { connectOpencode } = await import("../src/index");
    const statusCalls = { n: 0 };
    const store = openStore(":memory:");
    const conn = await connectOpencode({
      baseUrl: "http://fake",
      sink: store,
      fetch: quietProbeFetch(() => ({ [sid]: { type: "busy" } }), statusCalls) as typeof fetch,
      connectTimeoutMs: 5_000,
      quietProbeMs: 100,
      statusReprobeMs: 60_000,
    });
    const casf = `opencode:${sid}`;
    const deadline = Date.now() + 4_000;
    while (!store.sessionRunning(casf).running && Date.now() < deadline) await Bun.sleep(20);
    while (statusCalls.n < 1 && Date.now() < deadline) await Bun.sleep(20);
    // One read: the probe. The backend's table lists this session, so it is
    // running and the projection is left alone.
    expect(statusCalls.n).toBe(1);
    expect(store.sessionRunning(casf).running).toBe(true);
    conn.stop();
    store.close();
  });
});
});
