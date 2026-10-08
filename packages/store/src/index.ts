import { Database } from "bun:sqlite";
import { Event, EventInput, makeEvent, parseEvent } from "@agent-strata/schema";

export interface EventQuery {
  session_id?: string;
  backend?: string;
  types?: string[];
  since?: string;
  until?: string;
  text?: string;
  order?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

export interface SessionSummary {
  session_id: string;
  backend: string;
  workspace: string | null;
  title: string | null;
  started_at: string;
  last_seq: number;
  last_ts: string;
}

export interface Store {
  append(inputs: EventInput[]): Event[];
  read(opts: { session_id: string; after_seq?: number; limit?: number }): Event[];
  query(q: EventQuery): Event[];
  listSessions(opts?: { limit?: number; backend?: string }): SessionSummary[];
  search(
    query: string,
    opts?: { session_id?: string; limit?: number },
  ): { event: Event; snippet: string }[];
  subscribe(fn: (e: Event) => void): () => void;
  close(): void;
}

function ftsText(e: Event): string {
  const parts: string[] = [];
  const d = e.data as Record<string, unknown>;
  if (Array.isArray(d.content)) {
    for (const b of d.content as { type?: string; text?: string }[]) {
      if ((b.type === "text" || b.type === "thinking") && b.text) parts.push(b.text);
    }
  }
  if (e.type === "tool.call") {
    parts.push(String(d.tool ?? ""), JSON.stringify(d.input ?? {}));
  }
  if (e.type === "tool.result" && typeof d.output === "string") parts.push(d.output);
  return parts.join("\n");
}

function ftsQuote(q: string): string {
  const terms = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export function openStore(path: string | ":memory:"): Store {
  const db = new Database(path === ":memory:" ? ":memory:" : path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events(
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      backend TEXT NOT NULL,
      body TEXT NOT NULL,
      UNIQUE(session_id, seq)
    );
    CREATE TABLE IF NOT EXISTS sessions(
      session_id TEXT PRIMARY KEY,
      backend TEXT,
      workspace TEXT,
      title TEXT,
      started_at TEXT,
      last_seq INTEGER NOT NULL DEFAULT 0,
      last_ts TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      event_id UNINDEXED, session_id UNINDEXED, text
    );
  `);

  const listeners = new Set<(e: Event) => void>();

  const store: Store = {
    append(inputs) {
      const parsed = inputs.map((i) => {
        const withDefaults = makeEvent(i);
        return withDefaults;
      });
      const out: Event[] = [];
      const inserted: Event[] = [];
      const txn = db.transaction(() => {
        for (const input of parsed) {
          const existing = db
            .query("SELECT body FROM events WHERE id = ?")
            .get(input.id!) as { body: string } | null;
          if (existing) {
            out.push(parseEvent(JSON.parse(existing.body)));
            continue;
          }
          const sessionId = input.session_id;
          const last =
            (db
              .query("SELECT last_seq FROM sessions WHERE session_id = ?")
              .get(sessionId) as { last_seq: number } | null)?.last_seq ?? 0;
          const seq = last + 1;
          const candidate = { ...input, seq };
          const event = parseEvent(candidate); // throws -> rollback
          db.query(
            "INSERT INTO events(id,session_id,seq,ts,type,backend,body) VALUES(?,?,?,?,?,?,?)",
          ).run(
            event.id,
            event.session_id,
            event.seq,
            event.ts,
            event.type,
            event.source.backend,
            JSON.stringify(event),
          );
          if (event.type === "session.started") {
            const d = event.data;
            db.query(
              `INSERT INTO sessions(session_id,backend,workspace,title,started_at,last_seq,last_ts)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(session_id) DO UPDATE SET
                 backend=excluded.backend, workspace=excluded.workspace,
                 title=COALESCE(excluded.title, sessions.title),
                 started_at=MIN(sessions.started_at, excluded.started_at),
                 last_seq=MAX(sessions.last_seq, excluded.last_seq),
                 last_ts=MAX(sessions.last_ts, excluded.last_ts)`,
            ).run(sessionId, event.source.backend, d.workspace, d.title ?? null, event.ts, seq, event.ts);
          } else {
            db.query(
              `INSERT INTO sessions(session_id,backend,started_at,last_seq,last_ts)
               VALUES(?,?,?,?,?)
               ON CONFLICT(session_id) DO UPDATE SET
                 last_seq=MAX(sessions.last_seq, excluded.last_seq),
                 last_ts=MAX(sessions.last_ts, excluded.last_ts),
                 started_at=MIN(sessions.started_at, excluded.started_at)`,
            ).run(sessionId, event.source.backend, event.ts, seq, event.ts);
          }
          const text = ftsText(event);
          if (text.trim()) {
            db.query(
              "INSERT INTO events_fts(event_id,session_id,text) VALUES(?,?,?)",
            ).run(event.id, event.session_id, text);
          }
          out.push(event);
          inserted.push(event);
        }
      });
      txn();
      for (const e of inserted)
        for (const fn of listeners) {
          try {
            fn(e);
          } catch (err) {
            console.error("store subscriber error:", err);
          }
        }
      return out;
    },

    read({ session_id, after_seq = 0, limit = 500 }) {
      const rows = db
        .query(
          "SELECT body FROM events WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT ?",
        )
        .all(session_id, after_seq, limit) as { body: string }[];
      return rows.map((r) => parseEvent(JSON.parse(r.body)));
    },

    query(q) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      const useFts = q.text !== undefined && q.text.trim() !== "";
      let sql = useFts
        ? "SELECT e.body FROM events e JOIN events_fts f ON f.event_id = e.id"
        : "SELECT e.body FROM events e";
      if (useFts) {
        const terms = ftsQuote(q.text!);
        if (terms) {
          where.push("events_fts MATCH ?");
          params.push(terms);
        }
      }
      if (q.session_id !== undefined) {
        where.push("e.session_id = ?");
        params.push(q.session_id);
      }
      if (q.backend !== undefined) {
        where.push("e.backend = ?");
        params.push(q.backend);
      }
      if (q.types !== undefined && q.types.length > 0) {
        where.push(`e.type IN (${q.types.map(() => "?").join(",")})`);
        params.push(...q.types);
      }
      if (q.since !== undefined) {
        where.push("e.ts > ?");
        params.push(q.since);
      }
      if (q.until !== undefined) {
        where.push("e.ts <= ?");
        params.push(q.until);
      }
      if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
      if (useFts && q.order === undefined) {
        sql += " ORDER BY f.rank";
      } else {
        sql += ` ORDER BY e.session_id ${q.order === "desc" ? "DESC" : "ASC"}, e.seq ${q.order === "desc" ? "DESC" : "ASC"}`;
      }
      const limit = Math.min(q.limit ?? 500, 10_000);
      sql += " LIMIT ?";
      params.push(limit);
      if (q.offset !== undefined && q.offset > 0) {
        sql += " OFFSET ?";
        params.push(q.offset);
      }
      const rows = db.query(sql).all(...params) as { body: string }[];
      return rows.map((r) => parseEvent(JSON.parse(r.body)));
    },

    listSessions({ limit, backend } = {}) {
      let sql =
        "SELECT session_id,backend,workspace,title,started_at,last_seq,last_ts FROM sessions";
      const params: (string | number)[] = [];
      if (backend !== undefined) {
        sql += " WHERE backend=?";
        params.push(backend);
      }
      sql += " ORDER BY last_ts DESC";
      if (limit !== undefined) {
        sql += " LIMIT ?";
        params.push(limit);
      }
      return db.query(sql).all(...params) as SessionSummary[];
    },

    search(query, { session_id, limit } = {}) {
      const q = ftsQuote(query);
      if (!q) return [];
      let sql = `SELECT e.body, snippet(events_fts,2,'[',']','…',16) AS snip
                 FROM events_fts f JOIN events e ON e.id=f.event_id
                 WHERE events_fts MATCH ?`;
      const params: (string | number)[] = [q];
      if (session_id !== undefined) {
        sql += " AND f.session_id=?";
        params.push(session_id);
      }
      sql += " ORDER BY f.rank";
      if (limit !== undefined) {
        sql += " LIMIT ?";
        params.push(limit);
      }
      const rows = db.query(sql).all(...params) as { body: string; snip: string }[];
      return rows.map((r) => ({ event: parseEvent(JSON.parse(r.body)), snippet: r.snip }));
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    close() {
      db.close();
    },
  };
  return store;
}
