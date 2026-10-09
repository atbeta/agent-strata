// Reports the invariants the event store is meant to hold. Read-only.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { OPENCODE_MAPPER_VERSION } from "../packages/adapter-opencode/src/index";

const file =
  process.argv[2] ?? join(process.env.HOME || process.env.USERPROFILE || ".", ".agent-strata", "events.db");
const db = new Database(file, { readonly: true });
const count = (sql: string, ...params: string[]) =>
  (db.query(sql).get(...params) as { n: number }).n;

console.log(
  JSON.stringify(
    {
      file,
      events: count("SELECT COUNT(*) n FROM events"),
      sessions: count("SELECT COUNT(*) n FROM sessions"),
      streaming_snapshots_stored: count(
        `SELECT COUNT(*) n FROM events WHERE type='turn.assistant' AND json_extract(body,'$.data.partial')=1`,
      ),
      tool_calls: count("SELECT COUNT(*) n FROM events WHERE type='tool.call'"),
      tool_calls_outside_a_user_turn: count(
        `SELECT COUNT(*) n FROM events c WHERE c.type='tool.call'
           AND json_extract(c.body,'$.data.turn_id') NOT IN
             (SELECT json_extract(u.body,'$.data.turn_id') FROM events u
              WHERE u.type='turn.user' AND u.session_id=c.session_id)`,
      ),
      stale_opencode_sessions: count(
        "SELECT COUNT(*) n FROM sessions WHERE backend='opencode' AND (mapper IS NULL OR mapper <> ?)",
        OPENCODE_MAPPER_VERSION,
      ),
      file_changes: count("SELECT COUNT(*) n FROM events WHERE type='file.changed'"),
      file_changes_with_diff: count(
        `SELECT COUNT(*) n FROM events WHERE type='file.changed' AND json_extract(body,'$.data.diff') IS NOT NULL`,
      ),
      file_changes_with_call: count(
        `SELECT COUNT(*) n FROM events WHERE type='file.changed' AND json_extract(body,'$.data.call_id') IS NOT NULL`,
      ),
    },
    null,
    2,
  ),
);
