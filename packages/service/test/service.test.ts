import { describe, expect, test } from "bun:test";
import { createIngestor, OpencodeMapper, OPENCODE_MAPPER_VERSION } from "@agent-strata/adapter-opencode";
import { startService } from "../src/index";
import { ev, seed } from "./service-harness";

describe("agent-strata service", () => {
  test("a session the ingestor watched being created carries the mapper version", () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const ing = createIngestor({ mapper: new OpencodeMapper(), sink: svc.sink, reply: async () => {} });
    const created = (id: string, sessionID: string) =>
      ({
        id,
        type: "session.created",
        properties: {
          sessionID,
          info: { id: sessionID, directory: "/repo", title: "T", time: { created: 1, updated: 1 } },
        },
      }) as unknown as Parameters<typeof ing.handle>[0];
    ing.handle(created("evt_1", "ses_live"));
    ing.handle(created("import:ses_old", "ses_old"));
    expect(svc.store.sessionMapper("opencode:ses_live")).toBe(OPENCODE_MAPPER_VERSION);
    expect(svc.store.sessionMapper("opencode:ses_old")).toBeNull();
    ing.stop();
    svc.stop();
  });

  test("markMapped records the first mapper and leaves it", () => {
    const svc = startService({ db: ":memory:", port: 0 });
    seed(svc, "opencode:born");
    expect(svc.store.sessionMapper("opencode:born")).toBeNull();
    svc.sink.markMapped("opencode:born", "opencode-3");
    expect(svc.store.sessionMapper("opencode:born")).toBe("opencode-3");
    svc.sink.markMapped("opencode:born", "opencode-2");
    expect(svc.store.sessionMapper("opencode:born")).toBe("opencode-3");
    svc.stop();
  });

  test("a tail view carries the last turns and leaves out files the reader already has", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const sid = "opencode:tail";
    seed(svc, sid);
    svc.store.append([
      ev(sid, "turn.user", { turn_id: "t2", content: [{ type: "text", text: "second" }] }, "2026-01-01T00:00:03Z"),
      ev(sid, "tool.call", { turn_id: "t2", call_id: "c1", tool: "edit", input: { filePath: "/tmp/x/a.ts" } }, "2026-01-01T00:00:04Z"),
      ev(sid, "file.changed", { path: "/tmp/x/a.ts", change: "modify", diff: "@@ -1 +1 @@\n-a\n+b\n", call_id: "c1" }, "2026-01-01T00:00:05Z"),
    ]);
    const view = (q: string) => fetch(`${base}/sessions/${encodeURIComponent(sid)}/view${q}`).then((r) => r.json());

    const full = await view("");
    const tail = await view("?tail=1");
    expect(tail.turns.map((t: { turn_id: string }) => t.turn_id)).toEqual(["t2"]);
    expect(tail.turn_offset).toBe(1);
    expect(tail.prev_turn_id).toBe("t1");
    expect(tail.totals).toEqual(full.totals);
    expect(tail.files_changed).toEqual(full.files_changed);
    expect(typeof tail.files_key).toBe("string");

    const again = await view(`?tail=1&files_key=${encodeURIComponent(tail.files_key)}`);
    expect(again.files_changed).toBeUndefined();
    expect(again.turns.map((t: { turn_id: string }) => t.turn_id)).toEqual(["t2"]);
    expect((await view("?tail=1&files_key=0:0")).files_changed).toEqual(full.files_changed);
    expect((await view("?tail=0")).turns).toHaveLength(1);

    const all = await view("?tail=10");
    expect(all.turn_offset).toBe(0);
    expect(all.prev_turn_id).toBeNull();
    expect(all.turns).toHaveLength(2);

    svc.stop();
  });

  test("a message still being written shows in the view until the finished one lands", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const sid = "opencode:live1";
    seed(svc, sid);
    const view = () => fetch(`${base}/sessions/${encodeURIComponent(sid)}/view`).then((r) => r.json());

    svc.sink.publish([
      ev(sid, "turn.assistant", { turn_id: "t2", msg_id: "m2", partial: true, content: [{ type: "text", text: "wri" }] }, "2026-01-01T00:00:05Z"),
    ]);
    let v = await view();
    expect(v.turns.at(-1).assistant[0]).toMatchObject({ msg_id: "m2", partial: true });
    expect(svc.store.read({ session_id: sid })).toHaveLength(3);

    svc.store.append([
      ev(sid, "turn.assistant", { turn_id: "t2", msg_id: "m2", content: [{ type: "text", text: "written" }] }, "2026-01-01T00:00:06Z"),
    ]);
    v = await view();
    expect(v.turns.at(-1).assistant).toHaveLength(1);
    expect(v.turns.at(-1).assistant[0].content[0].text).toBe("written");
    expect(v.turns.at(-1).assistant[0].partial).toBeUndefined();

    svc.sink.publish([
      ev(sid, "turn.assistant", { turn_id: "t3", msg_id: "m3", partial: true, content: [{ type: "text", text: "lost" }] }, "2026-01-01T00:00:07Z"),
    ]);
    expect((await view()).turns.some((t: { turn_id: string }) => t.turn_id === "t3")).toBe(true);
    svc.store.append([ev(sid, "session.status", { state: "idle" }, "2026-01-01T00:00:08Z")]);
    expect((await view()).turns.some((t: { turn_id: string }) => t.turn_id === "t3")).toBe(false);

    svc.stop();
  });

  test("views follow appends and rebuilds, and the list projects each session once", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const sid = "opencode:cached";
    seed(svc, sid);
    const view = () => fetch(`${base}/sessions/${encodeURIComponent(sid)}/view`).then((r) => r.json());
    expect((await view()).totals.input).toBe(10);

    svc.store.append([
      ev(sid, "turn.assistant", { turn_id: "t1", msg_id: "m9", usage: { input: 5, output: 1 }, content: [] }, "2026-01-01T00:00:03Z"),
    ]);
    expect((await view()).totals.input).toBe(15);

    svc.sink.replaceSession(
      sid,
      [ev(sid, "turn.assistant", { turn_id: "t1", usage: { input: 1, output: 1 }, content: [] }, "2026-01-01T00:00:04Z")],
      { replaceTypes: ["turn.assistant"] },
    );
    expect((await view()).totals.input).toBe(1);

    const list = await fetch(`${base}/sessions`).then((r) => r.json());
    expect(list.sessions[0].totals.input).toBe(1);
    expect(list.aggregate.total.input).toBe(1);
    svc.stop();
  });

  test("live stream broadcasts new events", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;

    const streamed = new Promise<unknown[]>((resolve) => {
      const got: unknown[] = [];
      void fetch(`${base}/stream`).then(async (res) => {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (got.length < 2) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop()!;
          for (const p of parts) {
            const line = p.replace(/^data: /, "").trim();
            if (line) got.push(JSON.parse(line));
          }
        }
        void reader.cancel();
        resolve(got);
      });
    });

    await new Promise((r) => setTimeout(r, 30));
    seed(svc, "opencode:s3");

    const live = (await streamed) as { type: string }[];
    expect(live[0]!.type).toBe("service.connected");
    expect(live[1]!.type).toBe("session.started");

    svc.stop();
  });
});
