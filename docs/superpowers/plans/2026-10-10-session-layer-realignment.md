# 回到"会话层"：架构校正实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent-strata 从"一个 OpenCode 桌面客户端"拉回"跨后端的 agent 会话层"：事件库变成可重建的缓存、流式快照不再落库、后端专有逻辑回到 adapter、读路径不再每次全量投影，并让 ACP 作为第二个真实后端跑通。

**Architecture:** 事件日志（store）只保存持久事实；OpenCode 导入的会话按 mapper 版本可整体重建；生成中的消息走服务端内存覆盖层（LiveOverlay）经 SSE 推送；diff 由各 adapter 产出并带 `call_id`，projector 不再认识任何后端的工具参数；服务端缓存每个会话的事件与投影；service 通过驱动注册同时连接 OpenCode（HTTP/SSE）与 ACP（stdio 子进程）。

**Tech Stack:** Bun 1.3（`bun:sqlite`、`bun test`）、TypeScript 5.5、zod 3、`@opencode-ai/sdk` v2、`@agentclientprotocol/sdk` 0.21、`diff` 5.2、Solid + Vite（桌面 UI）。

## Global Constraints

- 运行环境是 Windows PowerShell 5.1：**不要用 `&&` 串联命令**，逐条执行；判断 `bun run typecheck` 成败看 `$LASTEXITCODE`（它会把 `$ tsc ...` 打到 stderr，PowerShell 显示成红字 NativeCommandError，这不是失败）。
- 每个任务结束必须：`bun test` 全绿（3 个 e2e 用例 skip 是正常的）、`bun run typecheck` 后 `$LASTEXITCODE` 为 0；改了 UI 的任务额外跑 `bun --cwd apps/desktop/ui run typecheck`。
- 代码注释只写代码本身表达不了的约束，用英文，风格对齐现有代码；不要写"这里改了什么/为什么这么改"之类面向评审的注释。
- 提交信息沿用仓库风格：`type(scope): lower-case sentence`，英文。
- **UI 冻结**：除 Task 8、Task 10 明确列出的改动外，不改任何 UI 视觉、样式、文案；不改 `apps/desktop/DESIGN.md`。
- 本地开发数据库 `~/.agent-strata/events.db` 可以随意清空（用户已授权），因此**不写旧数据迁移**；但 `policy.json`、`connection.json`/`connections.json` 不要删。
- 根目录的 `.tmp-*.ts` 是用户的调试脚本，不要删除、不要提交。
- OpenCode 服务 `opencode serve` 运行在 `http://127.0.0.1:4096`，Task 11 会用到。
- 某一步的预期结果和实际不符、且原因不在本任务范围内时，**停下来报告**，不要去改计划外的代码。

## 规划时已核实的事实（执行者不需要再验证）

1. 本地库中 3283 个 `tool.call` 有 3268 个的 `turn_id` 是 assistant 消息 id 而不是用户 turn id。原因：`importSession` 先回放 part、后回放 `message.updated`，处理工具 part 时 `m.parentID` 还未知，`turn_id: m.parentID ?? part.messageID` 落到了消息 id。Task 5 修复。
2. OpenCode 的 `edit` 工具在 `state.metadata` 里自带 `diff`（统一 diff 字符串）和 `filediff: { file, patch, additions, deletions }`；`write` 工具的 metadata 有 `exists: boolean`（`false` 即新建文件），输入是 `{ filePath, content }`；`edit` 输入是 `{ filePath, oldString, newString }`。patch part 只有 `{ files: string[] }`，路径用正斜杠（`D:/x`），而工具输入用反斜杠（`D:\x`）。
3. `opencode acp` 可以作为 ACP 代理被现有 `connectAcpAgent` 连上（握手与 `newSession` 已验证）。通过 ACP 创建的会话同时会出现在 `opencode serve` 的会话列表里（同一份存储）。
4. 流式快照（`turn.assistant` 且 `partial: true`）目前每 150ms 落一次库，本地库里 `turn.assistant` 占 6.8MB，是体积最大的事件类型。
5. `GET /sessions` 对每个会话投影两次；最大会话的 view JSON 为 5.9MB，生成时前端每 80ms 防抖整份重拉。

## 文件结构

| 文件 | 职责 | 任务 |
| --- | --- | --- |
| `packages/schema/src/index.ts` | 新增 `isStreamingSnapshot`；`file.changed` 加 `call_id`、`whole_file` | 1, 5 |
| `packages/store/src/index.ts` | 拒绝落库流式快照；`replaceSession`、`sessionMapper`、`lastSeq`；`sessions.mapper` 列 | 1 |
| `packages/store/test/rebuild.test.ts`（新） | store 新能力的测试 | 1 |
| `packages/adapter-opencode/src/index.ts` | `Sink.publish/replaceSession`；快照分流；`snapshotEvents`/`rebuildEvents`/`rebuildSession`；延迟工具调用；从工具 metadata 产出 diff | 2, 4, 5 |
| `packages/adapter-opencode/test/opencode.test.ts` | 对应测试 | 2, 4, 5 |
| `packages/projector/src/index.ts` | 删除 OpenCode 专有的 diff 重建与 msg_id 推断；按 `call_id` 定位 turn | 6 |
| `packages/service/src/driver.ts` | `BackendSink`；驱动的 `mapperVersion`、`rebuild`、`sync(stale)` | 3, 4 |
| `packages/service/src/live.ts`（新） | 生成中消息的内存覆盖层 | 3 |
| `packages/service/src/views.ts`（新） | 会话事件与投影缓存 | 7 |
| `packages/service/src/connections.ts`（新） | 连接参数、端点标识、连接持久化 | 9 |
| `packages/service/src/acp-driver.ts`（新） | ACP 驱动 | 9 |
| `packages/service/src/opencode-driver.ts` | 透传重建能力 | 4 |
| `packages/service/src/index.ts` | 接线 | 3, 4, 7, 9 |
| `packages/adapter-acp/src/index.ts` | 策略可热切换；diff 带 `call_id`/`whole_file` | 9 |
| `apps/desktop/ui/src/live.ts`（新） | 前端就地合并流式快照 | 8 |
| `apps/desktop/ui/src/session-detail.tsx`、`App.tsx`、`api.ts`、`transcript-format.ts`、`locales/*/shell.ts` | 最小 UI 改动 | 8, 10 |
| `scripts/check-store.ts`（新） | 事件库不变式检查 | 11 |
| `README.md` | 定位与数据模型说明 | 11 |

---

### Task 0: 基线与收尾当前未提交的改动

**Files:**
- Modify: `.gitignore`
- Commit: 当前工作区里已有的未提交改动（`apps/desktop/ui/src/{api.ts,session-detail.tsx,transcript.tsx,virtual.tsx}`、`packages/adapter-opencode/src/index.ts`、`packages/projector/src/index.ts`、`packages/projector/test/projector.test.ts`、`packages/schema/src/index.ts`）以及本计划文件

- [ ] **Step 1: 忽略临时文件**

在 `.gitignore` 末尾追加一行：

```gitignore
.tmp-*
```

- [ ] **Step 2: 确认基线全绿**

Run: `bun test`
Expected: `0 fail`，3 个 e2e skip。

Run: `bun run typecheck` 然后 `echo $LASTEXITCODE`
Expected: `0`

Run: `bun --cwd apps/desktop/ui run typecheck` 然后 `echo $LASTEXITCODE`
Expected: `0`

- [ ] **Step 3: 确认临时文件已被忽略**

Run: `git status --short`
Expected: 不再出现 `.tmp-virt.ts`、`.tmp-virt2.ts`。

- [ ] **Step 4: 提交**

```powershell
git add .gitignore apps/desktop/ui/src/api.ts apps/desktop/ui/src/session-detail.tsx apps/desktop/ui/src/transcript.tsx apps/desktop/ui/src/virtual.tsx packages/adapter-opencode/src/index.ts packages/projector/src/index.ts packages/projector/test/projector.test.ts packages/schema/src/index.ts docs/superpowers/plans/2026-10-10-session-layer-realignment.md
git commit -m "feat(projector,desktop-ui): place tool calls beside the message that declared them"
```

---

### Task 1: store 只存持久事实，并支持按会话重建

**Files:**
- Modify: `packages/schema/src/index.ts`
- Modify: `packages/store/src/index.ts`（整文件替换）
- Create: `packages/store/test/rebuild.test.ts`

**Interfaces:**
- Produces:
  - `isStreamingSnapshot(e: { type: string; data: unknown }): boolean`（schema）
  - `Store.replaceSession(session_id: string, inputs: EventInput[], opts: ReplaceOptions): number`
  - `ReplaceOptions = { replaceTypes: EventType[]; mapper?: string }`
  - `Store.sessionMapper(session_id: string): string | null`
  - `Store.lastSeq(session_id: string): number`
  - `SessionSummary.mapper: string | null`
  - `Store.append` 静默丢弃流式快照

- [ ] **Step 1: 写失败的测试**

Create `packages/store/test/rebuild.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { openStore } from "../src/index";
import { makeEvent, type EventInput } from "@agent-strata/schema";

const e = (session_id: string, type: string, data: object, id?: string): EventInput =>
  makeEvent({
    session_id,
    source: { backend: "test" },
    type,
    data,
    ...(id ? { id } : {}),
  } as EventInput);

describe("store: durable facts and rebuilds", () => {
  test("streaming snapshots are never stored", () => {
    const s = openStore(":memory:");
    s.append([
      e("s1", "session.started", { workspace: "/w" }),
      e("s1", "turn.assistant", { turn_id: "t", msg_id: "m", partial: true, content: [{ type: "text", text: "he" }] }),
      e("s1", "turn.assistant", { turn_id: "t", msg_id: "m", content: [{ type: "text", text: "hello" }] }),
    ]);
    const evs = s.read({ session_id: "s1" });
    expect(evs.map((x) => x.type)).toEqual(["session.started", "turn.assistant"]);
    expect((evs[1]!.data as { partial?: boolean }).partial).toBeUndefined();
    s.close();
  });

  test("replaceSession swaps the rebuildable types and keeps the rest", () => {
    const s = openStore(":memory:");
    s.append([
      e("s1", "session.started", { workspace: "/w", title: "old" }, "start"),
      e("s1", "tool.call", { turn_id: "t", call_id: "c", tool: "bash", input: {} }, "call"),
      e("s1", "permission.requested", { request_id: "r", call_id: "c", tool: "bash", input: {} }, "perm"),
    ]);
    const heard: string[] = [];
    s.subscribe((x) => heard.push(x.type));
    const n = s.replaceSession(
      "s1",
      [
        e("s1", "session.started", { workspace: "/w", title: "new" }, "start"),
        e("s1", "tool.call", { turn_id: "t", call_id: "c", tool: "grep", input: { pattern: "needle" } }, "call"),
      ],
      { replaceTypes: ["session.started", "tool.call"], mapper: "test-1" },
    );
    expect(n).toBe(2);
    expect(heard).toEqual([]);
    const evs = s.read({ session_id: "s1" });
    expect(evs.map((x) => x.type).sort()).toEqual(["permission.requested", "session.started", "tool.call"]);
    expect(evs.find((x) => x.type === "tool.call")!.data).toMatchObject({ tool: "grep" });
    const row = s.listSessions().find((r) => r.session_id === "s1")!;
    expect(row.title).toBe("new");
    expect(row.mapper).toBe("test-1");
    expect(s.sessionMapper("s1")).toBe("test-1");
    // the replaced call's text left the index with it
    expect(s.search("bash", { session_id: "s1" })).toHaveLength(0);
    expect(s.search("needle", { session_id: "s1" })).toHaveLength(1);
    s.close();
  });

  test("replaceSession refuses another session's events", () => {
    const s = openStore(":memory:");
    expect(() =>
      s.replaceSession("s1", [e("s2", "session.started", { workspace: "/w" })], { replaceTypes: ["session.started"] }),
    ).toThrow();
    s.close();
  });

  test("lastSeq and sessionMapper for known and unknown sessions", () => {
    const s = openStore(":memory:");
    s.append([e("s1", "session.started", { workspace: "/w" }), e("s1", "turn.user", { turn_id: "t", content: [] })]);
    expect(s.lastSeq("s1")).toBe(2);
    expect(s.lastSeq("nope")).toBe(0);
    expect(s.sessionMapper("s1")).toBeNull();
    expect(s.sessionMapper("nope")).toBeNull();
    s.close();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/store/test/rebuild.test.ts`
Expected: FAIL（`replaceSession is not a function` 等）。

- [ ] **Step 3: schema 增加判定函数**

在 `packages/schema/src/index.ts` 中 `makeEvent` 函数之后、`DEFAULT_SECRET_PATTERNS` 之前插入：

```ts
/** A mid-generation snapshot: shown while it lasts, superseded by the completed message, never stored. */
export function isStreamingSnapshot(e: { type: string; data: unknown }): boolean {
  return e.type === "turn.assistant" && (e.data as { partial?: unknown }).partial === true;
}
```

- [ ] **Step 4: 用以下内容整体替换 `packages/store/src/index.ts`**

```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  Event,
  EventInput,
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

export interface ReplaceOptions {
  /** the event types the new events stand in for; every other type is kept */
  replaceTypes: EventType[];
  /** recorded on the session so a later mapping change can tell it is stale */
  mapper?: string;
}

export interface Store {
  append(inputs: EventInput[]): Event[];
  /**
   * Swap one session's events of `replaceTypes` for `inputs` in one
   * transaction. Subscribers are not called; the caller announces the rebuild.
   */
  replaceSession(session_id: string, inputs: EventInput[], opts: ReplaceOptions): number;
  read(opts: { session_id: string; after_seq?: number; limit?: number }): Event[];
  query(q: EventQuery): Event[];
  listSessions(opts?: { limit?: number; backend?: string }): SessionSummary[];
  sessionMapper(session_id: string): string | null;
  lastSeq(session_id: string): number;
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
  `);
  const sessionColumns = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!sessionColumns.some((c) => c.name === "mapper")) db.exec("ALTER TABLE sessions ADD COLUMN mapper TEXT");

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

  const parseAll = (inputs: EventInput[]): Parsed[] =>
    inputs
      .filter((i) => !isStreamingSnapshot(i))
      .map((i) => ({ event: makeEvent(i), clock: i.ts }));

  // Runs inside a caller's transaction.
  const insertAll = (parsed: Parsed[]): { out: Event[]; inserted: Event[] } => {
    const out: Event[] = [];
    const inserted: Event[] = [];
    for (const item of parsed) {
      const input = item.event;
      const existing = db
        .query("SELECT body FROM events WHERE id = ?")
        .get(input.id!) as { body: string } | null;
      if (existing) {
        const stored = parseEvent(JSON.parse(existing.body));
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
      const text = ftsText(event);
      if (text.trim()) {
        db.query(
          "INSERT INTO events_fts(event_id,session_id,text) VALUES(?,?,?)",
        ).run(event.id, event.session_id, text);
      }
      out.push(event);
      inserted.push(event);
    }
    return { out, inserted };
  };

  const store: Store = {
    append(inputs) {
      const parsed = parseAll(inputs);
      const result = db.transaction(() => insertAll(parsed))();
      notify(result.inserted);
      return result.out;
    },

    replaceSession(session_id, inputs, { replaceTypes, mapper }) {
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
        const { inserted } = insertAll(parsed);
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

    lastSeq(session_id) {
      const row = db.query("SELECT last_seq FROM sessions WHERE session_id=?").get(session_id) as
        | { last_seq: number }
        | null;
      return row?.last_seq ?? 0;
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
```

- [ ] **Step 5: 运行新测试**

Run: `bun test packages/store/test/rebuild.test.ts`
Expected: 4 pass。

- [ ] **Step 6: 全量回归**

Run: `bun test`
Expected: `0 fail`。如果 `packages/adapter-opencode/test/opencode.test.ts` 里有用例断言"流式快照存进了 store"，那是旧行为：把该断言改成"store 里没有 `partial: true` 的 `turn.assistant`"，其余不动。

Run: `bun run typecheck`，然后 `echo $LASTEXITCODE` → `0`

- [ ] **Step 7: 提交**

```powershell
git add packages/schema/src/index.ts packages/store/src/index.ts packages/store/test/rebuild.test.ts
git commit -m "feat(store,schema): keep streaming snapshots out of the log and rebuild a session in place"
```

---

### Task 2: OpenCode adapter 把流式快照分流给 `publish`

**Files:**
- Modify: `packages/adapter-opencode/src/index.ts`（`Sink` 接口、`createIngestor` 的 `emit`）
- Test: `packages/adapter-opencode/test/opencode.test.ts`

**Interfaces:**
- Consumes: `isStreamingSnapshot`（Task 1）、`EventType`（schema）
- Produces:
  ```ts
  export interface Sink {
    append(events: EventInput[]): unknown;
    publish?(events: EventInput[]): void;
    replaceSession?(sessionId: string, events: EventInput[], opts: { replaceTypes: EventType[]; mapper?: string }): unknown;
  }
  ```

- [ ] **Step 1: 写失败的测试**

在 `opencode.test.ts` 的 `describe("createIngestor seam", ...)` 块内，最后一个 `test` 之后追加：

```ts
  test("streaming snapshots go to publish, never to append", () => {
    const appended: EventInput[] = [];
    const published: EventInput[] = [];
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: {
        append: (e) => appended.push(...e),
        publish: (e) => published.push(...e),
      },
      reply: async () => {},
    });
    for (const e of basicFixture()) ing.handle(e);
    expect(
      appended.some((e) => e.type === "turn.assistant" && (e.data as { partial?: boolean }).partial === true),
    ).toBe(false);
    expect(appended.some((e) => e.type === "turn.assistant")).toBe(true);
    expect(published.map((e) => e.type)).toEqual(["turn.assistant"]);
    expect(published[0]!.data).toMatchObject({ partial: true, msg_id: "a1" });
  });
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts -t "streaming snapshots go to publish"`
Expected: FAIL（`published` 为空，或 TS 报 `publish` 不在 `Sink` 上）。

- [ ] **Step 3: 实现**

把文件顶部的 import 改为：

```ts
import { createOpencodeClient, type Event, type OpencodeClient, type Part } from "@opencode-ai/sdk/v2";
import {
  isStreamingSnapshot,
  makeEvent,
  type ContentBlock,
  type EventInput,
  type EventType,
} from "@agent-strata/schema";
import { evaluate, type Policy } from "@agent-strata/policy";
```

把 `Sink` 接口替换为：

```ts
export interface Sink {
  append(events: EventInput[]): unknown;
  /** live-only state such as a message still being written; never stored */
  publish?(events: EventInput[]): void;
  replaceSession?(
    sessionId: string,
    events: EventInput[],
    opts: { replaceTypes: EventType[]; mapper?: string },
  ): unknown;
}
```

把 `createIngestor` 里的 `emit` 替换为：

```ts
  const emit = (evts: EventInput[]) => {
    const live = evts.filter(isStreamingSnapshot);
    const durable = live.length ? evts.filter((e) => !isStreamingSnapshot(e)) : evts;
    if (durable.length) sink.append(durable);
    if (live.length) sink.publish?.(live);
  };
```

- [ ] **Step 4: 运行测试**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts`
Expected: 全部 pass。

- [ ] **Step 5: 全量回归 + 类型检查**

Run: `bun test` → `0 fail`；`bun run typecheck`，`echo $LASTEXITCODE` → `0`

- [ ] **Step 6: 提交**

```powershell
git add packages/adapter-opencode/src/index.ts packages/adapter-opencode/test/opencode.test.ts
git commit -m "feat(adapter-opencode): publish streaming snapshots instead of storing them"
```

---

### Task 3: service 的生成中消息覆盖层

**Files:**
- Create: `packages/service/src/live.ts`
- Modify: `packages/service/src/driver.ts`（新增 `BackendSink`）
- Modify: `packages/service/src/index.ts`
- Test: `packages/service/test/service.test.ts`

**Interfaces:**
- Consumes: `Store.replaceSession`（Task 1）、`Sink.publish`（Task 2）
- Produces:
  - `class LiveOverlay { put(e: EventInput): boolean; settle(e: Event): void; has(sessionId: string): boolean; events(sessionId: string, afterSeq: number): Event[]; version: number }`
  - `interface BackendSink { append(events: EventInput[]): unknown; publish(events: EventInput[]): void; replaceSession(sessionId: string, events: EventInput[], opts: { replaceTypes: EventType[]; mapper?: string }): number }`
  - `RunningService.sink: BackendSink`
  - SSE 新增 `{ type: "session.rebuilt", session_id }` 消息；流式快照也经 SSE 广播（它们没有 `seq`）

- [ ] **Step 1: 写失败的测试**

在 `service.test.ts` 的 `describe("agent-strata service", ...)` 内追加：

```ts
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

    // a message that never finished is dropped once the session goes idle
    svc.sink.publish([
      ev(sid, "turn.assistant", { turn_id: "t3", msg_id: "m3", partial: true, content: [{ type: "text", text: "lost" }] }, "2026-01-01T00:00:07Z"),
    ]);
    expect((await view()).turns.some((t: { turn_id: string }) => t.turn_id === "t3")).toBe(true);
    svc.store.append([ev(sid, "session.status", { state: "idle" }, "2026-01-01T00:00:08Z")]);
    expect((await view()).turns.some((t: { turn_id: string }) => t.turn_id === "t3")).toBe(false);

    svc.stop();
  });
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/service/test/service.test.ts -t "still being written"`
Expected: FAIL（`svc.sink` 为 undefined）。

- [ ] **Step 3: 新建 `packages/service/src/live.ts`**

```ts
import { parseEvent, type Event, type EventInput } from "@agent-strata/schema";

/**
 * Assistant messages still being written. Readers see them; the log never
 * does. The completed message, or the session going idle, retires them.
 */
export class LiveOverlay {
  private bySession = new Map<string, Map<string, EventInput>>();
  /** bumps on every change, for callers that cache what they derive from it */
  version = 0;

  put(e: EventInput): boolean {
    if (e.type !== "turn.assistant" || !e.data.msg_id) return false;
    let messages = this.bySession.get(e.session_id);
    if (!messages) {
      messages = new Map();
      this.bySession.set(e.session_id, messages);
    }
    messages.set(e.data.msg_id, e);
    this.version++;
    return true;
  }

  settle(e: Event): void {
    const messages = this.bySession.get(e.session_id);
    if (!messages) return;
    const ends =
      (e.type === "session.status" && e.data.state === "idle") ||
      e.type === "session.ended" ||
      e.type === "session.deleted";
    if (ends) {
      this.bySession.delete(e.session_id);
      this.version++;
      return;
    }
    if (e.type === "turn.assistant" && e.data.msg_id && e.data.partial !== true) {
      if (messages.delete(e.data.msg_id)) this.version++;
      if (messages.size === 0) this.bySession.delete(e.session_id);
    }
  }

  has(sessionId: string): boolean {
    return (this.bySession.get(sessionId)?.size ?? 0) > 0;
  }

  /** The live messages numbered after the stored ones, so a projection applies them last. */
  events(sessionId: string, afterSeq: number): Event[] {
    const messages = this.bySession.get(sessionId);
    if (!messages) return [];
    return [...messages.values()].map((e, i) =>
      parseEvent({ ...e, id: e.id ?? `live:${sessionId}:${i}`, seq: afterSeq + 1 + i }),
    );
  }
}
```

- [ ] **Step 4: `driver.ts` 增加 `BackendSink`**

在 `packages/service/src/driver.ts` 顶部注释之后插入：

```ts
import type { EventInput, EventType } from "@agent-strata/schema";

/** Where backends write: the log, the live overlay, and in-place rebuilds. */
export interface BackendSink {
  append(events: EventInput[]): unknown;
  publish(events: EventInput[]): void;
  replaceSession(
    sessionId: string,
    events: EventInput[],
    opts: { replaceTypes: EventType[]; mapper?: string },
  ): number;
}
```

- [ ] **Step 5: 接线 `packages/service/src/index.ts`**

5a. import 区：

```ts
import type { Event } from "@agent-strata/schema";
import type { BackendDriver, ModelChoice } from "./driver";
import { connectOpencodeDriver } from "./opencode-driver";
```

替换为：

```ts
import type { BackendDriver, BackendSink, ModelChoice } from "./driver";
import { connectOpencodeDriver } from "./opencode-driver";
import { LiveOverlay } from "./live";
```

5b. `RunningService` 改为：

```ts
export interface RunningService {
  port: number;
  store: Store;
  sink: BackendSink;
  stop: () => void;
}
```

5c. 把

```ts
  const subscribers = new Set<(evt: Event) => void>();
  store.subscribe((e) => {
    for (const fn of subscribers) fn(e);
  });
```

替换为：

```ts
  const subscribers = new Set<(payload: unknown) => void>();
  const broadcast = (payload: unknown) => {
    for (const fn of subscribers) fn(payload);
  };
  const live = new LiveOverlay();
  store.subscribe((e) => {
    live.settle(e);
    broadcast(e);
  });
  const sink: BackendSink = {
    append: (events) => store.append(events),
    publish: (events) => {
      for (const e of events) if (live.put(e)) broadcast(e);
    },
    replaceSession: (sessionId, events, replace) => {
      const n = store.replaceSession(sessionId, events, replace);
      broadcast({ type: "session.rebuilt", session_id: sessionId });
      return n;
    },
  };
```

5d. 把

```ts
  const sessionView = (sessionId: string): SessionView =>
    projectSession(store.read({ session_id: sessionId, limit: 20_000 }));
```

替换为：

```ts
  const sessionView = (sessionId: string): SessionView => {
    const stored = store.read({ session_id: sessionId, limit: 20_000 });
    return projectSession([...stored, ...live.events(sessionId, stored.at(-1)?.seq ?? 0)]);
  };
```

5e. `connectOnce` 里 `connectOpencodeDriver({ sink: store, ...` 的 `sink: store` 改为 `sink,`。

5f. `/stream` 分支里：`let enqueue: ((evt: Event) => void) | undefined;` 改为 `let enqueue: ((payload: unknown) => void) | undefined;`；`enqueue = (evt) => write(\`data: ${JSON.stringify(evt)}\n\n\`);` 改为 `enqueue = (payload) => write(\`data: ${JSON.stringify(payload)}\n\n\`);`。

5g. 文件末尾 `return { port: ..., store, stop: ... }` 里在 `store,` 后面加 `sink,`。

- [ ] **Step 6: 运行测试**

Run: `bun test packages/service/test/service.test.ts`
Expected: 全部 pass。

- [ ] **Step 7: 全量回归 + 类型检查**

Run: `bun test` → `0 fail`；`bun run typecheck`，`echo $LASTEXITCODE` → `0`。如果 tsc 报 `Event` 未使用，删除对应 import。

- [ ] **Step 8: 提交**

```powershell
git add packages/service/src/live.ts packages/service/src/driver.ts packages/service/src/index.ts packages/service/test/service.test.ts
git commit -m "feat(service): show messages still being written without storing them"
```

---

### Task 4: OpenCode 会话可按 mapper 版本整体重建

**Files:**
- Modify: `packages/adapter-opencode/src/index.ts`
- Modify: `packages/service/src/driver.ts`
- Modify: `packages/service/src/opencode-driver.ts`
- Modify: `packages/service/src/index.ts`
- Test: `packages/adapter-opencode/test/opencode.test.ts`

**Interfaces:**
- Consumes: `Store.replaceSession`、`Store.sessionMapper`（Task 1）、`Sink.replaceSession`（Task 2）
- Produces（adapter-opencode）:
  - `export const OPENCODE_MAPPER_VERSION = "opencode-1"`（Task 5 会改成 `"opencode-2"`）
  - `export const OPENCODE_REBUILT_TYPES: EventType[]`
  - `export function snapshotEvents(sessionID: string, info: unknown, messages: SnapshotMessage[]): Event[]`
  - `export function rebuildEvents(events: Event[], directory?: string): EventInput[]`
  - `connectOpencode(...)` 返回值新增 `rebuildSession(sessionID: string, directory?: string): Promise<number>`；`refreshSessions(stale?: (casfId: string) => boolean): Promise<number>`
- Produces（service）:
  - `BackendDriver.mapperVersion?: string`
  - `BackendDriver.sync(stale?: (casfId: string) => boolean): Promise<number>`
  - `BackendDriver.rebuild(nativeId: string, directory?: string): Promise<number>`
  - 路由 `POST /sessions/:id/rebuild` → `{ ok: true, events: number }`

- [ ] **Step 1: 写失败的测试**

在 `opencode.test.ts` 顶部 import 改为：

```ts
import {
  normalizeOpencodeEvent,
  OpencodeMapper,
  createIngestor,
  snapshotEvents,
  rebuildEvents,
  OPENCODE_REBUILT_TYPES,
  OPENCODE_MAPPER_VERSION,
} from "../src/index";
import { loadPolicy } from "@agent-strata/policy";
import type { Event } from "@opencode-ai/sdk/v2";
import { openStore } from "@agent-strata/store";
import { projectSession } from "@agent-strata/projector";
import { makeEvent, type EventInput } from "@agent-strata/schema";
```

在 `basicFixture` 定义之后加：

```ts
// OpenCode's stored record of a session, as GET /session/:id and /session/:id/message return it
const snapshotFixture = (): Event[] => {
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
```

在文件末尾追加：

```ts
describe("rebuild from OpenCode's own record", () => {
  test("a rebuild maps only rebuildable, durable events", () => {
    const evs = rebuildEvents(snapshotFixture(), "/repo");
    expect(evs.every((e) => OPENCODE_REBUILT_TYPES.includes(e.type))).toBe(true);
    expect(evs.some((e) => e.type === "turn.assistant" && (e.data as { partial?: boolean }).partial)).toBe(false);
    expect(evs.map((e) => e.type).sort()).toEqual(
      ["session.started", "tool.call", "tool.result", "turn.assistant", "turn.user"].sort(),
    );
  });

  test("a rebuild replaces the transcript and keeps what only the live stream saw", () => {
    const store = openStore(":memory:");
    const casfId = `opencode:${sid}`;
    store.append([
      makeEvent({
        id: "opencode:pt3:tool.call",
        session_id: casfId,
        source: { backend: "opencode" },
        type: "tool.call",
        data: { turn_id: "a1", call_id: "call1", tool: "bash", input: {} },
      } as EventInput),
      makeEvent({
        id: "opencode:perm1:permission.requested",
        session_id: casfId,
        source: { backend: "opencode" },
        type: "permission.requested",
        data: { request_id: "perm1", call_id: "call1", tool: "bash", input: {} },
      } as EventInput),
    ]);
    store.replaceSession(casfId, rebuildEvents(snapshotFixture(), "/repo"), {
      replaceTypes: OPENCODE_REBUILT_TYPES,
      mapper: OPENCODE_MAPPER_VERSION,
    });
    const evs = store.read({ session_id: casfId });
    expect(evs.filter((e) => e.type === "tool.call")).toHaveLength(1);
    expect(evs.find((e) => e.type === "tool.call")!.data).toMatchObject({ input: { command: "ls" } });
    expect(evs.some((e) => e.type === "permission.requested")).toBe(true);
    expect(store.sessionMapper(casfId)).toBe(OPENCODE_MAPPER_VERSION);
    store.close();
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts -t "rebuild"`
Expected: FAIL（`snapshotEvents` 未导出）。

- [ ] **Step 3: adapter 实现纯函数部分**

在 `packages/adapter-opencode/src/index.ts` 中 `const STREAM_SNAPSHOT_MS = 150;` 之后插入：

```ts
/** Bump when the mapping changes; stored sessions mapped by an older version are rebuilt. */
export const OPENCODE_MAPPER_VERSION = "opencode-1";

/** The event types an import reproduces from OpenCode's own record of a session. */
export const OPENCODE_REBUILT_TYPES: EventType[] = [
  "session.started",
  "session.updated",
  "turn.user",
  "turn.assistant",
  "tool.call",
  "tool.result",
  "file.changed",
];

export interface SnapshotMessage {
  info: { id: string; role: string; time?: { completed?: number } };
  parts: Part[];
}

/** OpenCode's stored session, replayed as the bus events that would have built it. */
export function snapshotEvents(sessionID: string, info: unknown, messages: SnapshotMessage[]): Event[] {
  const part = (p: Part) =>
    ({
      id: `import:${p.id}`,
      type: "message.part.updated",
      properties: { sessionID, part: p, time: Date.now() },
    }) as unknown as Event;
  const out: Event[] = [
    { id: `import:${sessionID}`, type: "session.created", properties: { sessionID, info } } as unknown as Event,
  ];
  for (const m of messages) {
    const open = m.info.role === "assistant" && m.info.time?.completed === undefined;
    // parts first: a completed assistant message emits turn.assistant on message.updated
    for (const p of m.parts) out.push(part(p));
    out.push({
      id: `import:${m.info.id}`,
      type: "message.updated",
      properties: { sessionID, info: m.info },
    } as unknown as Event);
    // role and parent land on message.updated, so an in-progress assistant
    // only streams once the parts are applied a second time
    if (open) for (const p of m.parts) out.push(part(p));
  }
  return out;
}

/** Every rebuildable event for one session, mapped from scratch. */
export function rebuildEvents(events: Event[], directory?: string): EventInput[] {
  const mapper = new OpencodeMapper({ directory });
  return events
    .flatMap((e) => mapper.handle(e))
    .filter((e) => !isStreamingSnapshot(e) && OPENCODE_REBUILT_TYPES.includes(e.type));
}
```

- [ ] **Step 4: 运行纯函数测试**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts -t "rebuild"`
Expected: 2 pass。

- [ ] **Step 5: adapter 的连接层接上重建**

5a. `connectOpencode` 的返回类型里：

```ts
  refreshSessions: () => Promise<number>;
```

改为：

```ts
  refreshSessions: (stale?: (casfId: string) => boolean) => Promise<number>;
  rebuildSession: (sessionID: string, directory?: string) => Promise<number>;
```

5b. 删除 `const handlePart = ...` 和整个 `const importSession = async (...) => { ... };`，替换为：

```ts
  const readSession = async (sessionID: string, directory?: string): Promise<Event[]> => {
    const dir = directory ?? opts.directory;
    const sess = await client.session.get({ sessionID, directory: dir });
    if (!sess.data) throw new Error(`session ${sessionID} not found`);
    const msgs = await client.session.messages({ sessionID, directory: dir });
    return snapshotEvents(sessionID, sess.data, msgs.data ?? []);
  };
  const importSession = async (sessionID: string, directory?: string) => {
    for (const evt of await readSession(sessionID, directory)) ingestor.handle(evt);
  };
  const rebuildSession = async (sessionID: string, directory?: string): Promise<number> => {
    if (!opts.sink.replaceSession) throw new Error("this sink cannot rebuild sessions");
    const events = rebuildEvents(await readSession(sessionID, directory), opts.directory);
    await opts.sink.replaceSession(`opencode:${sessionID}`, events, {
      replaceTypes: OPENCODE_REBUILT_TYPES,
      mapper: OPENCODE_MAPPER_VERSION,
    });
    return events.length;
  };
```

5c. `refreshSessions` 改签名并在导入处分流：

```ts
    async refreshSessions(stale?: (casfId: string) => boolean) {
```

并把其中

```ts
            await importSession(info.id, info.directory || directory);
```

替换为：

```ts
            const dir = info.directory || directory;
            if (stale?.(`opencode:${info.id}`)) await rebuildSession(info.id, dir);
            else await importSession(info.id, dir);
```

5d. 返回对象末尾 `importSession,` 之后加 `rebuildSession,`。

- [ ] **Step 6: service 驱动接口**

在 `packages/service/src/driver.ts` 的 `BackendDriver` 中：

把

```ts
  /** pull metadata and transcripts that changed since the last sync */
  sync(): Promise<number>;
```

替换为：

```ts
  /** version of the mapping behind this backend's stored events; absent when they cannot be rebuilt */
  mapperVersion?: string;
  /** pull metadata and transcripts that changed since the last sync; stale sessions are rebuilt instead */
  sync(stale?: (casfId: string) => boolean): Promise<number>;
  /** replace a session's stored transcript with a fresh read of the backend's own record */
  rebuild(nativeId: string, directory?: string): Promise<number>;
```

- [ ] **Step 7: `opencode-driver.ts`**

import 加上 `OPENCODE_MAPPER_VERSION`：

```ts
import {
  connectOpencode,
  OPENCODE_MAPPER_VERSION,
  type OnAsk,
  type OnQuestion,
  type Sink,
} from "@agent-strata/adapter-opencode";
```

返回对象里 `directory: opts.directory,` 之后加：

```ts
    mapperVersion: OPENCODE_MAPPER_VERSION,
```

把 `sync: () => { ... }` 替换为：

```ts
    sync: (stale) => {
      if (syncing) return syncing;
      syncing = conn.refreshSessions(stale).finally(() => {
        syncing = undefined;
      });
      return syncing;
    },
    rebuild: (nativeId, directory) => conn.rebuildSession(nativeId, directory),
```

- [ ] **Step 8: service 使用重建**

8a. 在 `startService` 里 `const sink: BackendSink = { ... };` 之后加：

```ts
  const staleFor = (driver: BackendDriver) => (casfId: string) =>
    driver.mapperVersion !== undefined && store.sessionMapper(casfId) !== driver.mapperVersion;
  const syncDriver = (driver: BackendDriver) => driver.sync(staleFor(driver));
```

8b. 把三处 `sync()` 调用换成 `syncDriver(...)`：
- `void already.sync().catch(...)` → `void syncDriver(already).catch(...)`
- `void driver.sync().catch(...)` → `void syncDriver(driver).catch(...)`
- `/sync` 路由里 `imported += await conn.sync();` → `imported += await syncDriver(conn);`

8c. 会话命令路由正则改为：

```ts
      const sessionCmd = path.match(/^\/sessions\/([^/]+)\/(prompt|abort|import|rebuild|rename|archive)$/);
```

并在 `if (cmd === "import" && ...) { ... }` 块之后加：

```ts
        if (cmd === "rebuild" && req.method === "POST") {
          if (!conn.capabilities.import) return json({ error: "backend cannot rebuild" }, 400);
          try {
            const events = await conn.rebuild(native, directory);
            return json({ ok: true, events });
          } catch (e) {
            return json({ error: String(e) }, 502);
          }
        }
```

- [ ] **Step 9: 全量回归 + 类型检查**

Run: `bun test` → `0 fail`；`bun run typecheck`，`echo $LASTEXITCODE` → `0`

- [ ] **Step 10: 提交**

```powershell
git add packages/adapter-opencode/src/index.ts packages/adapter-opencode/test/opencode.test.ts packages/service/src/driver.ts packages/service/src/opencode-driver.ts packages/service/src/index.ts
git commit -m "feat(adapter-opencode,service): rebuild a stored session from OpenCode's own record when the mapping changes"
```

---

### Task 5: 修正 OpenCode 映射（工具调用的 turn、diff 来源）

**Files:**
- Modify: `packages/schema/src/index.ts`（`file.changed`）
- Modify: `packages/adapter-opencode/src/index.ts`
- Modify: `packages/adapter-opencode/package.json`
- Test: `packages/adapter-opencode/test/opencode.test.ts`

**Interfaces:**
- Consumes: `snapshotFixture`、`rebuildEvents`（Task 4）
- Produces:
  - `file.changed.data.call_id?: string`、`file.changed.data.whole_file?: boolean`
  - 成功的 `edit`/`write` 工具在 `tool.result` 之后紧跟一条 `file.changed`（id `opencode:<partId>:file`，带 `diff` 与 `call_id`）
  - patch part 不再重复报告同一消息里已由 edit/write 报告过的文件
  - 工具 part 早于其消息的 `message.updated` 到达时，`tool.call` 延迟到 `message.updated` 之后发出，`turn_id` 为用户 turn
  - `OPENCODE_MAPPER_VERSION = "opencode-2"`

- [ ] **Step 1: 写失败的测试**

在 `opencode.test.ts` 的 `describe("rebuild from OpenCode's own record", ...)` 块里追加：

```ts
  test("a stored session puts its calls in the user's turn", () => {
    const evs = rebuildEvents(snapshotFixture(), "/repo");
    expect(evs.map((e) => e.type)).toEqual([
      "session.started",
      "turn.user",
      "tool.call",
      "tool.result",
      "turn.assistant",
    ]);
    expect(evs.find((e) => e.type === "tool.call")!.data).toMatchObject({ turn_id: "u1", msg_id: "a1" });
  });
```

在文件末尾追加：

```ts
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts`
Expected: 新增的 4 个用例 FAIL。

- [ ] **Step 3: schema 扩展 `file.changed`**

在 `packages/schema/src/index.ts` 中把

```ts
  "file.changed": z.object({
    path: z.string(),
    change: z.enum(["add", "modify", "delete"]),
    diff: z.string().optional(),
  }),
```

替换为：

```ts
  "file.changed": z.object({
    path: z.string(),
    change: z.enum(["add", "modify", "delete"]),
    diff: z.string().optional(),
    /** the tool call that made the change, when one did */
    call_id: z.string().optional(),
    /** the diff is the whole file rather than a region of it */
    whole_file: z.boolean().optional(),
  }),
```

- [ ] **Step 4: adapter 依赖 `diff`**

把 `packages/adapter-opencode/package.json` 改为：

```json
{
  "name": "@agent-strata/adapter-opencode",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@agent-strata/policy": "workspace:*",
    "@agent-strata/schema": "workspace:*",
    "@opencode-ai/sdk": "1.18.35",
    "@agent-strata/store": "workspace:*",
    "@agent-strata/projector": "workspace:*",
    "diff": "5.2.0"
  },
  "devDependencies": {
    "@types/diff": "5.2.3"
  }
}
```

Run: `bun install`
Expected: 成功，`bun.lock` 更新。

- [ ] **Step 5: adapter 实现**

5a. 顶部加 import：

```ts
import { createPatch } from "diff";
```

5b. `OPENCODE_MAPPER_VERSION` 改为 `"opencode-2"`。

5c. 把 `interface MsgState { ... }` 替换为：

```ts
type ToolPart = Extract<Part, { type: "tool" }>;

interface ToolTrack {
  emittedCall: boolean;
  emittedResult: boolean;
  order: number;
  /** latest state of a part seen before its message named the turn */
  deferred?: ToolPart;
}

interface MsgState {
  role?: string;
  parentID?: string;
  created?: number;
  completed?: number;
  parts: Map<string, ContentBlock>;
  toolParts: Map<string, ToolTrack>;
  emittedAssistant: boolean;
  lastStreamAt?: number;
  patchSeen?: Set<string>;
  /** files a successful edit or write in this message already reported, by pathKey */
  editedPaths?: Set<string>;
}
```

5d. 在 `function sourceTime(...)` 之后加两个模块级函数：

```ts
/** One shape for a path: separators unified, and a Windows drive path compared without case. */
function pathKey(path: string): string {
  const p = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p;
}

/**
 * The change a finished edit or write made. An edit carries OpenCode's own
 * unified diff in its metadata; a write carries the whole new file.
 */
function fileChangeOf(
  tool: string,
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): { path: string; change: "add" | "modify"; diff: string; whole_file?: true } | undefined {
  const { filePath, oldString, newString, content } = input ?? {};
  if (typeof filePath !== "string") return undefined;
  if (tool === "edit") {
    const filediff = metadata?.filediff as { patch?: unknown } | undefined;
    const patch = typeof filediff?.patch === "string" ? filediff.patch : metadata?.diff;
    if (typeof patch === "string" && patch) return { path: filePath, change: "modify", diff: patch };
    if (typeof oldString === "string" && typeof newString === "string") {
      return { path: filePath, change: "modify", diff: createPatch(filePath, oldString, newString) };
    }
    return undefined;
  }
  if (tool === "write" && typeof content === "string") {
    return {
      path: filePath,
      change: metadata?.exists === false ? "add" : "modify",
      diff: createPatch(filePath, "", content),
      whole_file: true,
    };
  }
  return undefined;
}
```

5e. 在 `OpencodeMapper` 类里 `private flushUser(...) { ... }` 之后加方法：

```ts
  private toolEvents(s: SessionState, m: MsgState, part: ToolPart, t: ToolTrack): EventInput[] {
    const out: EventInput[] = [];
    const st = part.state;
    if (!t.emittedCall && st.status !== "pending") {
      t.emittedCall = true;
      out.push(
        this.ev(
          s,
          "tool.call",
          {
            turn_id: m.parentID ?? part.messageID,
            call_id: part.callID,
            tool: part.tool,
            input: st.input,
            order: t.order,
            // `order` counts only within this message. Naming the message
            // too is what lets a reader see a call beside the words that
            // asked for it instead of in a pile at the end of the turn.
            msg_id: part.messageID,
          },
          `opencode:${part.id}:tool.call`,
          sourceTime(st.time.start || s.updated),
        ),
      );
    }
    if (!t.emittedResult && (st.status === "completed" || st.status === "error")) {
      t.emittedResult = true;
      out.push(
        this.ev(
          s,
          "tool.result",
          {
            call_id: part.callID,
            status: st.status === "completed" ? "ok" : "error",
            output: st.status === "completed" ? st.output : st.error,
            latency_ms: Math.max(0, Math.round(st.time.end - st.time.start)),
          },
          `opencode:${part.id}:tool.result`,
          sourceTime(st.time.end || s.updated),
        ),
      );
      if (st.status === "completed") {
        const change = fileChangeOf(part.tool, st.input, st.metadata);
        if (change) {
          out.push(
            this.ev(
              s,
              "file.changed",
              { ...change, call_id: part.callID },
              `opencode:${part.id}:file`,
              sourceTime(st.time.end || s.updated),
            ),
          );
        }
      }
    }
    return out;
  }
```

5f. 在 `handle()` 的 `message.part.updated` 分支里，把整个 `} else if (part.type === "tool") { ... return out; }`（从 `// Parts are created in the order the model declared them` 注释开始，到发出 `tool.result` 之后的 `return out;` 为止）替换为：

```ts
        } else if (part.type === "tool") {
          // Parts are created in the order the model declared them, so first
          // sight is the declaration order. tool.call is not emitted until the
          // part leaves `pending`, which for parallel calls is the order they
          // actually started — record the ordinal so readers can restore the
          // order the model wrote.
          let t = m.toolParts.get(part.id);
          if (!t) {
            t = { emittedCall: false, emittedResult: false, order: m.toolParts.size };
            m.toolParts.set(part.id, t);
          }
          if (part.state.status === "completed") {
            const change = fileChangeOf(part.tool, part.state.input, part.state.metadata);
            if (change) (m.editedPaths ??= new Set()).add(pathKey(change.path));
          }
          // A call belongs to the user turn its message answers, and only
          // message.updated names that turn. A stored session replays parts
          // before their message, so the call waits for it.
          if (m.parentID === undefined) {
            t.deferred = part;
            return out;
          }
          out.push(...this.toolEvents(s, m, part, t));
          return out;
        }
```

5g. 在 `message.updated` 分支的 assistant 处理里，把

```ts
          m.parentID = info.parentID;
          this.flushUser(s, out, info.parentID);
```

替换为：

```ts
          m.parentID = info.parentID;
          this.flushUser(s, out, info.parentID);
          for (const t of m.toolParts.values()) {
            const part = t.deferred;
            if (!part) continue;
            t.deferred = undefined;
            out.push(...this.toolEvents(s, m, part, t));
          }
```

5h. patch 分支里，在 `if (seen.has(key)) continue;` 和 `seen.add(key);` 之后插入一行：

```ts
            if (m.editedPaths?.has(pathKey(f))) continue;
```

- [ ] **Step 6: 运行测试**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts`
Expected: 全部 pass。若有既有用例断言"工具 part 在 `message.updated` 之前到达时立即发出 `tool.call`"，只把该断言改为新的延迟顺序，不改实现。

- [ ] **Step 7: 全量回归 + 类型检查**

Run: `bun test` → `0 fail`；`bun run typecheck`，`echo $LASTEXITCODE` → `0`

- [ ] **Step 8: 提交**

```powershell
git add packages/schema/src/index.ts packages/adapter-opencode/src/index.ts packages/adapter-opencode/package.json packages/adapter-opencode/test/opencode.test.ts bun.lock
git commit -m "fix(adapter-opencode): put imported calls in the user's turn and take diffs from the call that made them"
```

---

### Task 6: projector 不再认识任何后端

**Files:**
- Modify: `packages/projector/src/index.ts`
- Modify: `packages/projector/package.json`
- Modify: `packages/projector/test/projector.test.ts`

**Interfaces:**
- Consumes: `file.changed.data.call_id`、`whole_file`（Task 5）
- Produces: `FileEditView.call_id?: string`；`turn_index` 由 `call_id` 找到所属 turn；同一文件的不同路径写法（Windows 盘符路径的大小写、分隔符）合并为一项，显示首次出现的写法；不再从工具输入重建 diff；不再按 seq 推断 `msg_id`。

- [ ] **Step 1: 删除过时的测试**

在 `packages/projector/test/projector.test.ts` 中删除以下 `test(...)` 整块（按标题查找）：

- `"a call recorded before its message existed still finds that message"`
- `"a call made before any message appeared belongs to the one that finished first"`
- `"a message the backend named wins over the sequence guess"`
- `"a change with no diff is rebuilt from the edit call that made it"`
- `"a whole-file write is labelled differently from an in-place edit"`
- `"the two path spellings of one file still match"`
- `"an edit call with no change event is still a change that happened"`
- `"a diff the backend already sent is used as-is, never rebuilt"`
- `"a file changed twice gets both diffs, in order"`

保留 `"plan and files_changed"` 和 `"a change no call explains keeps its place and says so"`。

- [ ] **Step 2: 写新测试**

在 `"a change no call explains keeps its place and says so"` 之后追加：

```ts
  const PATCH = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n";

  test("a change carries its own diff and points back to the turn of its call", () => {
    const v = projectSession([
      mk("s", "turn.user", { turn_id: "t1", content: [] }),
      mk("s", "tool.call", { turn_id: "t1", call_id: "c1", tool: "edit", input: {} }),
      mk("s", "file.changed", { path: "src/x.ts", change: "modify", call_id: "c1", diff: PATCH }),
    ]);
    const f = v.files_changed[0]!;
    expect(f.unexplained).toBe(false);
    expect([f.additions, f.deletions]).toEqual([1, 1]);
    expect(f.edits[0]).toMatchObject({ call_id: "c1", turn_index: 0, diff: PATCH });
  });

  test("a whole-file change says so", () => {
    const v = projectSession([
      mk("s", "file.changed", { path: "new.ts", change: "add", diff: PATCH, whole_file: true, call_id: "c9" }),
    ]);
    expect(v.files_changed[0]!.edits[0]).toMatchObject({ whole_file: true, turn_index: -1 });
  });

  test("two spellings of one Windows path are one file", () => {
    const v = projectSession([
      mk("s", "file.changed", { path: "D:\\Repo\\x.ts", change: "modify", diff: PATCH }),
      mk("s", "file.changed", { path: "d:/repo/x.ts", change: "modify" }),
    ]);
    expect(v.files_changed).toHaveLength(1);
    expect(v.files_changed[0]!.path).toBe("D:\\Repo\\x.ts");
    expect(v.files_changed[0]!.count).toBe(2);
    expect(v.files_changed[0]!.unexplained).toBe(true);
  });

  test("POSIX paths keep their case", () => {
    const v = projectSession([
      mk("s", "file.changed", { path: "/r/A.ts", change: "modify" }),
      mk("s", "file.changed", { path: "/r/a.ts", change: "modify" }),
    ]);
    expect(v.files_changed.map((f) => f.path)).toEqual(["/r/A.ts", "/r/a.ts"]);
  });

  test("a file changed in two turns lists both, in order", () => {
    const v = projectSession([
      mk("s", "tool.call", { turn_id: "t1", call_id: "c1", tool: "edit", input: {} }),
      mk("s", "file.changed", { path: "x.ts", change: "modify", call_id: "c1", diff: PATCH }),
      mk("s", "tool.call", { turn_id: "t2", call_id: "c2", tool: "edit", input: {} }),
      mk("s", "file.changed", { path: "x.ts", change: "modify", call_id: "c2", diff: PATCH }),
    ]);
    const f = v.files_changed[0]!;
    expect(f.count).toBe(2);
    expect([f.additions, f.deletions]).toEqual([2, 2]);
    expect(f.edits.map((e) => e.turn_index)).toEqual([0, 1]);
  });

  test("tool inputs are never read to invent a diff", () => {
    const v = projectSession([
      mk("s", "tool.call", {
        turn_id: "t1", call_id: "c1", tool: "edit",
        input: { filePath: "x.ts", oldString: "a", newString: "b" },
      }),
      mk("s", "file.changed", { path: "x.ts", change: "modify" }),
    ]);
    expect(v.files_changed[0]!.edits[0]!.diff).toBeUndefined();
    expect(v.files_changed[0]!.unexplained).toBe(true);
  });
```

- [ ] **Step 3: 运行，确认失败**

Run: `bun test packages/projector/test/projector.test.ts`
Expected: `"two spellings of one Windows path are one file"`、`"tool inputs are never read to invent a diff"` 等 FAIL。

- [ ] **Step 4: 修改 `packages/projector/src/index.ts`**

4a. 删除第二行 `import { createPatch } from "diff";`。

4b. 把 `interface ChangeRecord { ... }`、`type FileChangeKind`、`interface EditableCall { ... }`、`export interface FileEditView { ... }` 这一段替换为：

```ts
/** One change as the backend recorded it. */
interface ChangeRecord {
  change: FileChangeKind;
  diff?: string;
  call_id?: string;
  whole_file?: boolean;
}

type FileChangeKind = "add" | "modify" | "delete";

/** One recorded change to one file, with the text that changed if the backend sent it. */
export interface FileEditView {
  change: FileChangeKind;
  /** lines added and removed, counted out of the unified diff */
  additions: number;
  deletions: number;
  /** absent when the backend saw the file change but no call explains it — usually a shell command */
  diff?: string;
  /** the tool call that made the change */
  call_id?: string;
  /** index into SessionView.turns, or -1 when no call in this session made the change */
  turn_index: number;
  /** the diff covers the whole file rather than a region of it */
  whole_file?: boolean;
}
```

4c. 把 `function pathKey(...)` 整个替换为：

```ts
/** One shape for a path: separators unified, and a Windows drive path compared without case. */
function pathKey(path: string): string {
  const p = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p;
}
```

4d. 删除 `function editableText(...)` 及其上方注释、`function fillDiffs(...)` 及其上方注释（整段，直到 `export function projectSession` 之前）。

4e. 在 `projectSession` 里：
- 把 `const files = new Map<string, { change: FileChangeKind; records: ChangeRecord[] }>();` 改为 `const files = new Map<string, { path: string; change: FileChangeKind; records: ChangeRecord[] }>();`
- 删除 `messageSeq`、`callSeq` 两个声明及其上方的大段注释。
- 在 `case "turn.assistant":` 里删除 `if (e.data.msg_id) { let seen = messageSeq.get(...) ... }` 整块。
- 在 `case "tool.call":` 里删除 `if (e.data.msg_id === undefined) callSeq.set(e.data.call_id, e.seq);`。
- 把 `case "file.changed": { ... }` 替换为：

```ts
      case "file.changed": {
        const key = pathKey(e.data.path);
        const f = files.get(key) ?? { path: e.data.path, change: e.data.change, records: [] };
        f.change = e.data.change;
        f.records.push({
          change: e.data.change,
          diff: e.data.diff,
          call_id: e.data.call_id,
          whole_file: e.data.whole_file,
        });
        files.set(key, f);
        break;
      }
```

- 在排序循环 `for (const t of view.turns) {` 里，删除 `const seen = messageSeq.get(t.turn_id);` 以及紧随其后的 `if (seen && ...) { ... }` 整块，使循环体以 `if (!t.tool_calls.some((c) => c.order !== undefined)) continue;` 开头。
- 把 `view.files_changed = [...fillDiffs(files, view.turns).values()];` 替换为：

```ts
  const turnOfCall = new Map<string, number>();
  view.turns.forEach((t, i) => {
    for (const c of t.tool_calls) turnOfCall.set(c.call_id, i);
  });
  view.files_changed = [...files.values()].map((f) => {
    const edits = f.records.map((r): FileEditView => {
      const lines = r.diff ? countPatchLines(r.diff) : { additions: 0, deletions: 0 };
      return {
        change: r.change,
        additions: lines.additions,
        deletions: lines.deletions,
        diff: r.diff,
        call_id: r.call_id,
        turn_index: r.call_id === undefined ? -1 : (turnOfCall.get(r.call_id) ?? -1),
        whole_file: r.whole_file,
      };
    });
    return {
      path: f.path,
      change: f.change,
      count: edits.length,
      additions: edits.reduce((n, e) => n + e.additions, 0),
      deletions: edits.reduce((n, e) => n + e.deletions, 0),
      edits,
      unexplained: edits.some((e) => !e.diff),
    };
  });
```

4f. `packages/projector/package.json` 改为：

```json
{
  "name": "@agent-strata/projector",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "dependencies": { "zod": "3.23.8", "ulid": "2.3.0", "@agent-strata/schema": "workspace:*" }
}
```

Run: `bun install`

- [ ] **Step 5: 运行测试**

Run: `bun test packages/projector/test/projector.test.ts`
Expected: 全部 pass。

- [ ] **Step 6: 确认 projector 里不再有后端专有字段**

Run: `rg -n "filePath|oldString|newString|createPatch|messageSeq|callSeq" packages/projector/src`
Expected: 无输出。

- [ ] **Step 7: 全量回归 + 类型检查**

Run: `bun test` → `0 fail`；`bun run typecheck`，`echo $LASTEXITCODE` → `0`；`bun --cwd apps/desktop/ui run typecheck`，`echo $LASTEXITCODE` → `0`

- [ ] **Step 8: 提交**

```powershell
git add packages/projector/src/index.ts packages/projector/package.json packages/projector/test/projector.test.ts bun.lock
git commit -m "refactor(projector): read diffs from the change events and stop knowing any backend's tools"
```

---

### Task 7: 服务端缓存会话投影

**Files:**
- Create: `packages/service/src/views.ts`
- Modify: `packages/service/src/index.ts`
- Test: `packages/service/test/service.test.ts`

**Interfaces:**
- Consumes: `Store.lastSeq`（Task 1）、`LiveOverlay`（Task 3）
- Produces: `class ViewCache { events(sessionId: string): Event[]; view(sessionId: string): SessionView; drop(sessionId: string): void }`；`GET /sessions` 每个会话只投影一次，未变化的会话不重新读取。

- [ ] **Step 1: 写失败的测试**

在 `service.test.ts` 的 describe 内追加：

```ts
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
```

- [ ] **Step 2: 运行，确认这条用例的现状**

Run: `bun test packages/service/test/service.test.ts -t "views follow"`
Expected: PASS（无缓存时它本来就对）。这条用例是防回归用的：Step 4 之后它必须仍然通过，尤其是 rebuild 之后不能返回旧投影。

- [ ] **Step 3: 新建 `packages/service/src/views.ts`**

```ts
import { projectSession, type SessionView } from "@agent-strata/projector";
import type { Event } from "@agent-strata/schema";
import type { Store } from "@agent-strata/store";

// at least the sidebar's page of sessions, or every list request rereads them all
const CAPACITY = 256;

interface Entry {
  events: Event[];
  head: number;
  view?: SessionView;
}

/** Each session's stored events and projection, kept until the session moves. */
export class ViewCache {
  private entries = new Map<string, Entry>();

  constructor(private store: Store) {}

  events(sessionId: string): Event[] {
    const head = this.store.lastSeq(sessionId);
    let entry = this.entries.get(sessionId);
    if (entry) {
      this.entries.delete(sessionId);
      if (head > entry.head) {
        const more = this.store.read({ session_id: sessionId, after_seq: entry.head, limit: 20_000 });
        entry.events = entry.events.concat(more);
        entry.head = more.at(-1)?.seq ?? entry.head;
        entry.view = undefined;
      }
    } else {
      const events = this.store.read({ session_id: sessionId, limit: 20_000 });
      entry = { events, head: events.at(-1)?.seq ?? 0 };
    }
    this.entries.set(sessionId, entry);
    while (this.entries.size > CAPACITY) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.events;
  }

  view(sessionId: string): SessionView {
    const events = this.events(sessionId);
    const entry = this.entries.get(sessionId)!;
    entry.view ??= projectSession(events);
    return entry.view;
  }

  /** a rebuild deletes rows, which an incremental read cannot see */
  drop(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}
```

- [ ] **Step 4: 接线 `index.ts`**

4a. import 加 `import { ViewCache } from "./views";`

4b. 在 `const live = new LiveOverlay();` 之后加 `const views = new ViewCache(store);`

4c. `sink.replaceSession` 改为：

```ts
    replaceSession: (sessionId, events, replace) => {
      const n = store.replaceSession(sessionId, events, replace);
      views.drop(sessionId);
      broadcast({ type: "session.rebuilt", session_id: sessionId });
      return n;
    },
```

4d. `sessionView` 改为：

```ts
  const sessionView = (sessionId: string): SessionView => {
    if (!live.has(sessionId)) return views.view(sessionId);
    const stored = views.events(sessionId);
    return projectSession([...stored, ...live.events(sessionId, stored.at(-1)?.seq ?? 0)]);
  };
```

4e. `GET /sessions` 分支整体替换为：

```ts
      if (path === "/sessions" && req.method === "GET") {
        const summaries = store.listSessions({
          backend: url.searchParams.get("backend") ?? undefined,
          limit: Number(url.searchParams.get("limit") ?? 200),
        });
        const rows = summaries.map((summary) => ({ summary, view: sessionView(summary.session_id) }));
        const sessions = rows.map(({ summary, view: v }) => ({
          summary,
          status: v.status,
          busy: v.busy,
          totals: v.totals,
          title: v.title,
          workspace: v.workspace,
          parent: v.parent_session_id,
          archived: v.archived === true,
          deleted: v.deleted === true,
        }));
        return json({ sessions, aggregate: aggregate(rows.map((r) => r.view)) });
      }
```

4f. 回放分支里 `projectSession(store.read({ session_id: sid }).filter((e) => e.seq <= n))` 改为 `projectSession(views.events(sid).filter((e) => e.seq <= n))`。

- [ ] **Step 5: 运行测试**

Run: `bun test packages/service/test/service.test.ts`
Expected: 全部 pass。

- [ ] **Step 6: 用本地真实库对比耗时（先复制一份，不碰原库）**

```powershell
$tmp = Join-Path $env:TEMP "strata-bench"
New-Item -ItemType Directory -Force $tmp | Out-Null
Copy-Item "$HOME\.agent-strata\events.db" "$tmp\events.db" -Force
$env:STRATA_DB = "$tmp\events.db"; $env:STRATA_PORT = "7799"; $env:STRATA_POLICY = "$tmp\policy.json"
$svc = Start-Process bun -ArgumentList "run","packages/service/src/index.ts" -PassThru -NoNewWindow
Start-Sleep 3
1..3 | ForEach-Object { [int](Measure-Command { Invoke-WebRequest http://127.0.0.1:7799/sessions -UseBasicParsing | Out-Null }).TotalMilliseconds }
Stop-Process $svc.Id
Remove-Item Env:STRATA_DB, Env:STRATA_PORT, Env:STRATA_POLICY
```

Expected: 第 1 次为几百毫秒，第 2、3 次明显更快（几十毫秒级）。把三个数字记进提交说明正文。

- [ ] **Step 7: 全量回归 + 类型检查，提交**

Run: `bun test` → `0 fail`；`bun run typecheck`，`echo $LASTEXITCODE` → `0`

```powershell
git add packages/service/src/views.ts packages/service/src/index.ts packages/service/test/service.test.ts
git commit -m "perf(service): project each session once and keep it until the session moves"
```

---

### Task 8: 前端就地合并流式快照

**Files:**
- Create: `apps/desktop/ui/src/live.ts`
- Create: `apps/desktop/ui/src/live.test.ts`
- Modify: `apps/desktop/ui/src/session-detail.tsx`
- Modify: `apps/desktop/ui/src/App.tsx`

**Interfaces:**
- Consumes: SSE 广播的流式快照（Task 3），格式为 `{ session_id, type: "turn.assistant", data: { turn_id, msg_id, partial: true, content } }`，没有 `seq`
- Produces: `applyStreamingSnapshot(view: SessionView, snap: StreamingSnapshot): SessionView`；`isStreamingSnapshotMessage(raw: string): boolean`

- [ ] **Step 1: 写失败的测试**

Create `apps/desktop/ui/src/live.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { applyStreamingSnapshot, isStreamingSnapshotMessage } from "./live";
import type { SessionView } from "./api";

const base = (): SessionView => ({
  session_id: "s",
  backend: "opencode",
  status: "active",
  turns: [
    {
      turn_id: "u1",
      user: [{ type: "text", text: "hi" }],
      assistant: [{ content: [{ type: "text", text: "done" }], msg_id: "a1" }],
      tool_calls: [],
    },
  ],
  pending_permissions: [],
  files_changed: [],
  totals: {
    input: 0, output: 0, cost_usd: 0, tool_calls: 0, cache_read: 0, cache_write: 0,
    reasoning: 0, tool_errors: 0, permissions_denied: 0,
  },
});

describe("streaming snapshots in the reader's view", () => {
  test("a new message joins its turn as still being written", () => {
    const v = applyStreamingSnapshot(base(), { turn_id: "u1", msg_id: "a2", content: [{ type: "text", text: "wri" }] });
    expect(v.turns[0]!.assistant).toHaveLength(2);
    expect(v.turns[0]!.assistant[1]).toMatchObject({ msg_id: "a2", partial: true });
  });

  test("a later snapshot replaces the earlier one", () => {
    const once = applyStreamingSnapshot(base(), { turn_id: "u1", msg_id: "a2", content: [{ type: "text", text: "wri" }] });
    const twice = applyStreamingSnapshot(once, { turn_id: "u1", msg_id: "a2", content: [{ type: "text", text: "writing" }] });
    expect(twice.turns[0]!.assistant).toHaveLength(2);
    expect(twice.turns[0]!.assistant[1]!.content).toEqual([{ type: "text", text: "writing" }]);
  });

  test("a finished message is left alone", () => {
    const v = base();
    expect(applyStreamingSnapshot(v, { turn_id: "u1", msg_id: "a1", content: [] })).toBe(v);
  });

  test("an unseen turn is added", () => {
    const v = applyStreamingSnapshot(base(), { turn_id: "u2", msg_id: "b1", content: [{ type: "text", text: "x" }] });
    expect(v.turns.map((t) => t.turn_id)).toEqual(["u1", "u2"]);
  });

  test("only streaming snapshot messages are recognised", () => {
    expect(isStreamingSnapshotMessage(JSON.stringify({ type: "turn.assistant", data: { partial: true } }))).toBe(true);
    expect(isStreamingSnapshotMessage(JSON.stringify({ type: "turn.assistant", data: {} }))).toBe(false);
    expect(isStreamingSnapshotMessage("not json")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test apps/desktop/ui/src/live.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 新建 `apps/desktop/ui/src/live.ts`**

```ts
import type { ContentBlock, SessionView } from "./api";

export interface StreamingSnapshot {
  turn_id: string;
  msg_id?: string;
  content: ContentBlock[];
}

/** Lay a message still being written over the view the reader holds; a finished one is left alone. */
export function applyStreamingSnapshot(view: SessionView, snap: StreamingSnapshot): SessionView {
  if (!snap.msg_id) return view;
  const entry = { content: snap.content, msg_id: snap.msg_id, partial: true };
  const ti = view.turns.findIndex((t) => t.turn_id === snap.turn_id);
  if (ti < 0) {
    return { ...view, turns: [...view.turns, { turn_id: snap.turn_id, assistant: [entry], tool_calls: [] }] };
  }
  const turn = view.turns[ti]!;
  const ai = turn.assistant.findIndex((a) => a.msg_id === snap.msg_id);
  if (ai >= 0 && turn.assistant[ai]!.partial !== true) return view;
  const assistant =
    ai >= 0 ? turn.assistant.map((a, i) => (i === ai ? { ...a, ...entry } : a)) : [...turn.assistant, entry];
  const turns = view.turns.slice();
  turns[ti] = { ...turn, assistant };
  return { ...view, turns };
}

export function isStreamingSnapshotMessage(raw: string): boolean {
  try {
    const e = JSON.parse(raw) as { type?: unknown; data?: { partial?: unknown } };
    return e.type === "turn.assistant" && e.data?.partial === true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `bun test apps/desktop/ui/src/live.test.ts`
Expected: 5 pass。

- [ ] **Step 5: 会话页接入**

5a. `session-detail.tsx` 的 import 区，在 `import { Virtual, type VirtualApi } from "./virtual";` 之后加：

```ts
import { applyStreamingSnapshot, type StreamingSnapshot } from "./live";
```

5b. `const [view, { refetch }] = createResource(` 改为 `const [view, { refetch, mutate }] = createResource(`。

5c. 在 `es.onmessage` 里，把

```ts
        const evt = JSON.parse(m.data) as {
          session_id?: string;
          type: string;
          data?: { state?: string };
        };
```

替换为：

```ts
        const evt = JSON.parse(m.data) as {
          session_id?: string;
          type: string;
          data?: { state?: string; partial?: boolean };
        };
        if (evt.session_id === props.id && evt.type === "turn.assistant" && evt.data?.partial === true) {
          if (replayPos() === null) {
            const snap = evt.data as unknown as StreamingSnapshot;
            mutate((v) => (v ? applyStreamingSnapshot(v, snap) : v));
          }
          return;
        }
```

- [ ] **Step 6: 侧栏忽略流式快照**

`App.tsx`：在 `import { CommandSearch } from "./search";` 之后加 `import { isStreamingSnapshotMessage } from "./live";`；把

```ts
    es.onmessage = () => {
      clearTimeout(timer);
```

替换为：

```ts
    es.onmessage = (m) => {
      if (isStreamingSnapshotMessage(m.data)) return;
      clearTimeout(timer);
```

- [ ] **Step 7: 检查**

Run: `bun --cwd apps/desktop/ui run typecheck`，`echo $LASTEXITCODE` → `0`
Run: `bun test` → `0 fail`

- [ ] **Step 8: 提交**

```powershell
git add apps/desktop/ui/src/live.ts apps/desktop/ui/src/live.test.ts apps/desktop/ui/src/session-detail.tsx apps/desktop/ui/src/App.tsx
git commit -m "perf(desktop-ui): stream a message into the open view instead of refetching the session"
```

---

### Task 9: ACP 作为第二个后端接入 service

**Files:**
- Modify: `packages/adapter-acp/src/index.ts`
- Modify: `packages/adapter-acp/test/acp.test.ts`
- Create: `packages/service/src/connections.ts`
- Create: `packages/service/src/acp-driver.ts`
- Modify: `packages/service/src/index.ts`
- Modify: `packages/service/package.json`
- Test: `packages/service/test/service.test.ts`

**Interfaces:**
- Consumes: `BackendSink`、`BackendDriver`（Task 3/4）、`file.changed.call_id/whole_file`（Task 5）
- Produces:
  - adapter-acp：`policy?: Policy | (() => Policy | undefined)`；ACP diff 产出的 `file.changed` 带 `call_id`，新文件带 `whole_file: true`
  - `ConnectBody`、`endpointOf(body): string`、`connectionMemory(db)`（connections.ts）
  - `connectAcpDriver(opts): Promise<BackendDriver>`，`backend: "acp"`，`baseUrl: "acp://<command> <args...>"`，`capabilities: { prompt: true, abort: true, models: false, agents: false, import: false, manage: false }`
  - `POST /connect` 接受 `{ backend: "acp", command, args?, cwd?, agentName?, name? }`
  - 连接持久化改为 `connections.json` 数组（兼容读取旧的 `connection.json`）

- [ ] **Step 1: adapter-acp 小改**

1a. `AcpRecorder` 构造参数和 `connectAcpAgent` 参数里的 `policy?: Policy;` 都改为：

```ts
      policy?: Policy | (() => Policy | undefined);
```

（`connectAcpAgent` 的 opts 那处缩进按原文。）

1b. `requestPermission` 里把

```ts
    const d = this.opts.policy
      ? evaluate(this.opts.policy, { tool: call.tool, input: call.input })
      : { decision: "ask" as const };
```

替换为：

```ts
    const policy = typeof this.opts.policy === "function" ? this.opts.policy() : this.opts.policy;
    const d = policy
      ? evaluate(policy, { tool: call.tool, input: call.input })
      : { decision: "ask" as const };
```

1c. `emitDiffs` 里的 data 改为：

```ts
          {
            path: c.path,
            change: c.oldText == null ? "add" : "modify",
            diff: createPatch(c.path, c.oldText ?? "", c.newText),
            call_id: u.toolCallId,
            ...(c.oldText == null ? { whole_file: true } : {}),
          },
```

1d. 在 `acp.test.ts` 的 `"diff scenario: file.changed add + modify"` 用例里 `expect(old.edits[0]!.diff).toContain("const b = 2");` 之后加：

```ts
    expect(old.edits[0]!.turn_index).toBe(0);
    expect(view.files_changed.find((f) => f.path === "new.ts")!.edits[0]!.whole_file).toBe(true);
```

Run: `bun test packages/adapter-acp`
Expected: 全部 pass。

- [ ] **Step 2: 写 service 的失败测试**

`service.test.ts` 顶部加：

```ts
import { fileURLToPath } from "node:url";
```

describe 内追加：

```ts
  test("an ACP agent connects as a backend and runs a prompt", async () => {
    const MOCK = fileURLToPath(new URL("../../adapter-acp/test/fixtures/mock-agent.ts", import.meta.url));
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const connected = await post("/connect", {
      backend: "acp", command: process.execPath, args: [MOCK], agentName: "mock", cwd: "/tmp",
    }).then((r) => r.json());
    expect(connected.id).toStartWith("acp:mock:");
    const conns = await fetch(`${base}/connections`).then((r) => r.json());
    expect(conns.connections[0]).toMatchObject({ backend: "acp", capabilities: { prompt: true, models: false } });

    const created = await post("/sessions", { connection_id: connected.id, directory: "/tmp" }).then((r) => r.json());
    expect(created.id).toStartWith("acp:mock:");
    expect((await post(`/sessions/${encodeURIComponent(created.id)}/prompt`, { text: "diff" })).status).toBe(200);

    const view = () => fetch(`${base}/sessions/${encodeURIComponent(created.id)}/view`).then((r) => r.json());
    let v = await view();
    for (let i = 0; i < 60 && (v.busy || v.files_changed.length === 0); i++) {
      await Bun.sleep(50);
      v = await view();
    }
    expect(v.backend).toBe("acp");
    expect(v.busy).toBe(false);
    expect(v.files_changed.map((f: { path: string }) => f.path).sort()).toEqual(["new.ts", "old.ts"]);
    expect(v.files_changed.every((f: { unexplained: boolean }) => !f.unexplained)).toBe(true);

    await fetch(`${base}/connections/${encodeURIComponent(connected.id)}`, { method: "DELETE" });
    svc.stop();
  });
```

Run: `bun test packages/service/test/service.test.ts -t "ACP agent"`
Expected: FAIL（`/connect` 要求 `baseUrl`）。

- [ ] **Step 3: service 依赖 adapter-acp**

`packages/service/package.json` 的 dependencies 加一行 `"@agent-strata/adapter-acp": "workspace:*",`，然后 Run: `bun install`。

- [ ] **Step 4: 新建 `packages/service/src/connections.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ConnectBody {
  backend?: string;
  /** opencode: the `opencode serve` URL */
  baseUrl?: string;
  /** acp: the agent's executable and arguments, spoken to over stdio */
  command?: string;
  args?: string[];
  cwd?: string;
  agentName?: string;
  name?: string;
  directory?: string;
  username?: string;
  password?: string;
  policy?: unknown;
  connectTimeoutMs?: number;
}

/** What identifies a connection: the server URL, or the command an ACP agent runs as. */
export function endpointOf(body: ConnectBody): string {
  if ((body.backend ?? "opencode") === "acp") {
    return `acp://${[body.command ?? "", ...(body.args ?? [])].join(" ")}`;
  }
  return body.baseUrl ?? "";
}

export function agentNameOf(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).replace(/\.(exe|cmd|bat)$/i, "");
}

/** Connections remembered across restarts, one per endpoint, next to the event store. */
export function connectionMemory(db: string | undefined) {
  const dir = !db || db === ":memory:" ? undefined : dirname(db);
  const file = dir ? join(dir, "connections.json") : undefined;
  const saved = (): ConnectBody[] => {
    if (!dir || !file) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(parsed)) return parsed as ConnectBody[];
    } catch {
      // not written yet
    }
    try {
      const single = JSON.parse(readFileSync(join(dir, "connection.json"), "utf8")) as ConnectBody;
      if (single.baseUrl) return [single];
    } catch {
      // no single connection from before the list either
    }
    return [];
  };
  const write = (list: ConnectBody[]) => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(list, null, 2) + "\n");
    } catch (e) {
      console.error(`could not save connections: ${e}`);
    }
  };
  return {
    saved,
    remember(body: ConnectBody) {
      const key = endpointOf(body);
      const { policy: _policy, connectTimeoutMs: _timeout, ...kept } = body;
      write([...saved().filter((c) => endpointOf(c) !== key), kept]);
    },
    forget(endpoint: string) {
      write(saved().filter((c) => endpointOf(c) !== endpoint));
    },
  };
}
```

- [ ] **Step 5: 新建 `packages/service/src/acp-driver.ts`**

```ts
import { connectAcpAgent, type OnAsk } from "@agent-strata/adapter-acp";
import type { Policy } from "@agent-strata/policy";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import type { BackendDriver, BackendSink } from "./driver";

export async function connectAcpDriver(opts: {
  sink: BackendSink;
  command: string;
  args?: string[];
  cwd?: string;
  agentName: string;
  name?: string;
  policy?: () => Policy | undefined;
  onAsk?: OnAsk;
}): Promise<BackendDriver> {
  const agent = await connectAcpAgent({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    agentName: opts.agentName,
    sink: opts.sink,
    policy: opts.policy,
    onAsk: opts.onAsk,
  });
  const prefix = `acp:${opts.agentName}:`;
  const endpoint = `acp://${[opts.command, ...(opts.args ?? [])].join(" ")}`;
  const status = (casfId: string, state: "busy" | "idle") =>
    opts.sink.append([
      makeEvent({
        session_id: casfId,
        source: { backend: "acp", agent: opts.agentName },
        type: "session.status",
        data: { state },
      } as EventInput),
    ]);
  const unsupported = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} is not supported over ACP`);
  };
  return {
    id: `${prefix}${endpoint}`,
    backend: "acp",
    baseUrl: endpoint,
    name: opts.name ?? opts.agentName,
    directory: opts.cwd,
    capabilities: { prompt: true, abort: true, models: false, agents: false, import: false, manage: false },
    stop: () => {
      void agent.close();
    },
    async createSession(sess) {
      const casfId = await agent.newSession(sess?.directory ?? opts.cwd ?? process.cwd());
      return { casfId, nativeId: casfId.slice(prefix.length) };
    },
    async prompt(nativeId, text) {
      const casfId = prefix + nativeId;
      if (!agent.recorder.sessionByCasf(casfId)) {
        throw new Error("this ACP session belongs to an earlier run of the agent and cannot be continued");
      }
      status(casfId, "busy");
      // ACP's prompt resolves when the turn ends; the HTTP call must not wait for that
      void agent
        .prompt(casfId, text)
        .catch((e) => console.error(`acp prompt ${casfId} failed: ${e}`))
        .finally(() => status(casfId, "idle"));
    },
    abort: (nativeId) => agent.cancel(prefix + nativeId),
    listModels: async () => [],
    listAgents: async () => [],
    listWorkspaces: async () => (opts.cwd ? [{ directory: opts.cwd }] : []),
    indexSessions: async () => [],
    sync: async () => 0,
    rebuild: unsupported("rebuild"),
    importSession: unsupported("import"),
    rename: unsupported("rename"),
    archive: unsupported("archive"),
    deleteSession: unsupported("delete"),
    nativeId: (casfId) => (casfId.startsWith(prefix) ? casfId.slice(prefix.length) : undefined),
  };
}
```

- [ ] **Step 6: 改造 `packages/service/src/index.ts` 的连接部分**

6a. import 加：

```ts
import type { EventInput } from "@agent-strata/schema";
import { connectAcpDriver } from "./acp-driver";
import { agentNameOf, connectionMemory, endpointOf, type ConnectBody } from "./connections";
```

6b. 在 `staleFor`/`syncDriver` 之后加共享的提问处理（内容取自原 `connectOnce` 里内联的 `onAsk`/`onQuestion`）：

```ts
  const onAsk = (req: Extract<EventInput, { type: "permission.requested" }>) => {
    store.append([req]);
    const data = req.data;
    return new Promise<{ decision: "allow" | "deny"; scope?: "once" | "always" }>((resolve) =>
      pendingAsks.set(data.request_id, {
        request_id: data.request_id,
        session_id: req.session_id,
        tool: data.tool,
        input: data.input,
        asked_at: req.ts,
        resolve,
      }),
    );
  };
  const onQuestion = (req: Extract<EventInput, { type: "question.asked" }>) => {
    store.append([req]);
    const data = req.data;
    return new Promise<{ decision: "reply" | "reject"; answers?: string[][] }>((resolve) =>
      pendingQuestions.set(data.request_id, {
        request_id: data.request_id,
        session_id: req.session_id,
        questions: data.questions,
        asked_at: req.ts,
        resolve,
      }),
    );
  };
  const memory = connectionMemory(opts.db);
```

6c. 把 `inflightConnects`、`connectBackend`、`connectOnce` 三者整体替换为：

```ts
  const inflightConnects = new Map<string, Promise<{ id: string; indexed: number }>>();
  const connectBackend = (body: ConnectBody): Promise<{ id: string; indexed: number }> => {
    const key = endpointOf(body);
    const pending = inflightConnects.get(key);
    if (pending) return pending;
    const job = connectOnce(body).finally(() => inflightConnects.delete(key));
    inflightConnects.set(key, job);
    return job;
  };
  const connectOnce = async (body: ConnectBody): Promise<{ id: string; indexed: number }> => {
    const backend = body.backend ?? "opencode";
    const endpoint = endpointOf(body);
    const already = [...conns.values()].find((c) => c.baseUrl === endpoint);
    if (already) {
      void syncDriver(already).catch((e) => console.error(`sync ${already.id} failed: ${e}`));
      return { id: already.id, indexed: 0 };
    }
    const explicit: Policy | undefined = body.policy ? loadPolicy(body.policy) : undefined;
    // per-connect policy wins; otherwise follow the live shared policy
    const policy = explicit ? () => explicit : () => currentPolicy;
    let driver: BackendDriver;
    if (backend === "opencode") {
      if (!body.baseUrl) throw new Error("baseUrl required");
      driver = await connectOpencodeDriver({
        sink,
        baseUrl: body.baseUrl,
        name: body.name,
        directory: body.directory,
        username: body.username,
        password: body.password,
        policy,
        connectTimeoutMs: body.connectTimeoutMs,
        onAsk,
        onQuestion,
      });
    } else if (backend === "acp") {
      if (!body.command) throw new Error("command required");
      driver = await connectAcpDriver({
        sink,
        command: body.command,
        args: body.args,
        cwd: body.cwd ?? body.directory,
        agentName: body.agentName ?? agentNameOf(body.command),
        name: body.name,
        policy,
        onAsk,
      });
    } else {
      throw new Error(`backend ${backend} is not registered`);
    }
    conns.set(driver.id, driver);
    let indexed: string[] = [];
    try {
      indexed = await driver.indexSessions();
      for (const casfId of indexed) owners.set(casfId, driver.id);
    } catch (e) {
      console.error(`index sessions on ${driver.id} failed: ${e}`);
    }
    void syncDriver(driver).catch((e) => console.error(`sync ${driver.id} failed: ${e}`));
    return { id: driver.id, indexed: indexed.length };
  };
```

6d. 删除 `connectionFile`、`rememberConnection`、`forgetConnection`、`savedConnection` 四个函数，以及原来的启动自动连接块（`const bootConnection = ...` 到对应 `if (...) { ... }` 结束），替换为：

```ts
  // boot auto-connect. An explicit URL comes first; every remembered
  // connection follows, so reopening the app is not stuck on old snapshots.
  const boot: ConnectBody[] = opts.autoConnect
    ? [
        {
          baseUrl: opts.autoConnect,
          username: opts.autoConnectUsername,
          password: opts.autoConnectPassword,
        },
        ...memory.saved().filter((c) => endpointOf(c) !== opts.autoConnect),
      ]
    : memory.saved();
  for (const body of boot) {
    const endpoint = endpointOf(body);
    const deadline = Date.now() + (opts.autoConnectTimeoutMs ?? 15_000);
    void (async () => {
      for (;;) {
        try {
          const { id } = await connectBackend(body);
          memory.remember(body);
          console.log(`auto-connected backend ${id}`);
          return;
        } catch (e) {
          if (Date.now() > deadline) {
            console.error(`auto-connect to ${endpoint} gave up: ${e}`);
            return;
          }
          await Bun.sleep(750);
        }
      }
    })();
  }
```

6e. `/connect` 路由整体替换为：

```ts
      if (path === "/connect" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as ConnectBody | null;
        if (!body?.baseUrl && !body?.command) return json({ error: "baseUrl or command required" }, 400);
        try {
          const connected = await connectBackend(body);
          memory.remember(body);
          return json(connected);
        } catch (e) {
          return json({ error: String(e) }, 502);
        }
      }
```

6f. `/sync` 路由里把

```ts
        if (conns.size === 0) {
          const saved = savedConnection();
          if (saved?.baseUrl) {
            try {
              await connectBackend({ ...saved, connectTimeoutMs: 2_000 });
            } catch (e) {
              console.error(`reconnect ${saved.baseUrl} failed: ${e}`);
            }
          }
        }
```

替换为：

```ts
        if (conns.size === 0) {
          for (const saved of memory.saved()) {
            try {
              await connectBackend({ ...saved, connectTimeoutMs: 2_000 });
            } catch (e) {
              console.error(`reconnect ${endpointOf(saved)} failed: ${e}`);
            }
          }
        }
```

6g. 断开连接路由里 `if (conns.size === 0) forgetConnection();` 改为 `memory.forget(conn.baseUrl);`。

- [ ] **Step 7: 运行测试**

Run: `bun test packages/service`
Expected: 全部 pass（包括新的 ACP 用例和原有的 "autoConnect to a dead backend" 用例）。

- [ ] **Step 8: 全量回归 + 类型检查，提交**

Run: `bun test` → `0 fail`；`bun run typecheck`，`echo $LASTEXITCODE` → `0`

```powershell
git add packages/adapter-acp/src/index.ts packages/adapter-acp/test/acp.test.ts packages/service/src/connections.ts packages/service/src/acp-driver.ts packages/service/src/index.ts packages/service/package.json packages/service/test/service.test.ts bun.lock
git commit -m "feat(service,adapter-acp): connect an ACP agent as a second backend"
```

---

### Task 10: UI 最小支持 ACP

**Files:**
- Modify: `apps/desktop/ui/src/api.ts`（`connectBackend` 参数）
- Modify: `apps/desktop/ui/src/App.tsx`
- Modify: `apps/desktop/ui/src/transcript-format.ts`
- Modify: `apps/desktop/ui/src/transcript-format.test.ts`
- Modify: `apps/desktop/ui/src/locales/zh/shell.ts`、`apps/desktop/ui/src/locales/en/shell.ts`

**Interfaces:**
- Consumes: `POST /connect` 的 ACP 形态（Task 9）
- Produces: 连接面板可在"OpenCode 服务 / ACP 代理"间切换；新建会话发往用户选定的连接；ACP 工具类别（`execute`、`search`、`delete`、`move`）有正确的图标与标题

- [ ] **Step 1: 工具类别的失败测试**

在 `transcript-format.test.ts` 末尾追加（如果文件顶部没有 import `toolKind`，把它加进已有的 `./transcript-format` import）：

```ts
describe("ACP tool kinds", () => {
  test("ACP's kinds read like their OpenCode counterparts", () => {
    expect(toolKind("execute")).toBe("shell");
    expect(toolKind("search")).toBe("search");
    expect(toolKind("delete")).toBe("edit");
    expect(toolKind("move")).toBe("edit");
  });
});
```

Run: `bun test apps/desktop/ui/src/transcript-format.test.ts`
Expected: FAIL。

- [ ] **Step 2: 补齐类别映射**

`transcript-format.ts` 的 `KINDS` 里，在 `exec: "shell",` 后加 `execute: "shell",`；在 `strreplace: "edit",` 后加 `delete: "edit",` 和 `move: "edit",`；在 `glob: "search",` 后加 `search: "search",`。

Run: `bun test apps/desktop/ui/src/transcript-format.test.ts` → pass。

- [ ] **Step 3: 文案**

`locales/zh/shell.ts` 中 `"connect.form.password": "密码",` 之后加：

```ts
  "connect.kind.opencode": "OpenCode 服务",
  "connect.kind.acp": "ACP 代理",
  "connect.form.command": "启动命令，如 opencode acp",
  "sidebar.backend.newTarget": "新会话",
```

`locales/en/shell.ts` 中 `"connect.form.password": "password",` 之后加：

```ts
  "connect.kind.opencode": "OpenCode server",
  "connect.kind.acp": "ACP agent",
  "connect.form.command": "command, e.g. opencode acp",
  "sidebar.backend.newTarget": "new sessions",
```

- [ ] **Step 4: `api.ts` 的 `connectBackend` 参数**

把 `connectBackend` 的参数类型替换为：

```ts
export async function connectBackend(body: {
  backend?: "opencode" | "acp";
  baseUrl?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  name?: string;
  directory?: string;
  username?: string;
  password?: string;
}): Promise<string> {
```

函数体不变。

- [ ] **Step 5: `App.tsx`**

5a. 在 `const WS_KEY = "strata.workspace";` 之后加：

```ts
const NEW_CONN_KEY = "strata.newSessionConnection";
```

5b. 把 `endpointHost` 改为：

```ts
function endpointHost(url: string): string {
  if (url.startsWith("acp://")) return url.slice("acp://".length);
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
```

5c. 在 `const [connName, setConnName] = createSignal("");` 之后加：

```ts
  const [connKind, setConnKind] = createSignal<"opencode" | "acp">("opencode");
  const [connCmd, setConnCmd] = createSignal("opencode acp");
  const [newConn, setNewConn] = createSignal<string | null>(localStorage.getItem(NEW_CONN_KEY));
  const chooseNewConn = (id: string) => {
    setNewConn(id);
    localStorage.setItem(NEW_CONN_KEY, id);
  };
  const newSessionConnection = () => {
    const list = settled(conns)?.connections ?? [];
    return list.find((c) => c.id === newConn())?.id ?? list[0]?.id;
  };
```

5d. `connect` 函数里把

```ts
      await connectBackend({
        baseUrl: connUrl().trim(),
        name: connName().trim() || undefined,
        username: connUser() || undefined,
        password: connPass() || undefined,
      });
```

替换为：

```ts
      const words = connCmd().trim().split(/\s+/).filter(Boolean);
      const id = await connectBackend(
        connKind() === "acp"
          ? {
              backend: "acp",
              command: words[0]!,
              args: words.slice(1),
              cwd: currentDir(),
              name: connName().trim() || undefined,
            }
          : {
              baseUrl: connUrl().trim(),
              name: connName().trim() || undefined,
              username: connUser() || undefined,
              password: connPass() || undefined,
            },
      );
      chooseNewConn(id);
```

5e. `newSession` 里 `body: JSON.stringify({ directory: currentDir() }),` 改为：

```ts
      body: JSON.stringify({ directory: currentDir(), connection_id: newSessionConnection() }),
```

5f. 连接表单：把 `<Show when={connOpen()}>` 里面 `<div class="mb-1.5 space-y-1.5 px-1">` 的内容替换为（`Button` 段落保持原有 `onClick`，只改 `disabled`）：

```tsx
            <div class="mb-1.5 space-y-1.5 px-1">
              <div class="flex gap-1">
                <Button
                  size="sm"
                  variant={connKind() === "opencode" ? "secondary" : "ghost"}
                  class="h-7 flex-1 text-2xs"
                  onClick={() => setConnKind("opencode")}
                >
                  {t("connect.kind.opencode")}
                </Button>
                <Button
                  size="sm"
                  variant={connKind() === "acp" ? "secondary" : "ghost"}
                  class="h-7 flex-1 text-2xs"
                  onClick={() => setConnKind("acp")}
                >
                  {t("connect.kind.acp")}
                </Button>
              </div>
              <Show
                when={connKind() === "acp"}
                fallback={
                  <>
                    <TextField value={connUrl()} onChange={setConnUrl} class="gap-0">
                      <TextFieldInput
                        class="h-8 bg-background font-mono text-2xs"
                        placeholder="http://127.0.0.1:4096"
                      />
                    </TextField>
                    <div class="flex gap-1.5">
                      <TextField value={connName()} onChange={setConnName} class="w-1/3 gap-0">
                        <TextFieldInput class="h-8 bg-background px-2 text-2xs" placeholder={t("connect.form.name")} />
                      </TextField>
                      <TextField value={connUser()} onChange={setConnUser} class="w-1/3 gap-0">
                        <TextFieldInput
                          class="h-8 bg-background px-2 text-2xs"
                          placeholder={t("connect.form.user")}
                        />
                      </TextField>
                      <TextField value={connPass()} onChange={setConnPass} class="w-1/3 gap-0">
                        <TextFieldInput
                          type="password"
                          class="h-8 bg-background px-2 text-2xs"
                          placeholder={t("connect.form.password")}
                        />
                      </TextField>
                    </div>
                  </>
                }
              >
                <TextField value={connCmd()} onChange={setConnCmd} class="gap-0">
                  <TextFieldInput
                    class="h-8 bg-background font-mono text-2xs"
                    placeholder={t("connect.form.command")}
                  />
                </TextField>
                <TextField value={connName()} onChange={setConnName} class="gap-0">
                  <TextFieldInput class="h-8 bg-background px-2 text-2xs" placeholder={t("connect.form.name")} />
                </TextField>
              </Show>
              <Button
                class="h-8 w-full"
                disabled={connecting() || !(connKind() === "acp" ? connCmd().trim() : connUrl().trim())}
                onClick={() => void connect()}
              >
                {connecting() ? t("action.connecting") : t("action.connect")}
              </Button>
            </div>
```

5g. 连接列表：把 `<For each={settled(conns)?.connections ?? []}>` 下的 `<p class="flex items-center gap-2 truncate px-1.5 py-1 text-xs" title={c.baseUrl}> ... </p>` 替换为：

```tsx
                  {(c) => (
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 truncate rounded-md px-1.5 py-1 text-left text-xs hover:bg-secondary"
                      title={c.baseUrl}
                      onClick={() => chooseNewConn(c.id)}
                    >
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-status-active" />
                      <span class="truncate">
                        {backendLabel(c.backend)}
                        <span class="font-mono text-2xs text-muted-foreground">
                          {" "}
                          · {endpointHost(c.baseUrl)}
                        </span>
                      </span>
                      <Show when={(settled(conns)?.connections.length ?? 0) > 1 && newSessionConnection() === c.id}>
                        <span class="ml-auto shrink-0 text-2xs text-muted-foreground">
                          {t("sidebar.backend.newTarget")}
                        </span>
                      </Show>
                    </button>
                  )}
```

- [ ] **Step 6: 检查**

Run: `bun --cwd apps/desktop/ui run typecheck`，`echo $LASTEXITCODE` → `0`
Run: `bun test` → `0 fail`

- [ ] **Step 7: 提交**

```powershell
git add apps/desktop/ui/src/api.ts apps/desktop/ui/src/App.tsx apps/desktop/ui/src/transcript-format.ts apps/desktop/ui/src/transcript-format.test.ts apps/desktop/ui/src/locales/zh/shell.ts apps/desktop/ui/src/locales/en/shell.ts
git commit -m "feat(desktop-ui): connect an ACP agent and choose where new sessions go"
```

---

### Task 11: 清库重建、端到端验证与 README

**Files:**
- Create: `scripts/check-store.ts`
- Modify: `README.md`

- [ ] **Step 1: 新建不变式检查脚本 `scripts/check-store.ts`**

```ts
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
```

- [ ] **Step 2: 停掉占用事件库的进程**

关闭桌面应用（如果开着）。然后：

Run: `Get-NetTCPConnection -LocalPort 7700 -State Listen -ErrorAction SilentlyContinue`
Expected: 无输出。若有输出，用 `Stop-Process -Id <OwningProcess>` 停掉对应进程。

- [ ] **Step 3: 清空本地事件库（用户已授权）**

```powershell
Remove-Item "$HOME\.agent-strata\events.db*" -Force -ErrorAction SilentlyContinue
Get-ChildItem "$HOME\.agent-strata"
```

Expected: `events.db`、`events.db-wal`、`events.db-shm` 都不在了；`policy.json` 和连接文件保留。

- [ ] **Step 4: 启动 service 并同步 OpenCode**

```powershell
$env:STRATA_OPENCODE_URL = "http://127.0.0.1:4096"
$svc = Start-Process bun -ArgumentList "run","packages/service/src/index.ts" -PassThru -NoNewWindow
Start-Sleep 5
```

反复执行下面这条命令，直到连续两次返回 `"imported":0`：

```powershell
(Invoke-WebRequest -Method Post http://127.0.0.1:7700/sync -UseBasicParsing).Content
```

- [ ] **Step 5: 检查不变式**

Run: `bun run scripts/check-store.ts`
Expected:
- `streaming_snapshots_stored` = 0
- `stale_opencode_sessions` = 0
- `tool_calls_outside_a_user_turn` 小于 `tool_calls` 的 1%（清库前是 3268/3283）
- `file_changes_with_call` > 0，且 `file_changes_with_diff` ≥ `file_changes_with_call`

任何一项不满足：停下来报告实际数值，不要改代码凑数。

- [ ] **Step 6: 读路径耗时**

```powershell
1..3 | ForEach-Object { [int](Measure-Command { Invoke-WebRequest http://127.0.0.1:7700/sessions -UseBasicParsing | Out-Null }).TotalMilliseconds }
```

Expected: 第 2、3 次明显快于第 1 次。记录数值。

- [ ] **Step 7: ACP 冒烟（会向用户 OpenCode 配置的默认模型发送一条提示词，执行前先征得用户同意）**

```powershell
$h = @{ "content-type" = "application/json" }
$c = Invoke-RestMethod -Method Post http://127.0.0.1:7700/connect -Headers $h -Body (@{ backend = "acp"; command = "opencode"; args = @("acp"); cwd = "D:\Code\agent-strata" } | ConvertTo-Json)
$c
$s = Invoke-RestMethod -Method Post http://127.0.0.1:7700/sessions -Headers $h -Body (@{ connection_id = $c.id; directory = "D:\Code\agent-strata" } | ConvertTo-Json)
$s
Invoke-RestMethod -Method Post "http://127.0.0.1:7700/sessions/$([uri]::EscapeDataString($s.id))/prompt" -Headers $h -Body (@{ text = "Reply with exactly the word: pong" } | ConvertTo-Json)
```

每隔几秒执行一次下面的命令，直到 `busy` 为 `False`：

```powershell
$v = Invoke-RestMethod "http://127.0.0.1:7700/sessions/$([uri]::EscapeDataString($s.id))/view"
$v.backend; $v.busy; ($v.turns[-1].assistant | ForEach-Object { $_.content } | Where-Object { $_.type -eq "text" }).text
```

Expected: `backend` 为 `acp`，最终 `busy` 为 `False`，assistant 文本里包含 `pong`。

然后清理这个测试会话（ACP 会话同时存在于 OpenCode 的存储里）：

```powershell
Invoke-RestMethod -Method Delete "http://127.0.0.1:4096/session/$($s.native_id)?directory=$([uri]::EscapeDataString('D:\Code\agent-strata'))"
Invoke-RestMethod -Method Delete "http://127.0.0.1:7700/connections/$([uri]::EscapeDataString($c.id))"
```

- [ ] **Step 8: 停止 service**

```powershell
Stop-Process $svc.Id
Remove-Item Env:STRATA_OPENCODE_URL
```

- [ ] **Step 9: README**

在 `README.md` 中：

9a. 把第一段（`Cross-backend agent session/event layer: ...`）替换为：

```markdown
Cross-backend agent session layer: one canonical event format (CASF v0) that OpenCode (HTTP/SSE) and any ACP agent (stdio) map into, an event store, a pure projector, and a policy engine. The desktop app is a reader over that layer, not a client for one backend. All modules are independently testable with no network or LLM access. `packages/` holds the core libraries; `apps/` holds the UIs.

## Data model

- **The store is a rebuildable cache for imported sessions.** Events an adapter can reproduce from the backend's own record (session metadata, turns, tool calls and results, file changes) are replaced wholesale when that adapter's mapping version changes (`OPENCODE_MAPPER_VERSION`), or on `POST /sessions/:id/rebuild`.
- **Facts only strata saw are kept across rebuilds**: permission requests and decisions, questions and answers, status changes.
- **Streaming snapshots are never stored.** A message still being written lives in the service's memory and reaches readers over `/stream`; the completed message is what the log keeps.
- **Adapters own their backends' quirks.** Diffs, tool names and argument shapes are mapped in the adapter; the projector reads only CASF.
- `bun run scripts/check-store.ts` reports whether a store holds these invariants.
```

9b. 在 Packages 表格中把 `@agent-strata/service` 一行的说明末尾改为 `... live `/stream`, `/connect` for OpenCode (`baseUrl`) and ACP agents (`backend: "acp"`, `command`, `args`) — the desktop UI's backend`。

9c. 在 `## Security model` 之前加：

```markdown
## Connecting an ACP agent

Any agent that speaks ACP over stdio can be a backend:

```sh
curl -X POST http://127.0.0.1:7700/connect -H 'content-type: application/json' \
  -d '{"backend":"acp","command":"opencode","args":["acp"],"cwd":"/path/to/project"}'
```

v0 ACP limitations: sessions live as long as the agent process (no `session/load`), so a session from an earlier run is read-only; there are no model or agent pickers; replies appear when each step finishes rather than streaming.
```

- [ ] **Step 10: 最终回归与提交**

Run: `bun test` → `0 fail`；`bun run typecheck`，`echo $LASTEXITCODE` → `0`；`bun --cwd apps/desktop/ui run typecheck`，`echo $LASTEXITCODE` → `0`

```powershell
git add scripts/check-store.ts README.md
git commit -m "docs: describe the layer, its data model, and how to connect an ACP agent"
```

- [ ] **Step 11: 交给用户做的手动检查（执行者只列出，不代做）**

请用户运行 `bun run sidecar`，再运行 `bun x tauri dev --config apps/desktop/src-tauri/tauri.conf.json`，然后确认：
1. 在 OpenCode 会话里发一条消息，生成中的文字平滑出现，滚动不卡顿。
2. 文件栏里 edit 带 `+n −n` 和 diff，点击能跳到对应 turn；bash 改的文件显示为"无法解释"。
3. 在连接面板切到"ACP 代理"，输入 `opencode acp` 能连上；侧栏能选择新会话发往哪个连接。

---

## 本计划不做的事（后续单独立项）

- **同一会话经两条通道进来时的身份合并**：`opencode acp` 建的会话会同时出现为 `acp:opencode:ses_x` 和 `opencode:ses_x`。需要按 `source.native_id` 关联，或在 ACP 接 OpenCode 时跳过，留给下一份计划。
- ACP 的流式输出（`AcpRecorder` 目前在一步结束时才 flush），以及 ACP 的 `session/load`。
- 接入一个真正不同的 agent（如 Claude Code 的 ACP 适配器）来检验 CASF。这需要用户提供对应的凭据。
- projector 改成真正的增量 reducer、view 按 turn 分页下发。本计划只做服务端缓存和前端合并快照。
- 拆分 `packages/service/src/index.ts` 的路由。
- OpenCode 的 `apply_patch` 工具（GPT 系模型使用）的 diff 映射。用户本地数据里目前没有这个工具。
