import { describe, expect, test } from "bun:test";
import {
  normalizeOpencodeEvent,
  OpencodeMapper,
} from "../src/index";
import type { Event } from "@opencode-ai/sdk/v2";
import { openStore } from "@agent-strata/store";
import { projectSession } from "@agent-strata/projector";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { sid, freshId, sessionCreated, msgUpdated, basicFixture } from "./helpers";

describe("OpencodeMapper", () => {
  test("session and message clocks come from OpenCode, not ingest time", () => {
    const created = Date.parse("2026-10-01T08:00:00.000Z");
    const updated = Date.parse("2026-10-03T11:30:00.000Z");
    const m = new OpencodeMapper();
    const started = m.handle({
      id: "e1",
      type: "session.created",
      properties: {
        sessionID: sid,
        info: { id: sid, directory: "/repo", title: "T", time: { created, updated } },
      },
    } as unknown as Event);
    expect(started[0]!.ts).toBe(new Date(updated).toISOString());
    const done = Date.parse("2026-10-03T11:29:00.000Z");
    const assistant = m.handle(
      msgUpdated({
        id: "a1",
        sessionID: sid,
        role: "assistant",
        parentID: "u1",
        time: { created: done - 1000, completed: done },
        providerID: "deepseek",
        modelID: "deepseek-v4-pro",
        agent: "build",
        mode: "build",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        finish: "stop",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    const turn = assistant.find((e) => e.type === "turn.assistant");
    expect(turn?.ts).toBe(new Date(done).toISOString());
  });

  test("a global event with data instead of properties still updates the title", () => {
    const evt = normalizeOpencodeEvent({
      directory: "/repo",
      payload: {
        id: "g1",
        type: "session.updated",
        data: {
          sessionID: sid,
          info: {
            id: sid,
            directory: "/repo",
            title: "Renamed",
            time: { created: 1, updated: 2 },
          },
        },
      },
    });
    expect(evt?.type).toBe("session.updated");
    const out = new OpencodeMapper().handle(evt!);
    expect(out.find((e) => e.type === "session.updated")?.data).toMatchObject({
      title: "Renamed",
      workspace: "/repo",
    });
  });

  test("session.updated emits only when title, directory, or archive changes", () => {
    const m = new OpencodeMapper();
    const created = Date.parse("2026-10-01T08:00:00.000Z");
    const renamedAt = Date.parse("2026-10-04T09:00:00.000Z");
    const archivedAt = Date.parse("2026-10-05T09:00:00.000Z");
    m.handle({
      id: "e1",
      type: "session.created",
      properties: {
        sessionID: sid,
        info: { id: sid, directory: "/repo", title: "T", time: { created, updated: created } },
      },
    } as unknown as Event);
    const costOnly = m.handle({
      id: "e2",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "T",
          time: { created, updated: renamedAt - 1000 },
        },
      },
    } as unknown as Event);
    expect(costOnly.filter((e) => e.type === "session.updated")).toEqual([]);
    const renamed = m.handle({
      id: "e3",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "Renamed",
          time: { created, updated: renamedAt },
        },
      },
    } as unknown as Event);
    const meta = renamed.find((e) => e.type === "session.updated");
    expect(meta?.data).toMatchObject({ title: "Renamed", workspace: "/repo", archived: false });
    expect(meta?.ts).toBe(new Date(renamedAt).toISOString());
    const archived = m.handle({
      id: "e4",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "Renamed",
          time: { created, updated: archivedAt, archived: archivedAt },
        },
      },
    } as unknown as Event);
    expect(archived.find((e) => e.type === "session.updated")?.data).toMatchObject({ archived: true });
    const deleted = m.handle({
      id: "e5",
      type: "session.deleted",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "Renamed",
          time: { created, updated: archivedAt },
        },
      },
    } as unknown as Event);
    expect(deleted.some((e) => e.type === "session.deleted")).toBe(true);
  });

  test("an archived session.created is hidden without waiting for a later update", () => {
    const m = new OpencodeMapper();
    const archived = Date.parse("2026-10-02T00:00:00.000Z");
    const out = m.handle({
      id: "e1",
      type: "session.created",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "Old",
          time: { created: archived, updated: archived, archived },
        },
      },
    } as unknown as Event);
    expect(out.map((e) => e.type)).toEqual(["session.started", "session.updated"]);
    expect(out[1]?.data).toMatchObject({ archived: true, title: "Old" });
  });

  test("session.updated records a revert point and clears it", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const set = m.handle({
      id: "e2",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "T",
          time: { created: 1, updated: 2 },
          revert: { messageID: "u1" },
        },
      },
    } as unknown as Event);
    expect(set.find((e) => e.type === "session.updated")?.data).toMatchObject({
      revert: { turn_id: "u1" },
    });
    const cleared = m.handle({
      id: "e3",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "T",
          time: { created: 1, updated: 3 },
        },
      },
    } as unknown as Event);
    expect(cleared.find((e) => e.type === "session.updated")?.data).toMatchObject({
      revert: null,
    });
    const later = m.handle({
      id: "e4",
      type: "session.updated",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "Renamed",
          time: { created: 1, updated: 4 },
        },
      },
    } as unknown as Event);
    expect(later.find((e) => e.type === "session.updated")?.data).not.toHaveProperty("revert");
  });

  test("a revert clear does not reuse the never-reverted event id", () => {
    const m = new OpencodeMapper();
    const updated = (revert?: { messageID: string }): Event =>
      ({
        id: freshId("su"),
        type: "session.updated",
        properties: {
          sessionID: sid,
          info: {
            id: sid,
            directory: "/repo",
            title: "T",
            time: { created: 1, updated: 2 },
            ...(revert ? { revert } : {}),
          },
        },
      }) as unknown as Event;
    const first = m.handle(updated()).find((e) => e.type === "session.updated");
    m.handle(updated({ messageID: "u1" }));
    const third = m.handle(updated()).find((e) => e.type === "session.updated");
    expect(third?.data).toMatchObject({ revert: null });
    expect(third?.id).not.toBe(first?.id);
  });

  test("a staged revert marks the boundary and a clear lifts it", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const staged = m.handle({
      id: "rv1",
      type: "session.next.revert.staged",
      properties: { sessionID: sid, timestamp: 2, revert: { messageID: "u1" } },
    } as unknown as Event);
    expect(staged.find((e) => e.type === "session.updated")?.data).toMatchObject({
      revert: { turn_id: "u1" },
    });
    const cleared = m.handle({
      id: "rv2",
      type: "session.revert.cleared",
      properties: { sessionID: sid, timestamp: 3 },
    } as unknown as Event);
    expect(cleared.find((e) => e.type === "session.updated")?.data).toMatchObject({ revert: null });
  });

  test("message.removed records the message the backend deleted", () => {
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const out = m.handle({
      id: "rm1",
      type: "message.removed",
      properties: { sessionID: sid, messageID: "u1" },
    } as unknown as Event);
    const removed = out.find((e) => e.type === "message.removed");
    expect(removed).toMatchObject({
      id: "opencode:u1:message.removed",
      data: { message_id: "u1" },
    });
    expect(m.handle({
      id: "rm2",
      type: "message.removed",
      properties: { sessionID: sid, messageID: "u1" },
    } as unknown as Event).find((e) => e.type === "message.removed")?.id).toBe("opencode:u1:message.removed");
  });

  test("a revert payload carried in data still names the message", () => {
    const evt = normalizeOpencodeEvent({
      type: "session.revert.staged",
      data: { sessionID: sid, revert: { messageID: "u1" } },
    });
    const m = new OpencodeMapper();
    m.handle(sessionCreated());
    const out = evt ? m.handle(evt) : [];
    expect(out.find((e) => e.type === "session.updated")?.data).toMatchObject({
      revert: { turn_id: "u1" },
    });
  });

  test("session.created that already has a revert records it", () => {
    const m = new OpencodeMapper();
    const out = m.handle({
      id: "e1",
      type: "session.created",
      properties: {
        sessionID: sid,
        info: {
          id: sid,
          directory: "/repo",
          title: "T",
          time: { created: 1, updated: 1 },
          revert: { messageID: "u1" },
        },
      },
    } as unknown as Event);
    expect(out.find((e) => e.type === "session.updated")?.data).toMatchObject({
      revert: { turn_id: "u1" },
    });
  });


  test("a session met through a message re-stamps its start once the real time arrives", () => {
    const store = openStore(":memory:");
    const m = new OpencodeMapper({ directory: "/repo" });
    // first sight is a message, so there is nothing yet to put on the clock
    store.append(m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 10 } })));
    const blind = store.read({ session_id: `opencode:${sid}` }).find((e) => e.type === "session.started")!;
    const blindTs = blind.ts;

    // the session event carries the backend's own clock
    store.append(
      m.handle({
        id: "sc", type: "session.created",
        properties: {
          sessionID: sid,
          info: {
            id: sid, directory: "/repo", title: "T",
            time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
          },
        },
      } as unknown as Event),
    );

    const after = store.read({ session_id: `opencode:${sid}` }).filter((e) => e.type === "session.started");
    // same event, corrected in place — not a second row
    expect(after).toHaveLength(1);
    expect(after[0]!.ts).not.toBe(blindTs);
    expect(after[0]!.ts).toBe(new Date(1_700_000_060_000).toISOString());
    store.close();
  });

  test("re-indexing a session does not move it to the moment of the re-index", () => {
    // The metadata crawl writes a `session.started` for every session it sees,
    // on every start. The store takes the newest event clock as the session's
    // last activity, so a started event stamped with the moment we read the
    // session made the session read as freshly active — and the next start
    // stamped it again, so a session with a real history in September sat on
    // "just now" for good.
    const store = openStore(":memory:");
    const info = {
      id: sid, directory: "/repo", title: "T",
      time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
    };
    const crawl = (mapper: OpencodeMapper) =>
      mapper.handle({
        id: `sync:${sid}:${info.time.updated}`,
        type: "session.updated",
        properties: { sessionID: sid, info },
      } as unknown as Event);

    // a first run: the session is indexed and its clock is the session's own
    const first = new OpencodeMapper({ directory: "/repo" });
    store.append(crawl(first));
    const started = store.read({ session_id: `opencode:${sid}` }).find((e) => e.type === "session.started")!;
    expect(started.ts).toBe(new Date(1_700_000_060_000).toISOString());

    // a second run — a fresh mapper over the same store — must not move it
    const second = new OpencodeMapper({ directory: "/repo" });
    store.append(crawl(second));
    const after = store.read({ session_id: `opencode:${sid}` }).find((e) => e.type === "session.started")!;
    expect(after.ts).toBe(new Date(1_700_000_060_000).toISOString());
    // and the session's own last activity is that clock, not the re-index
    expect(store.listSessions()[0]!.last_ts).toBe(new Date(1_700_000_060_000).toISOString());
    store.close();
  });

  test("a session that was indexed before keeps the clock it was given", () => {
    // The row a previous run wrote with the wrong clock — the moment it read
    // the session — is corrected by the next run's crawl, in place.
    const store = openStore(":memory:");
    const info = {
      id: sid, directory: "/repo", title: "T",
      time: { created: 1_700_000_000_000, updated: 1_700_000_060_000 },
    };
    const stale = new Date(Date.now() - 60_000).toISOString();
    store.append([
      makeEvent({
        id: `opencode:${sid}:session.started`,
        session_id: `opencode:${sid}`,
        source: { backend: "opencode" },
        type: "session.started",
        data: { workspace: "/repo" },
        ts: stale,
      } as EventInput),
    ]);
    expect(store.listSessions()[0]!.last_ts).toBe(stale);

    const mapper = new OpencodeMapper({ directory: "/repo" });
    store.append(
      mapper.handle({
        id: `sync:${sid}:${info.time.updated}`,
        type: "session.updated",
        properties: { sessionID: sid, info },
      } as unknown as Event),
    );
    expect(store.listSessions()[0]!.last_ts).toBe(new Date(1_700_000_060_000).toISOString());
    store.close();
  });

  test("lazy session.started is corrected when the real session.created arrives", () => {    const store = openStore(":memory:");
    const m = new OpencodeMapper({ directory: "/lazy" });
    store.append(m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } })));
    const created = sessionCreated();
    const props = created.properties as { info: { parentID?: string } };
    props.info.parentID = "ses_parent";
    store.append(m.handle(created));
    const evs = store.read({ session_id: `opencode:${sid}` });
    expect(evs.filter((e) => e.type === "session.started").length).toBe(1);
    expect((evs[0]!.data as { workspace: string }).workspace).toBe("/lazy");
    const view = projectSession(evs);
    expect(view.workspace).toBe("/repo");
    expect(view.title).toBe("T");
    expect(view.parent_session_id).toBe("opencode:ses_parent");
    const row = store.listSessions().find((s) => s.session_id === `opencode:${sid}`);
    expect(row?.workspace).toBe("/repo");
    expect(row?.title).toBe("T");
    store.close();
  });

  test("projectSession over mapped events", () => {
    const store = openStore(":memory:");
    const m = new OpencodeMapper();
    for (const e of basicFixture()) {
      const evts = m.handle(e);
      if (evts.length) store.append(evts);
    }
    const view = projectSession(store.read({ session_id: `opencode:${sid}` }));
    expect(view.turns.length).toBe(1);
    expect(view.turns[0]!.tool_calls[0]).toMatchObject({ tool: "bash", status: "ok" });
    expect(view.totals.input).toBe(100);
    expect(view.totals.cost_usd).toBeCloseTo(0.25);
    store.close();
  });
});
