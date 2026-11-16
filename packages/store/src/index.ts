import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  EVENT_DATA_CLASS,
  Event,
  EventInput,
  REBUILDABLE_EVENT_TYPES,
  isEphemeralEvent,
  isStreamingSnapshot,
  makeEvent,
  parseEvent,
  type EventType,
} from "@agent-strata/schema";

export interface EventQuery {
  session_id?: string;
  backend?: string;
  types?: string[];
  since?: string;
  until?: string;
  /** cursor over (session_id, seq): only events past this stored sequence */
  after_seq?: number;
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
  /** mapping version that produced the session's rebuildable events; null until a rebuild records one */
  mapper: string | null;
}

export interface AppendOptions {
  /** backend connection or embedded generation that produced these events */
  origin?: string;
  /** live evidence may move a session to this origin; a historical sync may not */
  claimOrigin?: boolean;
  /** write only sessions still at these positions */
  ifUnchanged?: Record<string, number>;
}

export interface ReplaceOptions {
  /** the event types the new events stand in for; every other type is kept */
  replaceTypes: EventType[];
  /** recorded on the session so a later mapping change can tell it is stale */
  mapper?: string;
  /** connection reading the rebuild; never displaces an established origin */
  origin?: string;
}

export interface ClassStats {
  events: number;
  bytes: number;
}

export interface StoreStats {
  sessions: number;
  events: number;
  /** Sum of stored event bodies, not the size of the database file. */
  bytes: number;
  fts: number;
  oldest: string | null;
  newest: string | null;
  rebuildable: ClassStats;
  local: ClassStats;
}

export interface SessionClassStats {
  session_id: string;
  rebuildable: number;
  local: number;
  rebuildable_bytes: number;
  local_bytes: number;
}

export interface Store {
  append(inputs: EventInput[], opts?: AppendOptions): Event[];
  /**
   * Swap one session's events of `replaceTypes` for `inputs` in one
   * transaction. Subscribers are not called; the caller announces the rebuild.
   */
  replaceSession(session_id: string, inputs: EventInput[], opts: ReplaceOptions): number;
  read(opts: { session_id: string; after_seq?: number; limit?: number }): Event[];
  query(q: EventQuery): Event[];
  listSessions(opts?: { limit?: number; backend?: string }): SessionSummary[];
  sessionMapper(session_id: string): string | null;
  /** record the mapping behind a session that has none yet; a recorded one is kept */
  markMapper(session_id: string, mapper: string): void;
  /**
   * The backend revision a session's transcript was last imported at, absent
   * until one is recorded. Survives restarts, so a sync can tell "unchanged"
   * without fetching the transcript to find out.
   */
  sessionRevision(session_id: string): number | null;
  markRevision(session_id: string, rev: number): void;
  lastSeq(session_id: string): number;
  /**
   * Whether the stored projection still says this session is running, and the
   * position that answer was read at.
   *
   * The projection is derived: it replays events in order, and the last one
   * among the three that carry a run's ending decides. Reading it here rather
   * than scanning every event keeps the question cheap enough to ask once per
   * connection for every session the backend reports.
   *
   * `seq` and `ts` come back with it because the caller has to write a
   * correction that survives the store's id dedupe and does not move the
   * session up the list.
   */
  sessionRunning(session_id: string): { running: boolean; seq: number; ts?: string };
  /**
   * Every session the projection still calls running, with where it sits.
   *
   * The same question as `sessionRunning` asked of the whole store at once.
   * A correction at connect time has to act on sessions this process never
   * watched — that is the shape of the failure it exists for — and asking one
   * row at a time meant one query per stored session before the check could
   * even start.
   *
   * `workspace` rides along because the answer it is compared against comes
   * from the backend per directory: the status table is one instance's, and a
   * session belonging to another directory is not in it. Without the grouping
   * key a caller cannot tell "not running" from "asked the wrong instance".
   */
  runningSessions(): {
    session_id: string;
    backend: string;
    seq: number;
    ts?: string;
    workspace?: string;
    /** connection/generation whose live evidence last owned the session */
    origin?: string;
  }[];
  search(
    query: string,
    opts?: { session_id?: string; limit?: number },
  ): { event: Event; snippet: string }[];
  subscribe(fn: (e: Event) => void): () => void;
  close(): void;

  /** Counts and content bytes, split by what a rebuild can reproduce. */
  stats(): StoreStats;
  /** Per-session split, for a purge preview. Omit ids to count every session. */
  classCounts(session_ids?: string[]): SessionClassStats[];
  /** Sessions that carry a session.deleted event, however old. */
  deletedSessions(): string[];
  /** Remove every event, the session row and its revision marker. */
  deleteSessions(session_ids: string[]): number;
  /**
   * Remove only what an import can rebuild, keeping permissions, questions,
   * status and goals. A session left with no events is removed as a whole.
   */
  deleteRebuildable(session_ids: string[]): number;
  /** A compact copy of the live database. `:memory:` stores can be saved too. */
  backupTo(path: string): void;
  integrityCheck(): string[];
  /** Cheap housekeeping: query planner, FTS index, WAL checkpoint. */
  optimize(): void;
  /**
   * Rewrite the search index with the current segmentation.
   *
   * Called after startup rather than during it: on a large store this takes
   * seconds, and the window must not wait for it. Cheap and safe to call when
   * there is nothing to do — it checks the marker first.
   */
  reindex(): void;
  /** Whether `reindex` still has work, i.e. this store predates the current scheme. */
  reindexPending(): boolean;
  /** Rewrites the database file; can take a while on a large store. */
  vacuum(): void;
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

/**
 * Letters and digits of the scripts that do not put spaces between words.
 *
 * FTS5's `unicode61` tokenizer splits on word boundaries, and these scripts
 * have none: `全文搜索不支持中文` is one token to it, so a search for `搜索`
 * matches nothing and a search for the whole sentence matches only itself.
 * Splitting each character apart at index time gives the tokenizer the
 * boundaries it expects.
 */
const CJK = "\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF\\uAC00-\\uD7AF";
const CJK_RE = new RegExp(`[${CJK}]`);
const CJK_RUN_RE = new RegExp(`[${CJK}]+`, "gu");

/** Split CJK characters apart; leave everything else as the tokenizer left it. */
function ftsSegment(text: string): string {
  return text.replace(CJK_RUN_RE, (run) => ` ${Array.from(run).join(" ")} `).replace(/\s+/g, " ").trim();
}

/**
 * The MATCH expression for a search box's contents.
 *
 * Each run is a phrase, which is what keeps a two-character Chinese word from
 * matching the same two characters scattered through a sentence: in the
 * segmented index `中文` is stored as `中 文`, and the phrase `"中 文"`
 * requires them adjacent, where `"中" "文"` would also match `中国文字`.
 * A run of non-CJK text stays one word, so `FTS` and `performance` still match
 * exactly what `unicode61` would have matched before.
 *
 * Everything is quoted, so no input can reach FTS5 as an operator.
 */
function ftsMatchQuery(q: string): string {
  const phrases: string[] = [];
  for (const run of q.match(new RegExp(`[${CJK}]+|[\\p{L}\\p{N}_]+`, "gu")) ?? []) {
    const quoted =
      CJK_RE.test(run) ? Array.from(run).join(" ") : run;
    phrases.push(`"${quoted.replace(/"/g, '""')}"`);
  }
  return phrases.join(" ");
}

/**
 * Undo the spacing segmentation added, for display.
 *
 * A snippet comes back with a space between every two Chinese characters,
 * which is not how the text was written. Removing a space only when both
 * neighbours are CJK (or a highlight bracket around one) leaves the spacing
 * inside English text alone.
 */
function ftsTidySnippet(s: string): string {
  return s.replace(
    new RegExp(`(?<=[${CJK}\\]])\\s+(?=[${CJK}\\[\\]])`, "gu"),
    "",
  );
}

interface Parsed {
  event: EventInput;
  // only an explicit source clock may rewrite an already-stored event
  clock: string | undefined;
}

export function openStore(path: string | ":memory:"): Store {
  // SQLite does not create parent directories, so a first run against a fresh
  // ~/.agent-strata fails with SQLITE_CANTOPEN. Create it up front.
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
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
      last_ts TEXT,
      mapper TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      event_id UNINDEXED, session_id UNINDEXED, text
    );
    CREATE TABLE IF NOT EXISTS session_rev(
      session_id TEXT PRIMARY KEY,
      rev REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS store_meta(
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  const sessionColumns = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionColumns.some((c) => c.name === "mapper")) db.exec("ALTER TABLE sessions ADD COLUMN mapper TEXT");
  if (!sessionColumns.some((c) => c.name === "origin")) db.exec("ALTER TABLE sessions ADD COLUMN origin TEXT");

  // The index's segmentation is a property of the rows already written, not of
  // the schema: a store created before the CJK change holds the old single-token
  // Chinese text, and `CREATE TABLE IF NOT EXISTS` leaves it untouched.
  //
  // It cannot be rebuilt here. On a store of 50k events carrying 110 MB of text
  // the rebuild measured 14 s, and this runs before the window is shown — the
  // same shape of freeze that made startup wait on the sync it was supposed to
  // do in the background. So opening marks the work and returns; the caller
  // runs `reindex` when it can (the service does, after it is listening), and
  // until then search keeps answering from the rows already there, which are
  // still correct for everything except Chinese.
  const FTS_TEXT_SEGMENTED = "1";
  const metaGet = (k: string): string | undefined =>
    (db.query("SELECT v FROM store_meta WHERE k=?").get(k) as { v: string } | null)?.v;
  const metaSet = (k: string, v: string): void => {
    db.query("INSERT INTO store_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
  };
  // A store with no events has nothing to re-index, so a fresh database is
  // already current. Only an existing one can be behind.
  if (metaGet("fts_seg") === undefined) {
    const anyEvent = db.query("SELECT 1 AS x FROM events LIMIT 1").get();
    if (!anyEvent) metaSet("fts_seg", FTS_TEXT_SEGMENTED);
  }

  const listeners = new Set<(e: Event) => void>();

  const notify = (events: Event[]) => {
    for (const e of events)
      for (const fn of listeners) {
        try {
          fn(e);
        } catch (err) {
          console.error("store subscriber error:", err);
        }
      }
  };

  // Ephemeral events — a streaming snapshot, a tool's progress — are for the
  // live overlay, never for the log. Dropping them here rather than at each
  // call site is what makes "the log only holds durable events" true no matter
  // which writer reaches the store.
  const parseAll = (inputs: EventInput[]): Parsed[] =>
    inputs
      .filter((i) => !isStreamingSnapshot(i) && !isEphemeralEvent(i))
      .map((i) => ({ event: makeEvent(i), clock: i.ts }));

  // Runs inside a caller's transaction.
  const insertAll = (parsed: Parsed[], opts: AppendOptions = {}): { out: Event[]; inserted: Event[] } => {
    const out: Event[] = [];
    const inserted: Event[] = [];
    const positions = new Map<string, number>();
    for (const item of parsed) {
      const input = item.event;
      const expected = opts.ifUnchanged?.[input.session_id];
      if (expected !== undefined) {
        let position = positions.get(input.session_id);
        if (position === undefined) {
          position =
            (db
              .query("SELECT last_seq FROM sessions WHERE session_id=?")
              .get(input.session_id) as { last_seq: number } | null)?.last_seq ?? 0;
          positions.set(input.session_id, position);
        }
        if (position !== expected) continue;
      }
      const existing = db
        .query("SELECT body FROM events WHERE id = ?")
        .get(input.id!) as { body: string } | null;
      if (existing) {
        const stored = parseEvent(JSON.parse(existing.body));
        if (opts.origin !== undefined) {
          db.query("UPDATE sessions SET origin=? WHERE session_id=? AND origin IS NULL").run(
            opts.origin,
            stored.session_id,
          );
        }
        if (item.clock && item.clock !== stored.ts) {
          const next = parseEvent({ ...stored, ts: item.clock });
          db.query("UPDATE events SET ts=?, body=? WHERE id=?").run(
            next.ts,
            JSON.stringify(next),
            next.id,
          );
          db.query(
            `UPDATE sessions SET last_ts=(SELECT MAX(ts) FROM events WHERE session_id=?)
             WHERE session_id=?`,
          ).run(next.session_id, next.session_id);
          out.push(next);
          inserted.push(next);
          continue;
        }
        out.push(stored);
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
        if (event.type === "session.updated") {
          const d = event.data;
          if (d.title !== undefined) {
            db.query("UPDATE sessions SET title=? WHERE session_id=?").run(d.title, sessionId);
          }
          if (d.workspace !== undefined) {
            db.query("UPDATE sessions SET workspace=? WHERE session_id=?").run(d.workspace, sessionId);
          }
        }
      }
      if (opts.origin !== undefined) {
        db.query(
          "UPDATE sessions SET origin=? WHERE session_id=? AND (origin IS NULL OR ?=1)",
        ).run(opts.origin, sessionId, opts.claimOrigin === true ? 1 : 0);
      }
      const text = ftsText(event);
      if (text.trim()) {
        db.query(
          "INSERT INTO events_fts(event_id,session_id,text) VALUES(?,?,?)",
        ).run(event.id, event.session_id, ftsSegment(text));
      }
      out.push(event);
      inserted.push(event);
    }
    return { out, inserted };
  };

  const store: Store = {
    append(inputs, opts) {
      const parsed = parseAll(inputs);
      const result = db.transaction(() => insertAll(parsed, opts))();
      notify(result.inserted);
      return result.out;
    },

    replaceSession(session_id, inputs, { replaceTypes, mapper, origin }) {
      for (const i of inputs) {
        if (i.session_id !== session_id) {
          throw new Error(`event for ${i.session_id} in a rebuild of ${session_id}`);
        }
      }
      const parsed = parseAll(inputs);
      const marks = replaceTypes.map(() => "?").join(",");
      return db.transaction(() => {
        if (replaceTypes.length > 0) {
          db.query(
            `DELETE FROM events_fts WHERE event_id IN
               (SELECT id FROM events WHERE session_id=? AND type IN (${marks}))`,
          ).run(session_id, ...replaceTypes);
          db.query(`DELETE FROM events WHERE session_id=? AND type IN (${marks})`).run(
            session_id,
            ...replaceTypes,
          );
        }
        const { inserted } = insertAll(parsed, { origin });
        db.query(
          `UPDATE sessions SET
             last_ts=(SELECT MAX(ts) FROM events WHERE session_id=?),
             started_at=(SELECT MIN(ts) FROM events WHERE session_id=?)
           WHERE session_id=?`,
        ).run(session_id, session_id, session_id);
        if (mapper !== undefined) {
          db.query("UPDATE sessions SET mapper=? WHERE session_id=?").run(mapper, session_id);
        }
        return inserted.length;
      })();
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
        const terms = ftsMatchQuery(q.text!);
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
      if (q.after_seq !== undefined) {
        where.push("e.seq > ?");
        params.push(q.after_seq);
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
        "SELECT session_id,backend,workspace,title,started_at,last_seq,last_ts,mapper FROM sessions";
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

    sessionMapper(session_id) {
      const row = db.query("SELECT mapper FROM sessions WHERE session_id=?").get(session_id) as
        | { mapper: string | null }
        | null;
      return row?.mapper ?? null;
    },

    markMapper(session_id, mapper) {
      db.query("UPDATE sessions SET mapper=? WHERE session_id=? AND mapper IS NULL").run(mapper, session_id);
    },

    sessionRevision(session_id) {
      const row = db.query("SELECT rev FROM session_rev WHERE session_id=?").get(session_id) as
        | { rev: number }
        | null;
      return row?.rev ?? null;
    },

    markRevision(session_id, rev) {
      db.query(
        "INSERT INTO session_rev(session_id,rev) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET rev=excluded.rev",
      ).run(session_id, rev);
    },

    lastSeq(session_id) {
      const row = db.query("SELECT last_seq FROM sessions WHERE session_id=?").get(session_id) as
        | { last_seq: number }
        | null;
      return row?.last_seq ?? 0;
    },

    sessionRunning(session_id) {
      const head = db.query("SELECT last_seq, last_ts FROM sessions WHERE session_id=?").get(
        session_id,
      ) as { last_seq: number; last_ts: string | null } | null;
      if (!head) return { running: false, seq: 0 };
      // The four event types that decide whether the projection reads as
      // running. `session.started` and `session.updated` do not touch it, and
      // reading only these keeps the answer a single row rather than a replay.
      //
      // The body is parsed here instead of with `json_extract` so the query
      // does not depend on SQLite's JSON1 being compiled in, and one row is
      // cheaper to parse than the alternative of scanning every event.
      const last = db
        .query(
          `SELECT seq, ts, type, body FROM events
           WHERE session_id=? AND type IN ('session.status','session.ended','session.error','session.deleted')
           ORDER BY seq DESC LIMIT 1`,
        )
        .get(session_id) as { seq: number; ts: string; type: string; body: string } | null;
      if (!last) return { running: false, seq: head.last_seq, ts: head.last_ts ?? undefined };
      let state: string | undefined;
      try {
        state = (JSON.parse(last.body) as { data?: { state?: string } }).data?.state;
      } catch {
        // A body this store cannot read says nothing about the run either way.
        return { running: false, seq: head.last_seq, ts: head.last_ts ?? undefined };
      }
      return {
        running: last.type === "session.status" && state !== undefined && state !== "idle",
        seq: head.last_seq,
        ts: head.last_ts ?? undefined,
      };
    },

    runningSessions() {
      // The same answer as `sessionRunning`, asked once for every session.
      //
      // Correlating the last of the four deciding events per session is one
      // pass over the events table with an index on `session_id`, where asking
      // one session at a time was one query each before the caller could even
      // start. The join to `sessions` supplies the position and workspace the
      // correction needs; a session with no deciding event at all is not
      // running and does not appear.
      //
      // Oldest activity first. A caller that can only afford to check some of
      // them — the reconcile names a capped number to the server — wants the
      // ones that have been quiet longest: a mark that has not moved since
      // yesterday is a mark left behind, while a session that moved today may
      // well be running. Newest-first would spend the whole budget on live
      // sessions and never reach the stale ones at all.
      const rows = db
        .query(
          `SELECT e.session_id AS sid, e.type AS type, e.body AS body, s.backend AS backend,
                  s.last_seq AS head_seq, s.last_ts AS head_ts, s.workspace AS workspace, s.origin AS origin
           FROM events e
           JOIN (SELECT session_id, MAX(seq) AS seq FROM events
                 WHERE type IN ('session.status','session.ended','session.error','session.deleted')
                 GROUP BY session_id) last
             ON last.session_id = e.session_id AND last.seq = e.seq
           JOIN sessions s ON s.session_id = e.session_id
           ORDER BY COALESCE(s.last_ts, '') ASC, e.session_id ASC`,
        )
        .all() as {
        sid: string;
        type: string;
        body: string;
        backend: string | null;
        head_seq: number;
        head_ts: string | null;
        workspace: string | null;
        origin: string | null;
      }[];
      const out: {
        session_id: string;
        backend: string;
        seq: number;
        ts?: string;
        workspace?: string;
        origin?: string;
      }[] = [];
      for (const row of rows) {
        // Only a `session.status` that is not `idle` reads as running; an
        // ending of any kind is not. Parsed here rather than with
        // `json_extract`, for the reason `sessionRunning` gives.
        if (row.type !== "session.status") continue;
        let state: string | undefined;
        try {
          state = (JSON.parse(row.body) as { data?: { state?: string } }).data?.state;
        } catch {
          continue;
        }
        if (state === undefined || state === "idle") continue;
        out.push({
          session_id: row.sid,
          backend: row.backend ?? "",
          seq: row.head_seq,
          ts: row.head_ts ?? undefined,
          ...(row.workspace ? { workspace: row.workspace } : {}),
          ...(row.origin ? { origin: row.origin } : {}),
        });
      }
      return out;
    },

    search(query, { session_id, limit } = {}) {
      const q = ftsMatchQuery(query);
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
      return rows.map((r) => ({
        event: parseEvent(JSON.parse(r.body)),
        snippet: ftsTidySnippet(r.snip),
      }));
    },

    stats() {
      const totals = db
        .query(
          "SELECT COUNT(*) AS events, COALESCE(SUM(length(body)),0) AS bytes, MIN(ts) AS oldest, MAX(ts) AS newest FROM events",
        )
        .get() as { events: number; bytes: number; oldest: string | null; newest: string | null };
      const sessions = (
        db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }
      ).n;
      const fts = (db.query("SELECT COUNT(*) AS n FROM events_fts").get() as { n: number }).n;
      const byType = db
        .query(
          "SELECT type, COUNT(*) AS events, COALESCE(SUM(length(body)),0) AS bytes FROM events GROUP BY type",
        )
        .all() as { type: EventType; events: number; bytes: number }[];
      const rebuildable: ClassStats = { events: 0, bytes: 0 };
      const local: ClassStats = { events: 0, bytes: 0 };
      for (const row of byType) {
        const bucket = EVENT_DATA_CLASS[row.type] === "local" ? local : rebuildable;
        bucket.events += row.events;
        bucket.bytes += row.bytes;
      }
      return { ...totals, sessions, fts, rebuildable, local };
    },

    classCounts(session_ids) {
      const useFilter = session_ids !== undefined && session_ids.length > 0;
      const marks = useFilter ? session_ids.map(() => "?").join(",") : "";
      const rows = db
        .query(
          `SELECT session_id, type, COUNT(*) AS events, COALESCE(SUM(length(body)),0) AS bytes
             FROM events${useFilter ? ` WHERE session_id IN (${marks})` : ""}
             GROUP BY session_id, type`,
        )
        .all(...(useFilter ? session_ids : [])) as {
        session_id: string;
        type: EventType;
        events: number;
        bytes: number;
      }[];
      const out = new Map<string, SessionClassStats>();
      if (session_ids) {
        for (const id of session_ids) {
          out.set(id, {
            session_id: id,
            rebuildable: 0,
            local: 0,
            rebuildable_bytes: 0,
            local_bytes: 0,
          });
        }
      }
      for (const row of rows) {
        const entry = out.get(row.session_id) ?? {
          session_id: row.session_id,
          rebuildable: 0,
          local: 0,
          rebuildable_bytes: 0,
          local_bytes: 0,
        };
        if (EVENT_DATA_CLASS[row.type] === "local") {
          entry.local += row.events;
          entry.local_bytes += row.bytes;
        } else {
          entry.rebuildable += row.events;
          entry.rebuildable_bytes += row.bytes;
        }
        out.set(row.session_id, entry);
      }
      return [...out.values()].sort((a, b) => a.session_id.localeCompare(b.session_id));
    },

    deletedSessions() {
      const rows = db
        .query("SELECT DISTINCT session_id FROM events WHERE type='session.deleted'")
        .all() as { session_id: string }[];
      return rows.map((r) => r.session_id);
    },

    deleteSessions(session_ids) {
      if (session_ids.length === 0) return 0;
      return db.transaction(() => {
        let deleted = 0;
        for (const id of session_ids) {
          deleted += (
            db.query("SELECT COUNT(*) AS n FROM events WHERE session_id=?").get(id) as {
              n: number;
            }
          ).n;
          db.query("DELETE FROM events_fts WHERE session_id=?").run(id);
          db.query("DELETE FROM events WHERE session_id=?").run(id);
          db.query("DELETE FROM sessions WHERE session_id=?").run(id);
          db.query("DELETE FROM session_rev WHERE session_id=?").run(id);
        }
        return deleted;
      })();
    },

    deleteRebuildable(session_ids) {
      if (session_ids.length === 0) return 0;
      const marks = REBUILDABLE_EVENT_TYPES.map(() => "?").join(",");
      return db.transaction(() => {
        let deleted = 0;
        for (const id of session_ids) {
          const before = (
            db.query("SELECT COUNT(*) AS n FROM events WHERE session_id=?").get(id) as {
              n: number;
            }
          ).n;
          db.query(
            `DELETE FROM events_fts WHERE event_id IN
               (SELECT id FROM events WHERE session_id=? AND type IN (${marks}))`,
          ).run(id, ...REBUILDABLE_EVENT_TYPES);
          db.query(`DELETE FROM events WHERE session_id=? AND type IN (${marks})`).run(
            id,
            ...REBUILDABLE_EVENT_TYPES,
          );
          const left = (
            db.query("SELECT COUNT(*) AS n FROM events WHERE session_id=?").get(id) as {
              n: number;
            }
          ).n;
          deleted += before - left;
          if (left === 0) {
            db.query("DELETE FROM sessions WHERE session_id=?").run(id);
            db.query("DELETE FROM session_rev WHERE session_id=?").run(id);
          } else {
            // The transcript is gone, so the next sync has to rebuild it; the
            // local-only facts keep the session and its title.
            db.query(
              `UPDATE sessions SET
                 last_seq=COALESCE((SELECT MAX(seq) FROM events WHERE session_id=?), 0),
                 last_ts=(SELECT MAX(ts) FROM events WHERE session_id=?),
                 started_at=(SELECT MIN(ts) FROM events WHERE session_id=?),
                 mapper=NULL
               WHERE session_id=?`,
            ).run(id, id, id, id);
            db.query("DELETE FROM session_rev WHERE session_id=?").run(id);
          }
        }
        return deleted;
      })();
    },

    backupTo(path) {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
      const escaped = path.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escaped}'`);
    },

    integrityCheck() {
      const rows = db.query("PRAGMA integrity_check").all() as Record<string, unknown>[];
      return rows.map((row) => String(Object.values(row)[0] ?? "")).filter(Boolean);
    },

    reindexPending() {
      return metaGet("fts_seg") !== FTS_TEXT_SEGMENTED;
    },

    reindex() {
      if (!this.reindexPending()) return;
      db.transaction(() => {
        db.exec("DELETE FROM events_fts");
        // `ftsText` reads the stored body, so the rebuild sees exactly what the
        // write path saw and cannot drift from it.
        const rows = db.query("SELECT id, session_id, body FROM events").all() as {
          id: string;
          session_id: string;
          body: string;
        }[];
        const ins = db.query("INSERT INTO events_fts(event_id,session_id,text) VALUES(?,?,?)");
        for (const row of rows) {
          let event: Event;
          try {
            event = parseEvent(JSON.parse(row.body));
          } catch {
            continue;
          }
          const text = ftsText(event);
          if (text.trim()) ins.run(row.id, row.session_id, ftsSegment(text));
        }
        metaSet("fts_seg", FTS_TEXT_SEGMENTED);
      })();
      db.exec("INSERT INTO events_fts(events_fts) VALUES('optimize')");
    },

    optimize() {
      db.exec("PRAGMA optimize");
      db.exec("INSERT INTO events_fts(events_fts) VALUES('optimize')");
      if (path !== ":memory:") {
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {
          // No WAL, or a reader holding it open. Housekeeping is best-effort.
        }
      }
    },

    vacuum() {
      db.exec("VACUUM");
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
