# 实时流式与刷新：实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode 的回复在 strata 里逐字出现，生成过程中会话不再被重建，会话页也不再为每个事件整份重拉 view。

**Architecture:**
- **adapter 消费增量**：消费 `message.part.delta`，把增量拼进已有的 part；流式快照最多每 50ms 一帧，增量停下时由 ingestor 的定时器补发最后一帧。
- **实时会话记下 mapper**：从 `session.created` 起就被 strata 看着的会话，记下写它的 mapper 版本，`/sync` 就不会再把它当成旧映射重建。
- **会话页只拉尾部**：service 提供 `GET /sessions/:id/view?tail=N`，只返回最后 N 轮，文件列表没变时不返回；会话页在生成中只合并这一段尾部，遇到重建、回放或者对不上时才回到整份 view。

**Tech Stack:** Bun 1.3（`bun:sqlite`、`bun test`）、TypeScript 5.5、`@opencode-ai/sdk` 1.18.35（v2 types）、Solid + Vite（桌面 UI）。

上级文档：[`2026-10-10-opencode-first-class-roadmap.md`](./2026-10-10-opencode-first-class-roadmap.md)，P0 第 1 项。

## Global Constraints

- 运行环境是 Windows PowerShell 5.1：**不要用 `&&` 串联命令**，逐条执行；判断 `bun run typecheck` 成败看 `$LASTEXITCODE`（它会把 `$ tsc ...` 打到 stderr，PowerShell 显示成红字 NativeCommandError，这不是失败）。
- 每个任务结束必须：`bun test` 全绿（3 个 e2e 用例 skip 是正常的）、`bun run typecheck` 后 `$LASTEXITCODE` 为 0；改了 UI 的任务额外跑 `bun --cwd apps/desktop/ui run typecheck`。
- 代码注释只写代码本身表达不了的约束，用英文，风格对齐现有代码；不要写"这里改了什么/为什么这么改"之类面向评审的注释。
- 提交信息沿用仓库风格：`type(scope): lower-case sentence`，英文。
- **UI 视觉冻结**：只改 Task 4 列出的数据流代码；不改任何视觉、样式、文案，不改 `apps/desktop/DESIGN.md`。
- 本地开发数据库 `~/.agent-strata/events.db` 可以随意清空；`policy.json`、`connection.json`/`connections.json` 不要删。
- 根目录的 `.tmp-*.ts` 是用户的调试脚本，不要删除、不要提交。
- OpenCode 服务 `opencode serve` 运行在 `http://127.0.0.1:4096`，strata 服务在 `http://127.0.0.1:7700`，Task 5 会用到。
- 某一步的预期结果和实际不符、且原因不在本任务范围内时，**停下来报告**，不要去改计划外的代码。

## 规划时已核实的事实（执行者不需要再验证）

1. `message.part.delta` 的形状（SDK `dist/v2/gen/types.gen.d.ts` 第 974 行）：`{ id, type: "message.part.delta", properties: { sessionID, messageID, partID, field, delta } }`。实测 `field` 只出现过 `"text"`。part 先以 `message.part.updated`（`text: ""`）出现，随后是一串增量，结束时再来一次带完整文本的 `message.part.updated`。
2. 实测：一条约 1400 字符的回复，OpenCode 在约 2 秒内发出 22 个增量；strata 发出的流式快照文本长度依次为 0、1408、1408，随后是最终消息。
3. 新会话的 `sessions.mapper` 为 `NULL`。`syncDriver` 的 `stale` 判断是 `store.sessionMapper(id) !== driver.mapperVersion`，所以它被当成旧映射；`refreshSessions` 对它调用 `rebuildSession`，service 广播 `session.rebuilt`。侧栏 `App.tsx` 每 12 秒和窗口获得焦点时调用 `/sync`。
4. 导入路径（`snapshotEvents`）产生的 `session.created` 的事件 id 以 `import:` 开头；实时总线上的事件 id 形如 `evt_...`，测试夹具里是 `e1`。
5. 最大会话的 view 为 6.8MB：`turns` 6.3MB（86 轮），`files_changed` 785KB，最后 3 轮 47KB。
6. `App.tsx` 对每个非快照的流事件都会重新请求 `/sessions` 和 `/workspaces`；`/workspaces` 会对每个连接调用 `listWorkspaces()`，也就是一次 OpenCode `project.list` 请求。
7. `SessionDetail` 在 `App.tsx` 里是 `<Show ... keyed>` 挂载的，换会话就重新挂载，组件内的普通变量不会跨会话残留。

## 文件结构

| 文件 | 职责 | 任务 |
| --- | --- | --- |
| `packages/store/src/index.ts` | 新增 `markMapper` | 1 |
| `packages/store/test/rebuild.test.ts` | `markMapper` 测试 | 1 |
| `packages/adapter-opencode/src/index.ts` | `Sink.markMapped`；消费 `message.part.delta`；可注入时钟；`held`/`streamSnapshot`/`flushStreaming`；ingestor 补帧定时器与 `stop` | 1, 2, 3 |
| `packages/adapter-opencode/test/opencode.test.ts` | 对应测试 | 1, 2, 3 |
| `packages/service/src/driver.ts` | `BackendSink.markMapped` | 1 |
| `packages/service/src/views.ts` | `filesKeyOf` | 4 |
| `packages/service/src/index.ts` | sink 接线；`?tail=` 路由 | 1, 4 |
| `packages/service/test/service.test.ts` | 对应测试 | 1, 4 |
| `apps/desktop/ui/src/api.ts` | `ViewTail`、`readViewTail` | 4 |
| `apps/desktop/ui/src/live.ts`、`live.test.ts` | `mergeViewTail` 及测试 | 4 |
| `apps/desktop/ui/src/session-detail.tsx` | 生成中只拉尾部 | 4 |
| `apps/desktop/ui/src/App.tsx` | 只在会话增删改时重拉项目列表 | 4 |
| `scripts/probe-stream.ts`（新） | 端到端流式探针 | 5 |
| `README.md` | adapter 行为说明 | 5 |

---

### Task 1: 实时见到的会话记下 mapper 版本

**Files:**
- Modify: `packages/store/src/index.ts`（`Store` 接口约第 54 行；实现放在 `sessionMapper` 之后，约第 355 行）
- Modify: `packages/store/test/rebuild.test.ts`
- Modify: `packages/adapter-opencode/src/index.ts`（`Sink` 第 12–21 行；`createIngestor` 的 `handle`，约第 930 行）
- Modify: `packages/adapter-opencode/test/opencode.test.ts`（`describe("createIngestor seam")` 内）
- Modify: `packages/service/src/driver.ts`（`BackendSink`）
- Modify: `packages/service/src/index.ts`（`const sink: BackendSink`，约第 109 行）
- Modify: `packages/service/test/service.test.ts`

**Interfaces:**
- Produces: `Store.markMapper(session_id: string, mapper: string): void`，只在 `mapper IS NULL` 时写入。
- Produces: `Sink.markMapped?(sessionId: string, mapper: string): void`（adapter，可选）；`BackendSink.markMapped(sessionId: string, mapper: string): void`（service，必选）。
- Produces: ingestor 在处理 id 不以 `import:` 开头的 `session.created` 时，调用 `sink.markMapped?.("opencode:<sessionID>", OPENCODE_MAPPER_VERSION)`，调用发生在该事件映射出的事件 append 之后。

- [ ] **Step 1: 写 store 的失败测试**

在 `packages/store/test/rebuild.test.ts` 的 `describe` 末尾（最后一个 `test` 之后）加入：

```ts
  test("markMapper records a mapping only where none is recorded", () => {
    const s = openStore(":memory:");
    s.append([e("s1", "session.started", { workspace: "/w" })]);
    s.markMapper("s1", "test-1");
    expect(s.sessionMapper("s1")).toBe("test-1");
    s.markMapper("s1", "test-2");
    expect(s.sessionMapper("s1")).toBe("test-1");
    s.markMapper("nope", "test-1");
    expect(s.sessionMapper("nope")).toBeNull();
    s.close();
  });
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/store/test/rebuild.test.ts`
Expected: FAIL，`s.markMapper is not a function`。

- [ ] **Step 3: 实现 `markMapper`**

`packages/store/src/index.ts` 的 `Store` 接口，在 `sessionMapper(session_id: string): string | null;` 下一行加：

```ts
  /** record the mapping behind a session that has none yet; a recorded one is kept */
  markMapper(session_id: string, mapper: string): void;
```

实现对象里，在 `sessionMapper(session_id) { ... },` 之后加：

```ts
    markMapper(session_id, mapper) {
      db.query("UPDATE sessions SET mapper=? WHERE session_id=? AND mapper IS NULL").run(mapper, session_id);
    },
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test packages/store/test/rebuild.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 adapter 的失败测试**

在 `packages/adapter-opencode/test/opencode.test.ts` 的 `describe("createIngestor seam", () => {` 内、`test("streaming snapshots go to publish, never to append", ...)` 之后加入：

```ts
  test("a session seen from its creation records the mapping that wrote it", () => {
    const marked: [string, string][] = [];
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append: () => {}, markMapped: (id, version) => marked.push([id, version]) },
      reply: async () => {},
    });
    ing.handle(sessionCreated());
    expect(marked).toEqual([[`opencode:${sid}`, OPENCODE_MAPPER_VERSION]]);
  });

  test("an imported session does not record a mapping on its own", () => {
    const marked: [string, string][] = [];
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append: () => {}, markMapped: (id, version) => marked.push([id, version]) },
      reply: async () => {},
    });
    for (const e of snapshotFixture()) ing.handle(e);
    expect(marked).toEqual([]);
  });
```

- [ ] **Step 6: 运行，确认失败**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts -t "mapping"`
Expected: FAIL（`marked` 为空数组；如果先报类型错误，说明 `Sink` 还没有 `markMapped`，同样算失败）。

- [ ] **Step 7: 实现 adapter 侧**

`packages/adapter-opencode/src/index.ts` 的 `Sink` 接口，在 `replaceSession?(...)` 之后、右花括号之前加：

```ts
  /** record which mapping wrote a session strata watched from its creation */
  markMapped?(sessionId: string, mapper: string): void;
```

`createIngestor` 返回对象里的 `handle(evt: Event) {`，把第一行 `emit(mapper.handle(evt));` 替换为：

```ts
      emit(mapper.handle(evt));
      // Unmarked, a session watched from its creation reads as stale to every
      // later sync, which then rebuilds it in the middle of a reply.
      if (evt.type === "session.created" && !evt.id.startsWith("import:")) {
        sink.markMapped?.(`opencode:${evt.properties.sessionID}`, OPENCODE_MAPPER_VERSION);
      }
```

- [ ] **Step 8: 运行，确认通过**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts`
Expected: PASS（全部）。

- [ ] **Step 9: 写 service 的失败测试**

在 `packages/service/test/service.test.ts` 的 `describe("agent-strata service", () => {` 内第一个 `test` 之前加入：

```ts
  test("a session marked by its mapping is not stale to the next sync", () => {
    const svc = startService({ db: ":memory:", port: 0 });
    seed(svc, "opencode:born");
    expect(svc.store.sessionMapper("opencode:born")).toBeNull();
    svc.sink.markMapped("opencode:born", "opencode-3");
    expect(svc.store.sessionMapper("opencode:born")).toBe("opencode-3");
    svc.sink.markMapped("opencode:born", "opencode-2");
    expect(svc.store.sessionMapper("opencode:born")).toBe("opencode-3");
    svc.stop();
  });
```

- [ ] **Step 10: 运行，确认失败**

Run: `bun test packages/service/test/service.test.ts -t "marked by its mapping"`
Expected: FAIL，`svc.sink.markMapped is not a function`。

- [ ] **Step 11: 实现 service 侧**

`packages/service/src/driver.ts` 的 `BackendSink`，在 `replaceSession(...)` 声明之后加：

```ts
  markMapped(sessionId: string, mapper: string): void;
```

`packages/service/src/index.ts` 的 `const sink: BackendSink = { ... }`，在 `replaceSession: ... },` 之后、右花括号之前加：

```ts
    markMapped: (sessionId, mapper) => store.markMapper(sessionId, mapper),
```

- [ ] **Step 12: 全量验证**

Run: `bun test`
Expected: 全绿（3 个 e2e skip）。

Run: `bun run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

- [ ] **Step 13: Commit**

```powershell
git add packages/store/src/index.ts packages/store/test/rebuild.test.ts packages/adapter-opencode/src/index.ts packages/adapter-opencode/test/opencode.test.ts packages/service/src/driver.ts packages/service/src/index.ts packages/service/test/service.test.ts
git commit -m "fix(store,adapter-opencode,service): stop rebuilding a session strata watched from its creation"
```

---

### Task 2: 消费 `message.part.delta`，快照间隔 50ms

**Files:**
- Modify: `packages/adapter-opencode/src/index.ts`
- Modify: `packages/adapter-opencode/test/opencode.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `export const STREAM_SNAPSHOT_MS = 50`。
- Produces: `new OpencodeMapper({ directory?: string; now?: () => number })`；`now` 缺省为 `Date.now`。
- Produces（类内私有，Task 3 依赖）：`private held: Map<string, { s: SessionState; m: MsgState }>`（按 message id）；`private streamSnapshot(messageID: string): EventInput | undefined`，距上一帧不足 `STREAM_SNAPSHOT_MS` 时返回 `undefined` 并保留在 `held` 里。

- [ ] **Step 1: 写失败测试**

在 `packages/adapter-opencode/test/opencode.test.ts` 顶部的 import 列表里加上 `STREAM_SNAPSHOT_MS`：

```ts
import {
  normalizeOpencodeEvent,
  OpencodeMapper,
  createIngestor,
  snapshotEvents,
  rebuildEvents,
  OPENCODE_REBUILT_TYPES,
  OPENCODE_MAPPER_VERSION,
  STREAM_SNAPSHOT_MS,
} from "../src/index";
```

在文件末尾加入：

```ts
describe("text that arrives as deltas", () => {
  const streaming = (now: () => number) => {
    const m = new OpencodeMapper({ now });
    m.handle(sessionCreated());
    m.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } }));
    m.handle(partUpdated({ id: "pu", sessionID: sid, messageID: "u1", type: "text", text: "hi" }));
    m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2 }, providerID: "p", modelID: "m",
    }));
    return m;
  };
  const delta = (partID: string, text: string, field = "text"): Event =>
    ({
      id: `d-${partID}-${text}`,
      type: "message.part.delta",
      properties: { sessionID: sid, messageID: "a1", partID, field, delta: text },
    }) as unknown as Event;
  const snaps = (evs: { type: string; data: unknown }[]) =>
    evs
      .filter((e) => e.type === "turn.assistant")
      .map((e) => e.data as { partial?: boolean; content: { type: string; text?: string }[] });

  test("the window is 50ms", () => {
    expect(STREAM_SNAPSHOT_MS).toBe(50);
  });

  test("each delta extends the text part it names", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1100;
    const first = snaps(m.handle(delta("pa", "Hel")));
    t = 1200;
    const second = snaps(m.handle(delta("pa", "lo")));
    expect(first[0]).toMatchObject({ partial: true, content: [{ type: "text", text: "Hel" }] });
    expect(second[0]!.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  test("reasoning deltas extend the thinking block", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pr", sessionID: sid, messageID: "a1", type: "reasoning", text: "" }));
    t = 1100;
    const out = snaps(m.handle(delta("pr", "mull")));
    expect(out[0]!.content).toEqual([{ type: "thinking", text: "mull" }]);
  });

  test("deltas inside the window are kept for the next frame", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1010;
    expect(snaps(m.handle(delta("pa", "a")))).toHaveLength(0);
    t = 1020;
    expect(snaps(m.handle(delta("pa", "b")))).toHaveLength(0);
    t = 1060;
    expect(snaps(m.handle(delta("pa", "c")))[0]!.content).toEqual([{ type: "text", text: "abc" }]);
  });

  test("a delta for a part never seen waits for that part's full update", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    expect(m.handle(delta("ghost", "x"))).toEqual([]);
    t = 1100;
    const out = snaps(m.handle(partUpdated({ id: "ghost", sessionID: sid, messageID: "a1", type: "text", text: "whole" })));
    expect(out[0]!.content).toEqual([{ type: "text", text: "whole" }]);
  });

  test("a delta on another field is ignored", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "kept" }));
    t = 1100;
    expect(m.handle(delta("pa", "x", "metadata"))).toEqual([]);
  });

  test("the finished message carries the text the deltas built", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1100;
    m.handle(delta("pa", "done"));
    const final = m.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2, completed: 3 }, providerID: "p", modelID: "m", cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    const done = snaps(final);
    expect(done).toHaveLength(1);
    expect(done[0]!.partial).toBeUndefined();
    expect(done[0]!.content).toEqual([{ type: "text", text: "done" }]);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts -t "deltas"`
Expected: FAIL（`STREAM_SNAPSHOT_MS` 未导出，或增量测试拿不到快照）。

- [ ] **Step 3: 导出常量并改为 50ms**

把

```ts
// how often a mid-generation assistant snapshot is emitted (part updates can
// fire per-token; the store and SSE fan-out only need periodic snapshots)
const STREAM_SNAPSHOT_MS = 150;
```

替换为

```ts
// Deltas arrive per token; a reader needs about twenty frames a second.
export const STREAM_SNAPSHOT_MS = 50;
```

- [ ] **Step 4: 可注入时钟与 `held`**

把 `OpencodeMapper` 类开头的

```ts
export class OpencodeMapper {
  sessions = new Map<string, SessionState>();

  constructor(private opts: { directory?: string } = {}) {}
```

替换为

```ts
export class OpencodeMapper {
  sessions = new Map<string, SessionState>();
  /** assistant messages with text no snapshot has carried yet, by message id */
  private held = new Map<string, { s: SessionState; m: MsgState }>();

  constructor(private opts: { directory?: string; now?: () => number } = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A snapshot of a held message, unless the last one went out inside the window. */
  private streamSnapshot(messageID: string): EventInput | undefined {
    const held = this.held.get(messageID);
    if (!held) return undefined;
    const { s, m } = held;
    if (m.emittedAssistant || !m.parentID) {
      this.held.delete(messageID);
      return undefined;
    }
    const now = this.now();
    if (now - (m.lastStreamAt ?? 0) < STREAM_SNAPSHOT_MS) return undefined;
    this.held.delete(messageID);
    const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
    if (!content.length) return undefined;
    m.lastStreamAt = now;
    return this.ev(
      s,
      "turn.assistant",
      { turn_id: m.parentID, msg_id: messageID, partial: true, content },
      `opencode:${messageID}:assistant.partial:${Bun.hash(JSON.stringify(content)).toString(36)}`,
      // A snapshot has no clock of its own; the ingest clock would make it the
      // newest thing in a replayed session and reorder the session list.
      sourceTime(m.created ?? s.updated),
    );
  }
```

- [ ] **Step 5: `message.part.updated` 的流式分支改走 `held`**

在 `case "message.part.updated":` 末尾的共享尾部里，把整个 assistant 分支

```ts
        } else if (m.role === "assistant" && m.parentID && !m.emittedAssistant) {
          const now = Date.now();
          if (now - (m.lastStreamAt ?? 0) >= STREAM_SNAPSHOT_MS) {
            const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
            if (content.length) {
              m.lastStreamAt = now;
              out.push(
                this.ev(
                  s,
                  "turn.assistant",
                  {
                    turn_id: m.parentID,
                    msg_id: part.messageID,
                    partial: true,
                    content,
                  },
                  `opencode:${part.messageID}:assistant.partial:${Bun.hash(JSON.stringify(content)).toString(36)}`,
                  // A streaming snapshot has no clock of its own either. Leaving
                  // it to the ingest clock meant a session replayed on connect
                  // kept one event stamped with the moment we connected, which
                  // was then the newest thing in the session and decided where
                  // the session list put it.
                  sourceTime(m.created ?? s.updated),
                ),
              );
            }
          }
        }
```

替换为

```ts
        } else if (m.role === "assistant" && m.parentID && !m.emittedAssistant) {
          this.held.set(part.messageID, { s, m });
          const snap = this.streamSnapshot(part.messageID);
          if (snap) out.push(snap);
        }
```

- [ ] **Step 6: 新增 `message.part.delta` 分支**

在 `case "session.idle":` 那一行之前插入：

```ts
      case "message.part.delta": {
        const p = evt.properties;
        if (p.field !== "text") return out;
        const s = this.sessions.get(p.sessionID);
        const m = s?.messages.get(p.messageID);
        const block = m?.parts.get(p.partID);
        // A delta extends a part already held. One for a part never seen (the
        // stream joined mid-message) waits for that part's next full update.
        if (!s || !m || !block || (block.type !== "text" && block.type !== "thinking")) return out;
        m.parts.set(p.partID, { ...block, text: block.text + p.delta });
        if (m.role === "assistant" && m.parentID && !m.emittedAssistant) {
          this.held.set(p.messageID, { s, m });
          const snap = this.streamSnapshot(p.messageID);
          if (snap) out.push(snap);
        }
        return out;
      }
```

- [ ] **Step 7: 完成和空闲时放掉 `held`**

在 `case "message.updated":` 的 assistant 分支里，把

```ts
          if (info.time.completed !== undefined && !m.emittedAssistant) {
            m.emittedAssistant = true;
```

替换为

```ts
          if (info.time.completed !== undefined && !m.emittedAssistant) {
            m.emittedAssistant = true;
            this.held.delete(info.id);
```

在 `case "session.idle": case "session.status": {` 分支里，把

```ts
        if (idle) for (const msgID of [...s.pendingUserMsgs]) this.flushUser(s, out, msgID);
```

替换为

```ts
        if (idle) {
          for (const msgID of [...s.pendingUserMsgs]) this.flushUser(s, out, msgID);
          // a message that never finished is retired by the overlay at idle; a
          // late frame for it would bring it back
          for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
        }
```

- [ ] **Step 8: 运行，确认通过**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts`
Expected: PASS（含原有的 `assistant part updates emit throttled partial turn.assistant`：它在窗口内连续调用、再 `sleep(160)`，对 50ms 窗口同样成立）。

- [ ] **Step 9: 全量验证**

Run: `bun test`
Expected: 全绿。

Run: `bun run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

- [ ] **Step 10: Commit**

```powershell
git add packages/adapter-opencode/src/index.ts packages/adapter-opencode/test/opencode.test.ts
git commit -m "feat(adapter-opencode): stream text from message.part.delta at twenty frames a second"
```

---

### Task 3: 增量停下时补发最后一帧

**Files:**
- Modify: `packages/adapter-opencode/src/index.ts`
- Modify: `packages/adapter-opencode/test/opencode.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `held`、`streamSnapshot`、`STREAM_SNAPSHOT_MS`。
- Produces: `OpencodeMapper.hasHeldStreams(): boolean`；`OpencodeMapper.flushStreaming(): EventInput[]`（只放出窗口已过的帧）。
- Produces: `createIngestor(...)` 返回 `{ handle(evt: Event): void; stop(): void }`；`connectOpencode` 的 `stop()` 会调用 `ingestor.stop()`。

- [ ] **Step 1: 写失败测试**

在 Task 2 加的 `describe("text that arrives as deltas", ...)` 内末尾加入：

```ts
  test("a frame held by the window goes out once the window passes", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1010;
    expect(snaps(m.handle(delta("pa", "tail")))).toHaveLength(0);
    expect(m.hasHeldStreams()).toBe(true);
    t = 1020;
    expect(m.flushStreaming()).toEqual([]);
    t = 1060;
    expect(snaps(m.flushStreaming())[0]!.content).toEqual([{ type: "text", text: "tail" }]);
    expect(m.hasHeldStreams()).toBe(false);
  });

  test("nothing is held once the message finishes or the session goes idle", () => {
    let t = 0;
    const m = streaming(() => t);
    t = 1000;
    m.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    t = 1010;
    m.handle(delta("pa", "x"));
    expect(m.hasHeldStreams()).toBe(true);
    m.handle({ id: "idle", type: "session.idle", properties: { sessionID: sid } } as unknown as Event);
    expect(m.hasHeldStreams()).toBe(false);
  });

  test("the ingestor sends the held frame without waiting for another event", async () => {
    const published: { data: unknown }[] = [];
    const ing = createIngestor({
      mapper: new OpencodeMapper(),
      sink: { append: () => {}, publish: (e) => published.push(...e) },
      reply: async () => {},
    });
    ing.handle(sessionCreated());
    ing.handle(msgUpdated({ id: "u1", sessionID: sid, role: "user", time: { created: 1 } }));
    ing.handle(partUpdated({ id: "pu", sessionID: sid, messageID: "u1", type: "text", text: "hi" }));
    ing.handle(msgUpdated({
      id: "a1", sessionID: sid, role: "assistant", parentID: "u1",
      time: { created: 2 }, providerID: "p", modelID: "m",
    }));
    ing.handle(partUpdated({ id: "pa", sessionID: sid, messageID: "a1", type: "text", text: "" }));
    ing.handle(delta("pa", "last words"));
    await Bun.sleep(STREAM_SNAPSHOT_MS * 3);
    const last = published.at(-1)!.data as { content: unknown };
    expect(last.content).toEqual([{ type: "text", text: "last words" }]);
    ing.stop();
  });
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts -t "held"`
Expected: FAIL（`m.hasHeldStreams is not a function`）。

- [ ] **Step 3: mapper 增加 `hasHeldStreams` 与 `flushStreaming`**

在 Task 2 加的 `private streamSnapshot(...)` 方法之后插入：

```ts
  hasHeldStreams(): boolean {
    return this.held.size > 0;
  }

  /** Frames the window held back, for the ones whose window has passed. */
  flushStreaming(): EventInput[] {
    const out: EventInput[] = [];
    for (const messageID of [...this.held.keys()]) {
      const snap = this.streamSnapshot(messageID);
      if (snap) out.push(snap);
    }
    return out;
  }
```

- [ ] **Step 4: ingestor 补帧定时器与 `stop`**

`createIngestor` 的返回类型从

```ts
}): { handle: (evt: Event) => void } {
```

改为

```ts
}): { handle: (evt: Event) => void; stop: () => void } {
```

在 `const emit = (evts: EventInput[]) => { ... };` 之后插入：

```ts
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  // Deltas pause between steps and stop at the end of a part; the text that
  // arrived inside the last window would otherwise wait for the next event.
  const scheduleFlush = () => {
    if (flushTimer || !mapper.hasHeldStreams()) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      emit(mapper.flushStreaming());
      scheduleFlush();
    }, STREAM_SNAPSHOT_MS);
  };
```

返回对象的 `handle` 里，在 Task 1 加的 `markMapped` 判断之后加一行：

```ts
      scheduleFlush();
```

返回对象里，在 `handle(evt: Event) { ... },` 之后加：

```ts
    stop() {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    },
```

- [ ] **Step 5: `connectOpencode` 停止时停掉 ingestor**

`connectOpencode` 返回对象的 `stop()` 里，把

```ts
    stop() {
      abort.abort();
```

替换为

```ts
    stop() {
      abort.abort();
      ingestor.stop();
```

- [ ] **Step 6: 运行，确认通过**

Run: `bun test packages/adapter-opencode/test/opencode.test.ts`
Expected: PASS。

- [ ] **Step 7: 全量验证**

Run: `bun test`
Expected: 全绿。

Run: `bun run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

- [ ] **Step 8: Commit**

```powershell
git add packages/adapter-opencode/src/index.ts packages/adapter-opencode/test/opencode.test.ts
git commit -m "feat(adapter-opencode): send the last streamed words when the deltas stop"
```

---

### Task 4: 生成中只拉最后几轮

**Files:**
- Modify: `packages/service/src/views.ts`
- Modify: `packages/service/src/index.ts`（import 行；`/sessions/:id/view` 路由，约第 360 行）
- Modify: `packages/service/test/service.test.ts`
- Modify: `apps/desktop/ui/src/api.ts`
- Modify: `apps/desktop/ui/src/live.ts`
- Modify: `apps/desktop/ui/src/live.test.ts`
- Modify: `apps/desktop/ui/src/session-detail.tsx`
- Modify: `apps/desktop/ui/src/App.tsx`（`es.onmessage`，约第 354 行）

**Interfaces:**
- Produces: `filesKeyOf(view: SessionView): string`（`packages/service/src/views.ts`）。
- Produces: `GET /sessions/:id/view?tail=N[&files_key=K]` 返回 `SessionView` 的全部字段，但：
  - `turns` 只有最后 N 轮
  - 另带 `turn_offset: number`、`prev_turn_id: string | null`、`files_key: string`
  - `files_key` 与请求里的 `K` 相同时不带 `files_changed`
- Produces（UI）：`interface ViewTail`、`readViewTail(id: string, turns: number, filesKey?: string): Promise<ViewTail>`（`api.ts`）；`mergeViewTail(view: SessionView, tail: ViewTail): SessionView | undefined`（`live.ts`）。

- [ ] **Step 1: 写 service 的失败测试**

在 `packages/service/test/service.test.ts` 的 `describe` 内，Task 1 加的测试之后加入：

```ts
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

    const all = await view("?tail=10");
    expect(all.turn_offset).toBe(0);
    expect(all.prev_turn_id).toBeNull();
    expect(all.turns).toHaveLength(2);

    svc.stop();
  });
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/service/test/service.test.ts -t "tail view"`
Expected: FAIL（`turn_offset` 为 `undefined`）。

- [ ] **Step 3: 实现 `filesKeyOf` 与路由**

`packages/service/src/views.ts` 文件末尾加入：

```ts
/** File changes only ever add records, so the record count names a files list. */
export function filesKeyOf(view: SessionView): string {
  return `${view.files_changed.length}:${view.files_changed.reduce((n, f) => n + f.count, 0)}`;
}
```

`packages/service/src/index.ts` 把

```ts
import { ViewCache } from "./views";
```

改为

```ts
import { filesKeyOf, ViewCache } from "./views";
```

在 `/sessions/:id/view` 路由里，把

```ts
        const sid = decodeURIComponent(sessionMatch[1]!);
        const untilSeq = url.searchParams.get("until_seq");
```

替换为

```ts
        const sid = decodeURIComponent(sessionMatch[1]!);
        const tail = url.searchParams.get("tail");
        if (tail !== null) {
          const v = sessionView(sid);
          const n = Math.max(1, Math.floor(Number(tail)) || 1);
          const offset = Math.max(0, v.turns.length - n);
          const key = filesKeyOf(v);
          const { files_changed, ...rest } = v;
          return json({
            ...rest,
            turns: v.turns.slice(offset),
            turn_offset: offset,
            prev_turn_id: offset > 0 ? v.turns[offset - 1]!.turn_id : null,
            files_key: key,
            ...(url.searchParams.get("files_key") === key ? {} : { files_changed }),
          });
        }
        const untilSeq = url.searchParams.get("until_seq");
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test packages/service/test/service.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 UI 合并函数的失败测试**

`apps/desktop/ui/src/live.test.ts` 顶部两行 import 改为：

```ts
import { applyStreamingSnapshot, isStreamingSnapshotMessage, mergeViewTail } from "./live";
import type { SessionView, ViewTail } from "./api";
```

文件末尾加入：

```ts
describe("a view's tail laid over the one the reader holds", () => {
  const held = (): SessionView => {
    const v = base();
    v.turns.push({ turn_id: "u2", user: [{ type: "text", text: "next" }], assistant: [], tool_calls: [] });
    v.files_changed = [
      { path: "/a", change: "modify", count: 1, additions: 1, deletions: 0, edits: [], unexplained: false },
    ] as unknown as SessionView["files_changed"];
    return v;
  };
  const tail = (over: Partial<ViewTail> = {}): ViewTail => {
    const { files_changed: _files, ...rest } = base();
    return {
      ...rest,
      turns: [
        {
          turn_id: "u2",
          user: [{ type: "text", text: "next" }],
          assistant: [{ content: [{ type: "text", text: "on it" }], msg_id: "a2" }],
          tool_calls: [],
        },
      ],
      turn_offset: 1,
      prev_turn_id: "u1",
      files_key: "1:1",
      ...over,
    };
  };

  test("turns from the offset on are replaced and the ones before are kept", () => {
    const v = held();
    const merged = mergeViewTail(v, tail())!;
    expect(merged.turns.map((t) => t.turn_id)).toEqual(["u1", "u2"]);
    expect(merged.turns[0]).toBe(v.turns[0]);
    expect(merged.turns[1]!.assistant[0]!.msg_id).toBe("a2");
  });

  test("a tail without files keeps the reader's files", () => {
    const v = held();
    expect(mergeViewTail(v, tail())!.files_changed).toBe(v.files_changed);
  });

  test("a tail with files replaces them", () => {
    expect(mergeViewTail(held(), tail({ files_changed: [] }))!.files_changed).toEqual([]);
  });

  test("a tail that starts past what the reader holds asks for the full view", () => {
    expect(mergeViewTail(held(), tail({ turn_offset: 5, prev_turn_id: "u9" }))).toBeUndefined();
  });

  test("a tail after a turn the reader does not have asks for the full view", () => {
    expect(mergeViewTail(held(), tail({ prev_turn_id: "other" }))).toBeUndefined();
  });

  test("the merged view carries none of the tail's bookkeeping", () => {
    const merged = mergeViewTail(held(), tail()) as unknown as Record<string, unknown>;
    expect(merged.turn_offset).toBeUndefined();
    expect(merged.prev_turn_id).toBeUndefined();
    expect(merged.files_key).toBeUndefined();
  });
});
```

- [ ] **Step 6: 运行，确认失败**

Run: `bun test apps/desktop/ui/src/live.test.ts`
Expected: FAIL（`mergeViewTail` 未导出）。

- [ ] **Step 7: 实现 `ViewTail`、`readViewTail`、`mergeViewTail`**

`apps/desktop/ui/src/api.ts`，在 `export interface SessionView { ... }` 之后插入：

```ts
/** The last turns of a session's view, and where they sit in the whole. */
export interface ViewTail extends Omit<SessionView, "files_changed"> {
  turn_offset: number;
  /** the turn just before the tail, so a reader can tell the two still line up */
  prev_turn_id: string | null;
  /** names the files list; sending it back leaves an unchanged list out */
  files_key: string;
  files_changed?: SessionView["files_changed"];
}
```

在 `export async function searchSession(...)` 之前插入：

```ts
export async function readViewTail(id: string, turns: number, filesKey?: string): Promise<ViewTail> {
  const q = new URLSearchParams({ tail: String(turns) });
  if (filesKey) q.set("files_key", filesKey);
  return getJson<ViewTail>(`/sessions/${encodeURIComponent(id)}/view?${q}`);
}
```

`apps/desktop/ui/src/live.ts` 第一行改为：

```ts
import type { ContentBlock, SessionView, ViewTail } from "./api";
```

在 `applyStreamingSnapshot` 函数之后插入：

```ts
/** Lay a view's last turns over the one the reader holds; undefined when the two no longer line up. */
export function mergeViewTail(view: SessionView, tail: ViewTail): SessionView | undefined {
  const { turn_offset, prev_turn_id, files_key: _key, files_changed, ...rest } = tail;
  if (turn_offset > view.turns.length) return undefined;
  if ((view.turns[turn_offset - 1]?.turn_id ?? null) !== prev_turn_id) return undefined;
  return {
    ...rest,
    turns: view.turns.slice(0, turn_offset).concat(tail.turns),
    files_changed: files_changed ?? view.files_changed,
  };
}
```

- [ ] **Step 8: 运行，确认通过**

Run: `bun test apps/desktop/ui/src/live.test.ts`
Expected: PASS。

- [ ] **Step 9: 会话页在生成中只拉尾部**

`apps/desktop/ui/src/session-detail.tsx`：

(a) `from "./api"` 的 import 列表里，在 `realWorkspace,` 之后加 `readViewTail,`。把

```ts
import { applyStreamingSnapshot, type StreamingSnapshot } from "./live";
```

改为

```ts
import { applyStreamingSnapshot, mergeViewTail, type StreamingSnapshot } from "./live";
```

(b) 在 `async function readHead(id: string)` 函数之前插入模块级常量：

```ts
/** turns a live refresh asks for; a durable event during a reply lands in the last one or two */
const TAIL_TURNS = 3;
```

(c) 在组件体里 `createEffect(() => writeDraft(props.id, draft()));` 这一行之前插入：

```ts
  // A durable event during a reply only moves the last turns, and the whole
  // view of a long session is megabytes. A rebuild, a replay, or a tail that no
  // longer lines up goes back to the full view.
  let filesKey: string | undefined;
  let tailing = false;
  let tailAgain = false;
  const refreshTail = async () => {
    if (replayPos() !== null) return;
    if (tailing) {
      tailAgain = true;
      return;
    }
    tailing = true;
    try {
      do {
        tailAgain = false;
        const current = settled(view);
        if (!current) {
          await refetch();
          continue;
        }
        const tail = await readViewTail(props.id, TAIL_TURNS, filesKey);
        if (replayPos() !== null) return;
        const merged = mergeViewTail(settled(view) ?? current, tail);
        if (!merged) {
          filesKey = undefined;
          await refetch();
          continue;
        }
        filesKey = tail.files_key;
        mutate(merged);
      } while (tailAgain);
    } catch {
      // the next event or the head poll asks again
    } finally {
      tailing = false;
    }
  };
```

(d) 在 `onMount` 的轮询里，把

```ts
        .then((seq) => {
          if (seq === maxSeq()) return;
          void refetch();
          void refetchSeq();
        })
```

替换为

```ts
        .then((seq) => {
          if (seq === maxSeq()) return;
          void refreshTail();
          void refetchSeq();
        })
```

(e) 把

```ts
    const es = new EventSource(api("/stream"));
    let timer: ReturnType<typeof setTimeout> | undefined;
```

替换为

```ts
    const es = new EventSource(api("/stream"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rebuilt = false;
```

并把

```ts
        if (evt.session_id === props.id || evt.type === "permission.requested" || evt.type === "question.asked") {
          if (replayPos() === null) {
            clearTimeout(timer);
            timer = setTimeout(() => {
              refetch();
              refetchAsks();
              refetchQuestions();
              refetchSeq();
            }, 80);
          }
        }
```

替换为

```ts
        if (evt.session_id === props.id || evt.type === "permission.requested" || evt.type === "question.asked") {
          if (replayPos() === null) {
            if (evt.session_id === props.id && evt.type === "session.rebuilt") rebuilt = true;
            clearTimeout(timer);
            timer = setTimeout(() => {
              if (rebuilt) {
                rebuilt = false;
                refetch();
              } else void refreshTail();
              refetchAsks();
              refetchQuestions();
              refetchSeq();
            }, 80);
          }
        }
```

- [ ] **Step 10: 侧栏只在会话增删改时重拉项目列表**

`apps/desktop/ui/src/App.tsx`，把

```ts
    es.onmessage = (m) => {
      if (isStreamingSnapshotMessage(m.data)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        refetch();
        void refetchWs();
      }, 200);
    };
```

替换为

```ts
    let wsStale = false;
    es.onmessage = (m) => {
      if (isStreamingSnapshotMessage(m.data)) return;
      // The project list costs a round trip to every backend, and only a
      // session appearing, moving or going away can change it.
      try {
        const type = (JSON.parse(m.data) as { type?: string }).type;
        if (type === "session.started" || type === "session.updated" || type === "session.deleted") wsStale = true;
      } catch {
        // heartbeats
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        refetch();
        if (wsStale) {
          wsStale = false;
          void refetchWs();
        }
      }, 200);
    };
```

- [ ] **Step 11: 全量验证**

Run: `bun test`
Expected: 全绿。

Run: `bun run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

Run: `bun --cwd apps/desktop/ui run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

- [ ] **Step 12: Commit**

```powershell
git add packages/service/src/views.ts packages/service/src/index.ts packages/service/test/service.test.ts apps/desktop/ui/src/api.ts apps/desktop/ui/src/live.ts apps/desktop/ui/src/live.test.ts apps/desktop/ui/src/session-detail.tsx apps/desktop/ui/src/App.tsx
git commit -m "perf(service,desktop-ui): refresh only the last turns while a session runs"
```

---

### Task 5: 端到端探针与 README

**Files:**
- Create: `scripts/probe-stream.ts`
- Modify: `README.md`（`v0 adapter-opencode limitations` 段落）

**Interfaces:**
- Consumes: Task 1–4 的全部行为；运行中的 `opencode serve`（4096）和用当前代码启动的 strata 服务（7700）。
- Produces: `bun run scripts/probe-stream.ts`，通过时退出码为 0，并打印 JSON 报告。

- [ ] **Step 1: 写探针脚本**

创建 `scripts/probe-stream.ts`：

```ts
// Streams one short reply through OpenCode and strata at once and reports
// whether a reader saw it being written. It creates a real session, spends a
// few hundred tokens on the server's default model, then deletes the session.
//
//   bun run scripts/probe-stream.ts
//
// OPENCODE_URL (default http://127.0.0.1:4096), STRATA_URL (default
// http://127.0.0.1:7700), PROBE_DIR (default the current directory).

const OC = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const ST = process.env.STRATA_URL ?? "http://127.0.0.1:7700";
const dir = process.env.PROBE_DIR ?? process.cwd();
const q = `directory=${encodeURIComponent(dir)}`;
const t0 = Date.now();
const ms = () => Date.now() - t0;

type Frame = Record<string, any>;

async function sse(url: string, onData: (d: Frame) => void, signal: AbortSignal) {
  const res = await fetch(url, { signal, headers: { accept: "text/event-stream" } });
  if (!res.body) throw new Error(`${url} returned no stream`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            onData(JSON.parse(line.slice(5).trim()));
          } catch {
            // comment frames and heartbeats
          }
        }
      }
    }
  } catch {
    // aborted
  }
}

const abort = new AbortController();
let sid = "";
let deltas = 0;
let rebuilt = 0;
let finalAt: number | undefined;
const snapshots: { t: number; len: number }[] = [];
let idle!: () => void;
const done = new Promise<void>((resolve) => (idle = resolve));

void sse(
  `${OC}/event?${q}`,
  (e) => {
    const p = e.properties ?? {};
    if (!sid || p.sessionID !== sid) return;
    if (e.type === "message.part.delta") deltas++;
    if (e.type === "session.idle" || (e.type === "session.status" && p.status?.type === "idle")) idle();
  },
  abort.signal,
);

void sse(
  `${ST}/stream`,
  (e) => {
    if (!sid || e.session_id !== `opencode:${sid}`) return;
    if (e.type === "session.rebuilt") rebuilt++;
    if (e.type !== "turn.assistant") return;
    const blocks: { type: string; text?: string }[] = e.data?.content ?? [];
    const len = blocks.filter((b) => b.type === "text").reduce((n, b) => n + (b.text?.length ?? 0), 0);
    if (e.data?.partial) snapshots.push({ t: ms(), len });
    else finalAt = ms();
  },
  abort.signal,
);

await Bun.sleep(800);
const created = (await (
  await fetch(`${OC}/session?${q}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "strata stream probe" }),
  })
).json()) as { id: string };
sid = created.id;
await fetch(`${OC}/session/${sid}/prompt_async?${q}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    parts: [
      {
        type: "text",
        text: "Write the numbers 1 to 120 as English words, separated by spaces. Do not use any tools. No other text.",
      },
    ],
  }),
});
await Promise.race([done, Bun.sleep(90_000)]);
await Bun.sleep(1500);
abort.abort();
await fetch(`${OC}/session/${sid}?${q}`, { method: "DELETE" });

const monotonic = snapshots.every((s, i) => i === 0 || s.len >= snapshots[i - 1]!.len);
const report = {
  session: sid,
  opencode_deltas: deltas,
  strata_snapshots: snapshots.length,
  monotonic,
  rebuilt_during_run: rebuilt,
  final_landed: finalAt !== undefined,
  lengths: snapshots.map((s) => s.len),
};
console.log(JSON.stringify(report, null, 2));
const ok = snapshots.length >= 10 && monotonic && rebuilt === 0 && finalAt !== undefined;
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: 用当前代码重启 strata 服务**

先结束占用 7700 端口的旧服务进程（用户正在运行的那个），再在单独的终端里启动：

```powershell
$env:STRATA_DB="$HOME\.agent-strata\events.db"; $env:STRATA_PORT=7700
bun run packages/service/src/index.ts
```

Expected: 打印 `agent-strata service listening on http://127.0.0.1:7700`，几秒内出现 `auto-connected backend opencode:http://127.0.0.1:4096`（来自已保存的连接）。如果没有自动连上，执行 `Invoke-WebRequest -Method POST -ContentType 'application/json' -Body '{"baseUrl":"http://127.0.0.1:4096"}' http://127.0.0.1:7700/connect`。

- [ ] **Step 3: 跑探针**

Run: `bun run scripts/probe-stream.ts`，然后 `$LASTEXITCODE`
Expected: `0`；报告中 `strata_snapshots` ≥ 10，`monotonic` 为 `true`，`rebuilt_during_run` 为 `0`，`final_landed` 为 `true`，`lengths` 逐步增长而不是一步跳到全长。

如果 `opencode_deltas` 本身小于 10（模型一次吐出大块文本），把提示词里的 `120` 改成 `300` 再跑一次；仍然不满足就停下来报告。

- [ ] **Step 4: 更新 README**

`README.md` 里把

```
v0 adapter-opencode limitations: only the v1 `/event` stream is consumed.
```

替换为

```
v0 adapter-opencode limitations: only the v1 `/event` stream is consumed. Text and reasoning arrive as `message.part.delta`; readers get a snapshot of the message at most every 50ms, and the last one is sent even when the deltas stop. `bun run scripts/probe-stream.ts` checks this end to end against a running OpenCode and strata.
```

- [ ] **Step 5: 全量验证**

Run: `bun test`
Expected: 全绿。

Run: `bun run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

- [ ] **Step 6: Commit**

```powershell
git add scripts/probe-stream.ts README.md
git commit -m "test(scripts): probe that a reply streams through strata as it is written"
```

- [ ] **Step 7: 请用户在桌面壳里确认**

请用户运行 `bun run sidecar`，再运行 `bun x tauri dev --config apps/desktop/src-tauri/tauri.conf.json`，然后确认：

1. 在 OpenCode 会话里发一条较长的消息，文字逐步出现，而不是整段跳出。
2. 生成过程中滚动不卡顿；切到别的窗口再切回来（会触发 `/sync`），正在生成的会话不闪、不跳回顶部。
3. 一个有很多工具调用的长会话里，工具卡片从"运行中"变成完成时，界面及时更新。

---

## 风险与后续

- **服务端每次请求都要全量投影**：会话有流式快照时，`sessionView` 会对整份事件重新投影（`projectSession([...stored, ...live])`），而且不缓存。尾部请求只在持久事件之后发生（防抖 80ms），可以接受。如果 Task 5 里大会话的尾部请求明显变慢，下一步按 `(head, live.version)` 缓存这份投影，或者把 projector 改成增量 reducer（realignment 计划里列为后续项）。
- **Markdown 每帧都整段重解析**：`Md` 组件对每一帧都把整段文本交给 `marked` 加 DOMPurify。50ms 一帧、几 KB 的消息没有问题；超长消息（几十 KB）如果出现掉帧，后续改为只重解析最后一个块。
- **尾部和本地快照的竞态**：尾部响应里的流式消息，可能比界面刚合并的快照旧一帧，最多倒退 50ms 的文字，下一帧就会补上。这里刻意不做额外处理。
