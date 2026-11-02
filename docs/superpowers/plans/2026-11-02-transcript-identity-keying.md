# 第 1 步：按身份做键 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** transcript 里的行、turn 内的消息/工具组、读者的展开选择都跟随数据身份，位置变化只移动节点，不重建组件。

**Architecture:** `Virtual` 的窗口从下标列表改成 segment id 列表（`stableKeys` 复用），行内用 `layout.indexOf(id)` 找位置；`TurnBlock` 的 flow 从 `<Index>` + `<Switch>` 改成按 flow row id 的 `<For>`，每个 id 一生只对应一种组件；展开状态从模块级 Map 移到按 (pane, session) 记忆的 `Disclosure`，由 `TranscriptView` 通过 context 提供。顺带从备份分支带回 `e4b72fa`（工具调用每个 turn 只归属一次）。

**Tech Stack:** SolidJS 1.x、Bun test（无 DOM，纯函数 + 源码断言）、Playwright bench（WebKit 优先）。

设计文档：`docs/superpowers/specs/2026-11-02-transcript-render-architecture-design.md` 第 1 步。

## Global Constraints

- 检查：`bun run typecheck`、`bun run lint`（警告即失败）、`bun run test:ui`、`bun test packages`（根目录）。
- 性能判断以 WebKit 为准；一次一个变量；每个任务前后跑 bench 对比。bench 退出码 1 是正确性失败，一律阻断。
- 对比基线（第 3 步之后的当前主干）：A–D 用 `bench/results/blocks2-wk.json`，S 用 `bench/results/final-wk-S.json`。S 的 `open` 每轮会带上前几轮写进存储的终稿，只看 `stream-reply` 与 `reply-done`。
- 注释只写代码本身表达不了的约束；风格与周围一致（英文注释、完整句子）。
- 不做：`d726cb3`（按内容估算行高）。它改变的是估算值，是另一个变量；放到第 2 步之前单独评估。

---

### Task 1: `Virtual` 按 segment id 挂行

**Files:**
- Modify: `apps/desktop/ui/src/virtual.tsx`（整体）
- Modify: `apps/desktop/ui/src/virtual-window.ts`（删 `stableIndexWindow`）
- Modify: `apps/desktop/ui/src/turn-ids.ts`（`shareTurnIds` → `stableKeys`）
- Delete: `apps/desktop/ui/src/turn-ids.test.ts`（`keyed.test.ts` 已覆盖同一行为）
- Test: `apps/desktop/ui/src/virtual-window.test.ts`、`apps/desktop/ui/src/virtual-tail.test.ts`

**Interfaces:**
- Consumes: `stableKeys(prev, next)`（`keyed.ts`），`RowLayout.indexOf(id)`、`offsets()`、`heightOf(i)`、`isMeasured(id)`。
- Produces: `Virtual<T>` 的 props 变为 `id: (item: T) => string`、`children: (item: () => T) => JSX.Element`（去掉 index 参数）。`TranscriptView` 的调用方式不变。

- [ ] **Step 1: 改结构测试，让它先失败**

`virtual-tail.test.ts`：

```ts
describe("scroll hot paths reuse work already done", () => {
  test("a measurement uses its observed row instead of indexing every turn", () => {
    const src = read("virtual.tsx");
    expect(src).not.toContain("const rowIndex");
    expect(src).toContain("const id = observed.get(e.target)");
  });
});

describe("a window that cannot be placed still draws something", () => {
  const rows = read("virtual.tsx").slice(read("virtual.tsx").indexOf("const windowIds = createMemo"));

  test("the window is computed by the range helper, not by hand", () => {
    expect(rows).toContain("mountedRange({");
    expect(rows).not.toContain("const last = Math.min(n - 1, rowAt(");
  });

  test("the range is taken inside the window memo, where the rows are decided", () => {
    const memoStart = rows.indexOf("const windowIds = createMemo");
    const call = rows.indexOf("mountedRange({");
    expect(call).toBeGreaterThan(memoStart);
    expect(call).toBeLessThan(rows.indexOf("stableKeys(prev, ids)"));
  });
});
```

`virtual-window.test.ts`：删掉 `describe("stableIndexWindow", …)` 整块和 import 里的 `stableIndexWindow`，新增：

```ts
describe("rows follow their segment, not their slot", () => {
  test("the window is a list of row ids, and the row reads its place from the layout", () => {
    const virtual = readFileSync(join(import.meta.dir, "virtual.tsx"), "utf8");
    expect(virtual).toContain("<For each={windowIds()}>");
    expect(virtual).toContain("props.layout.indexOf(id)");
    // A row keyed by id renders one item for life, so nothing has to rebind it.
    expect(virtual).not.toContain("entry.key = key");
    expect(virtual).not.toContain("stableIndexWindow");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop/ui && bun test src/virtual-tail.test.ts src/virtual-window.test.ts`
Expected: FAIL（`const id = observed.get(e.target)`、`<For each={windowIds()}>` 找不到）。

- [ ] **Step 3: 改 `virtual.tsx`**

import 改为：

```ts
import { createEffect, createMemo, For, onCleanup, untrack, type JSX } from "solid-js";
import { createPaintHold, rowPaintHold, rowPaintMode } from "./paint-mode";
import { stableKeys } from "./keyed";
import { mountedRange } from "./virtual-window";
import type { RowLayout } from "./row-layout";
```

props：`id` 改为 `id: (item: T) => string;`，doc 补一句 "`layout` is built over these same ids."；`children` 改为 `children: (item: () => T) => JSX.Element;`，doc 原文保留。

`observed`、`rowHolds`、`queueMeasure` 改为按 id / 元素：

```ts
  /**
   * Element → the id of the row it renders. Rows are keyed by id, so an
   * element renders one row for its whole life and its id never goes stale.
   */
  const observed = new Map<Element, string>();
  /**
   * Rows with deferred paints pending, by id. A deferred row paints
   * half-empty and fills in later, so a measurement taken while it is held is
   * the empty box's height — committing it erases the real height learned the
   * last time the row was on screen, the content shrinks by a column, and the
   * clamp reads as a scroll. Held rows are skipped by the observer and the
   * sweep alike; when the last hold releases, the row is queued for exactly
   * one measurement, flushed in a single commit per microtask.
   */
  const rowHolds = new Map<string, { hold: () => () => void; pending: () => number }>();
  const held = (id: string) => (rowHolds.get(id)?.pending() ?? 0) > 0;
  const pendingEls = new Set<Element>();
  let flushQueued = false;
  const queueMeasure = (el: Element) => {
    pendingEls.add(el);
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      let next: Map<string, number> | undefined;
      for (const el of pendingEls) {
        const id = observed.get(el);
        if (id === undefined || !el.isConnected) continue;
        const h = (el as HTMLElement).offsetHeight;
        if (!h) continue;
        next ??= new Map();
        next.set(id, h);
      }
      pendingEls.clear();
      if (next) props.commit(next);
    });
  };
```

ResizeObserver 回调（注释保留）：

```ts
    for (const e of entries) {
      const id = observed.get(e.target);
      if (id === undefined || held(id)) continue;
      const h = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight;
      if (!h) continue;
      next ??= new Map();
      next.set(id, h);
    }
```

`rows` memo 换成 `windowIds`（原有注释保留，最后一句改写）：

```ts
  const windowIds = createMemo<readonly string[]>((prev) => {
    const n = props.items.length;
    if (!n) return stableKeys(prev, []);
    // Pixel window only. A row cap unmounted rows the reader was about to
    // reach, and mounting them again parsed markdown on the scroll frame.
    // The estimate is what keeps this count near the rows actually on screen.
    const { first, last } = mountedRange({
      count: n,
      top: props.top(),
      viewport: props.viewport(),
      overscan: overscan(),
      rowAt: (y) => props.layout.rowAt(y),
    });
    // A position remembered from another session can sit past this one's end.
    // mountedRange clamps that onto the last row, so the pane still has rows
    // to draw. While the same rows are in the window the same list is reused,
    // so a streaming tick or a scroll inside the window leaves the rows alone.
    const ids = props.items.slice(first, last + 1).map((item) => props.id(item));
    return stableKeys(prev, ids);
  });
```

清扫 effect：依赖改为 `windowIds();`，循环改为（删掉 rebind 那段注释与代码，"无测量则主动读一次"的注释保留）：

```ts
      for (const [el, id] of [...observed]) {
        if (!el.isConnected) {
          ro.unobserve(el);
          observed.delete(el);
          continue;
        }
        // (existing comment: a mounted row that has no measurement …)
        if (held(id) || props.layout.isMeasured(id)) continue;
        const h = (el as HTMLElement).offsetHeight;
        if (!h) continue;
        next ??= new Map();
        next.set(id, h);
      }
```

行渲染：

```tsx
      <For each={windowIds()}>
        {(id) => {
          const index = createMemo(() => props.layout.indexOf(id));
          // `For` drops a row in the same update that removed its id, and
          // whatever inside reads the item before then gets the last one it had.
          const item = createMemo<T>((prev) => props.items[index()] ?? prev!);
          // A memo, not the scroll position itself. Markdown subscribes to this,
          // and a subscription to `top` would re-run the paint effect on every
          // pixel. The boolean flips only when the row crosses the fold.
          const inView = createMemo(() => {
            const viewport = props.viewport();
            if (viewport <= 0) return true;
            const top = props.top();
            const y = props.layout.offsets()[index()] ?? 0;
            return y + props.layout.heightOf(index()) > top && y < top + viewport;
          });
          const mode = () => (inView() ? "now" : "idle");
          let rowEl: HTMLDivElement | undefined;
          const paintHold = createPaintHold(() => {
            if (rowEl) queueMeasure(rowEl);
          });
          rowHolds.set(id, paintHold);
          onCleanup(() => {
            if (rowHolds.get(id) === paintHold) rowHolds.delete(id);
          });
          return (
            <rowPaintHold.Provider value={paintHold}>
            <rowPaintMode.Provider value={mode}>
              <div
                class="absolute left-0 right-0"
                ref={(el) => {
                  rowEl = el;
                  observed.set(el, id);
                  ro.observe(el);
                }}
                // (existing `top`-not-`transform` comment)
                style={{ top: `${props.layout.offsets()[index()]}px` }}
              >
                {/* (existing comment, with `props.children(props.items[i], i)` → `props.children(props.items[i])`) */}
                {untrack(() => props.children(item))}
              </div>
            </rowPaintMode.Provider>
            </rowPaintHold.Provider>
          );
        }}
      </For>
```

- [ ] **Step 4: 删 `stableIndexWindow`，`turn-ids` 改用 `stableKeys`**

`virtual-window.ts`：删掉 `stableIndexWindow` 及其 doc 注释。

`turn-ids.ts`：

```ts
import { createMemo } from "solid-js";
import type { Turn } from "./api";
import { stableKeys } from "./keyed";

/** Row ids of any item list, sharing the previous array while nothing in it moved. */
export function createIds<T>(items: () => readonly T[], id: (item: T) => string): () => readonly string[] {
  return createMemo(() => items().map(id), undefined, {
    equals: (previous, next) => stableKeys(previous, next) === previous,
  });
}
```

（`createTurnIds` 保留。）`git rm apps/desktop/ui/src/turn-ids.test.ts`。

- [ ] **Step 5: 测试 + 类型 + lint**

Run: `bun run typecheck && bun run lint && bun run test:ui`
Expected: 全部 PASS。

- [ ] **Step 6: bench（WebKit，A–D 与 S）**

Run:
```bash
cd apps/desktop/ui
bun run bench --engines webkit --flows A,B,C,D --out bench/results/keyed1-wk.json --compare bench/results/blocks2-wk.json
bun run bench --engines webkit --flows S --out bench/results/keyed1-wk-S.json --compare bench/results/final-wk-S.json
```
Expected: `no correctness failures`；指标在噪声内（单步 over50/blockedMs 的明显恶化用 `--reps 5` 复测后再判断）。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/ui/src/virtual.tsx apps/desktop/ui/src/virtual-window.ts apps/desktop/ui/src/virtual-window.test.ts apps/desktop/ui/src/virtual-tail.test.ts apps/desktop/ui/src/turn-ids.ts
git commit -m "refactor(transcript): a row follows its segment, not its slot"
```
（`turn-ids.test.ts` 的删除已在 Step 4 暂存，一起进这个提交。）

---

### Task 2: `TurnBlock` 的 flow 按 row id 复用

**Files:**
- Modify: `apps/desktop/ui/src/transcript.tsx`（`FlowRow`、`runKey`、`TurnBlock` 的 flow 渲染）
- Test: `apps/desktop/ui/src/motion-src.test.ts`

**Interfaces:**
- Consumes: `stableKeys`（`keyed.ts`）。
- Produces: flow row id：消息 `m${i}`，工具组 `run:${firstCallId}`；`ToolRun` 的 `runId` 为 `${turn_id}:${row id}`（Task 4 用它做展开记忆的键）。

- [ ] **Step 1: 改结构测试**

`motion-src.test.ts`：文件头注释与第一个测试替换为：

```ts
/**
 * TurnBlock renders a streaming turn: it is re-evaluated as tokens arrive, and
 * its rows are a `<For>` over the flow's row ids.
 *
 * Every snapshot builds a fresh flow, so a `<For>` over the row objects would
 * tear every row down on every token, and an `<Index>` over them re-used each
 * slot for whatever landed there — a tool call attributed to an earlier
 * message shifted every later slot, rebuilt the messages in them and closed
 * the run that moved. A row id names the same message or run for life: a row
 * that moves is moved, and only a row that is new gets built, so an entrance
 * runs once, when a block first appears.
 */
describe("the transcript's flow is keyed so motion is possible", () => {
  const transcript = () => …; // unchanged

  test("rows are keyed by id, not by object or position", () => {
    const src = transcript();
    expect(src).toContain("<For each={flowIds()}>");
    expect(src).not.toContain("<For each={flow()}>");
    expect(src).not.toContain("<Index each={flow()}>");
  });
```

其余测试不变（ToolRun 内的 `<Index each={props.calls}>` 仍然成立：一个 run 的调用只会追加）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop/ui && bun test src/motion-src.test.ts`
Expected: FAIL（找不到 `<For each={flowIds()}>`）。

- [ ] **Step 3: 改 `transcript.tsx`**

`FlowRow` 拆出两个具名类型：

```ts
type MessageRow = { kind: "message"; id: string; message: AssistantMessageData; index: number };
type ToolsRow = { kind: "tools"; id: string; calls: ToolCallView[] };
type FlowRow = MessageRow | ToolsRow;
```

`runKey` 加前缀（doc 末尾补一句 "Prefixed, so a run's id can never read as a message's."）：

```ts
function runKey(calls: readonly ToolCallView[]): string {
  return `run:${calls[0]?.call_id ?? "empty"}`;
}
```

`import { stableKeys } from "./keyed";`。`TurnBlock` 中 `flow` 之后加：

```ts
  const flowIds = createMemo<readonly string[]>((prev) => stableKeys(prev, flow().map((row) => row.id)));
  const byId = createMemo(() => new Map(flow().map((row) => [row.id, row] as const)));
```

把 `<Index each={flow()}> … </Index>` 整块替换为：

```tsx
      <For each={flowIds()}>
        {(id) => {
          // `For` drops a row in the same update that removed its id, and
          // whatever inside reads the row before then gets the last one it had.
          const row = createMemo<FlowRow>((prev) => byId().get(id) ?? prev!);
          // An id names one kind for life — `m${i}` a message, `run:` a run —
          // so the row picks its component once.
          if (row().kind === "message") {
            const message = () => row() as MessageRow;
            return (
              <AssistantMessage
                turnId={props.turn.turn_id}
                index={message().index}
                message={message().message}
                footer={lastPart() && id === flowIds().at(-1)}
                live={props.live}
                running={props.running}
                onFork={props.onFork}
              />
            );
          }
          const run = () => row() as ToolsRow;
          return (
            <ToolRun
              runId={`${props.turn.turn_id}:${id}`}
              calls={run().calls}
              live={props.live?.()}
              childOf={props.childOf}
              onOpenChild={props.onOpenChild}
            />
          );
        }}
      </For>
```

`runChoice` 上方注释里 "Rows are matched by position, and a run moves" 一段此时已不成立，但 `runChoice` 在 Task 4 才删，这里先不动。确认 `Match`/`Switch`/`Index` 仍被别处使用（`TranscriptBlock`、`BlockText`、`ToolRun`），import 不变。

- [ ] **Step 4: 测试 + 类型 + lint**

Run: `bun run typecheck && bun run lint && bun run test:ui`
Expected: PASS。

- [ ] **Step 5: bench**

Run:
```bash
cd apps/desktop/ui
bun run bench --engines webkit --flows A,B,C,D --out bench/results/keyed2-wk.json --compare bench/results/keyed1-wk.json
bun run bench --engines webkit --flows S --out bench/results/keyed2-wk-S.json --compare bench/results/keyed1-wk-S.json
```
Expected: `no correctness failures`；指标在噪声内。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/ui/src/transcript.tsx apps/desktop/ui/src/motion-src.test.ts
git commit -m "refactor(transcript): a message or run that moves in its turn is moved, not rebuilt"
```

---

### Task 3: 工具调用每个 turn 只归属一次（带回 `e4b72fa`）

**Files:**
- Create: `apps/desktop/ui/src/turn-attribution.ts`、`apps/desktop/ui/src/turn-attribution.test.ts`（从备份分支原样取）
- Modify: `apps/desktop/ui/src/transcript.tsx`（`flow` memo）

**Interfaces:**
- Produces: `attributionOf(turn: Turn): { byMessage: Map<number, ToolCallView[]>; loose: ToolCallView[] }`，按 turn 对象 `WeakMap` 缓存。

- [ ] **Step 1: 取回文件与测试**

```bash
git checkout backup/pre-forcepush-0.22.5 -- apps/desktop/ui/src/turn-attribution.ts apps/desktop/ui/src/turn-attribution.test.ts
```

Run: `cd apps/desktop/ui && bun test src/turn-attribution.test.ts`
Expected: PASS（5 个测试；模块独立，不依赖 `transcript.tsx`）。

- [ ] **Step 2: `flow` 改用它**

`import { attributionOf } from "./turn-attribution";`。`flow` memo 改为：

```ts
  const flow = createMemo(() => {
    const msgs = props.turn.assistant;
    // Attribution is a property of the turn, not of a segment of it: a call's
    // msg_id names an absolute message index. It is built once per turn and
    // shared by the turn's segments, so each one emits only its own slice.
    const { byMessage, loose } = attributionOf(props.turn);
    const rows: FlowRow[] = [];
    const from = props.part?.msgFrom ?? 0;
    const to = props.part?.msgTo ?? msgs.length;
    for (let i = from; i < to; i++) {
      rows.push({ kind: "message", id: `m${i}`, message: msgs[i]!, index: i });
      const mine = byMessage.get(i);
      if (mine?.length) rows.push({ kind: "tools", id: runKey(mine), calls: mine });
    }
    if (loose.length && lastPart()) rows.push({ kind: "tools", id: runKey(loose), calls: loose });
    return rows;
  });
```

- [ ] **Step 3: 测试 + 类型 + lint**

Run: `bun run typecheck && bun run lint && bun run test:ui`
Expected: PASS。

- [ ] **Step 4: bench（关注 D 与 S，长 turn 流式）**

Run:
```bash
cd apps/desktop/ui
bun run bench --engines webkit --flows A,B,C,D --out bench/results/keyed3-wk.json --compare bench/results/keyed2-wk.json
bun run bench --engines webkit --flows S --out bench/results/keyed3-wk-S.json --compare bench/results/keyed2-wk-S.json
```
Expected: 无正确性失败；D/S 的 `blockedMs` 不变或下降。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/ui/src/turn-attribution.ts apps/desktop/ui/src/turn-attribution.test.ts apps/desktop/ui/src/transcript.tsx
git commit -m "perf(transcript): a turn's tool calls are attributed once"
```
提交说明沿用 `e4b72fa` 的正文。

---

### Task 4: 展开选择属于 (pane, session)

**Files:**
- Create: `apps/desktop/ui/src/disclosure.ts`
- Modify: `apps/desktop/ui/src/transcript-layout.ts`（`readDisclosure`）
- Modify: `apps/desktop/ui/src/transcript-view.tsx`（提供 context）
- Modify: `apps/desktop/ui/src/transcript.tsx`（`ThinkingBlock`、`ToolRun`、`ToolCallCard`；删 `thinkingChoice`/`runChoice`）
- Test: `apps/desktop/ui/src/transcript-layout.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Disclosure { get(key: string): boolean | undefined; set(key: string, open: boolean): void }
  export const DisclosureContext: Context<Disclosure>;
  export function useDisclosure(): Disclosure;
  export function readDisclosure(key: string): Map<string, boolean>; // transcript-layout.ts
  ```
- 键：思考块 `thinking:${scope}`；工具组 `${turn_id}:run:${firstCallId}`（Task 2 的 `runId`）；单个调用 `call:${call_id}`。

`ToolCallCard` 的展开状态不在设计文档原列表里，但它是同一类"读者的选择"（滚出窗口再回来会丢），一并纳入，并更新设计文档。

- [ ] **Step 1: 写失败的测试**

`transcript-layout.test.ts` import 增加 `readDisclosure`，并新增：

```ts
describe("a reader's open and closed choices belong to the pane and session", () => {
  test("a choice is kept for the key it was made under, and only there", () => {
    readDisclosure("pane-a:s1").set("run:x", true);
    expect(readDisclosure("pane-a:s1").get("run:x")).toBe(true);
    expect(readDisclosure("pane-b:s1").get("run:x")).toBeUndefined();
    expect(readDisclosure("pane-a:s2").get("run:x")).toBeUndefined();
  });

  test("the transcript hands its blocks the memory for its own key", () => {
    const view = readFileSync(join(import.meta.dir, "transcript-view.tsx"), "utf8");
    expect(view).toContain("<DisclosureContext.Provider value={readDisclosure(key)}>");
    const transcript = readFileSync(join(import.meta.dir, "transcript.tsx"), "utf8");
    // A module map kept every choice for every pane and session, forever.
    expect(transcript).not.toContain("thinkingChoice");
    expect(transcript).not.toContain("runChoice");
    expect(transcript.match(/useDisclosure\(\)/g)?.length).toBe(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop/ui && bun test src/transcript-layout.test.ts`
Expected: FAIL（`readDisclosure` 未导出）。

- [ ] **Step 3: `disclosure.ts`**

```ts
import { createContext, useContext } from "solid-js";

/**
 * The reader's open and closed choices in one transcript — a thought, a tool
 * run, a call's output — by the key each block names itself with.
 *
 * A choice belongs to the conversation it was made in, not to the element
 * that drew it: the window unmounts rows as the reader scrolls, and a choice
 * kept in the component was gone when the row came back. A module map kept
 * it, but for every pane and session at once, for the life of the app.
 */
export interface Disclosure {
  get(key: string): boolean | undefined;
  set(key: string, open: boolean): void;
}

/** Outside a transcript nothing is remembered; the block's own state is all there is. */
const forgetful: Disclosure = { get: () => undefined, set: () => undefined };

export const DisclosureContext = createContext<Disclosure>(forgetful);

export function useDisclosure(): Disclosure {
  return useContext(DisclosureContext);
}
```

- [ ] **Step 4: `transcript-layout.ts`**

在 `readings` 旁边加存储，在 `recallReading` 之后加函数；文件头注释末尾补一句 "The reader's open and closed choices are kept the same way."：

```ts
const disclosures = new Map<string, Map<string, boolean>>();

export function readDisclosure(key: string): Map<string, boolean> {
  let choices = disclosures.get(key);
  if (!choices) {
    choices = new Map();
    disclosures.set(key, choices);
  }
  return choices;
}
```

- [ ] **Step 5: `TranscriptView` 提供 context**

import 增加 `readDisclosure` 和 `import { DisclosureContext } from "./disclosure";`。keyed `<Show>` 的返回值由 `<>…</>` 改为：

```tsx
            <DisclosureContext.Provider value={readDisclosure(key)}>
              <ContentSashes />
              {/* …unchanged children… */}
            </DisclosureContext.Provider>
```

- [ ] **Step 6: 三个组件改用 `useDisclosure()`**

`transcript.tsx`：`import { useDisclosure } from "./disclosure";`；删除 `thinkingChoice`、`runChoice` 及其注释。

`ThinkingBlock`：

```ts
  const disclosure = useDisclosure();
  const key = () => (props.scope === undefined ? undefined : `thinking:${props.scope}`);
  const chosen = () => {
    const k = key();
    return k === undefined ? undefined : disclosure.get(k);
  };
  const [open, setOpen] = createSignal(chosen() ?? readThinkingOpen());
  onMount(() => {
    const onPref = () => {
      if (chosen() !== undefined) return;
      setOpen(readThinkingOpen());
    };
    window.addEventListener("strata-thinking", onPref);
    onCleanup(() => window.removeEventListener("strata-thinking", onPref));
  });
  let blockEl!: HTMLDivElement;
  const toggle = () => {
    const next = !open();
    const k = key();
    if (k !== undefined) disclosure.set(k, next);
    // …rest unchanged
```

`ToolRun`（`runId` doc 改为 "Stable identity of this run, so the reader's choice outlives the row."）：

```ts
  const disclosure = useDisclosure();
  const [open, setOpen] = createSignal(
    (props.runId === undefined ? undefined : disclosure.get(props.runId)) ?? !folded(),
  );
  const toggle = () => {
    const next = !open();
    if (props.runId !== undefined) disclosure.set(props.runId, next);
    setOpen(next);
  };
```

`ToolCallCard`：

```ts
  const disclosure = useDisclosure();
  const choice = () => `call:${props.call.call_id}`;
  const [open, setOpen] = createSignal(disclosure.get(choice()) ?? (running() || props.call.status === "error"));
  createEffect(
    on(
      () => props.call.status,
      (status, prev) => {
        if (status === "error" || (status === "pending" && props.live)) setOpen(true);
        else if (prev === "pending" && status === "ok") setOpen(false);
      },
      // The first state is the signal's own: a choice the reader made, or the default.
      { defer: true },
    ),
  );
```

`ListRow` 的 `onOpen` 改为：

```tsx
          onOpen={() => {
            const next = !open();
            disclosure.set(choice(), next);
            setOpen(next);
          }}
```

- [ ] **Step 7: 测试 + 类型 + lint**

Run: `bun run typecheck && bun run lint && bun run test:ui`
Expected: PASS。

- [ ] **Step 8: bench**

Run:
```bash
cd apps/desktop/ui
bun run bench --engines webkit --flows A,B,C,D --out bench/results/keyed4-wk.json --compare bench/results/keyed3-wk.json
```
Expected: 无正确性失败；指标在噪声内（这一步不应影响性能）。

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/ui/src/disclosure.ts apps/desktop/ui/src/transcript-layout.ts apps/desktop/ui/src/transcript-layout.test.ts apps/desktop/ui/src/transcript-view.tsx apps/desktop/ui/src/transcript.tsx
git commit -m "refactor(transcript): what a reader opened stays open in that pane and session"
```

---

### Task 5: 收尾验证

- [ ] **Step 1: 全量检查**

Run（根目录）：`bun run typecheck && bun run lint && bun run test:ui && bun test packages`
Expected: 全部 PASS。

- [ ] **Step 2: 与第 3 步之后的基线总对比**

Run:
```bash
cd apps/desktop/ui
bun run bench --engines webkit --flows A,B,C,D --compare bench/results/blocks2-wk.json
bun run bench --engines webkit --flows S --compare bench/results/final-wk-S.json
```
Expected: 无正确性失败；记录中位数变化。

- [ ] **Step 3: 更新设计文档**

在设计文档第 1 步末尾补"落地记录"：`renderTurn` 的 index 参数已在 `d4a7024` 去掉；`ToolCallCard` 纳入 disclosure；带回了 `e4b72fa`；`d726cb3` 推迟到第 2 步之前单独评估。

```bash
git add docs/superpowers/specs/2026-11-02-transcript-render-architecture-design.md docs/superpowers/plans/2026-11-02-transcript-identity-keying.md
git commit -m "docs(transcript): step 1 landed"
```

- [ ] **Step 4: 手动检查清单（交给用户在 Tauri 桌面端确认）**

- 流式回复期间工具调用被归属到前面的消息：已展开的工具组保持展开，消息不闪。
- 展开一个思考块/工具组/工具输出，滚出窗口再滚回：仍然展开；切到另一个会话再切回：仍然展开；另一个 pane 打开同一会话：各自独立。
- 发送消息后回显被真实 turn 替换：用户气泡只重挂一次，无跳动。
