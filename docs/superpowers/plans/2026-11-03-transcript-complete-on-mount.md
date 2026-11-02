# 第 2 步：挂载即完整 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 挂载的行总是完整的；延后只发生在"挂不挂这一行"，由 `Virtual` 决定。

**Architecture:** `Virtual` 把窗口分成 `visible`（overscan 0，总是挂载）和 `ahead`（overscan 内的其余行，预热完才挂载）。预热是 `paint-queue` 里的一个任务：调用 `props.warm(item)`，把这一行的 markdown HTML 填进缓存，不碰页面 DOM；完成后这一行进入 `warmed`，窗口重算并挂载它。然后删除行内的延后绘制：`Md`、`Code`、`StructuredAnswer` 首次渲染全部同步，`paint-mode.ts`、`firstPaint`、`prioritize`、`rowHolds`、`queueMeasure`、`inView` 一并删除。

**Tech Stack:** SolidJS 1.x、Bun test（无 DOM：纯函数 + 源码断言）、Playwright bench（WebKit 优先）。

设计文档：`docs/superpowers/specs/2026-11-02-transcript-render-architecture-design.md` 第 2 步。

## Global Constraints

- 检查：`bun run typecheck`、`bun run lint`（警告即失败）、`bun run test:ui`、`bun test packages`。
- WebKit 优先；一次一个变量；bench 退出码 1 一律阻断。
- 这台机器今晚负载均值 10–20，单次 3 轮的结果不可信。判断性能用交替的 5 轮对比（先跑改动版本再跑 HEAD，至少两对），看合并后的中位数。
- 回退阈值（设计文档"验证"节）：`A/open settleMs`、`B/C step-up`、`D/running-wheel-up` 的 `over50` 或 `blockedMs` 合并中位数超过基线一倍，先调大预热范围；仍不行就停下来讨论。
- shell 里不定义和常用命令同名的函数（`head`、`run` 之类）；切换代码版本用 `git stash push -- apps/desktop/ui/src`，在仓库根目录执行。

---

### Task 1: 预热的纯函数部分

**Files:**
- Modify: `apps/desktop/ui/src/virtual-window.ts`（新增 `aheadOrder`）
- Test: `apps/desktop/ui/src/virtual-window.test.ts`
- Modify: `apps/desktop/ui/src/md.tsx`（拆出 `parsed`，新增 `warmMarkdown`）
- Test: `apps/desktop/ui/src/md-cache.test.ts`（源码断言）

**Interfaces:**
- Produces: `aheadOrder(visible: Range, ahead: Range): number[]`，`Range = { first: number; last: number }`：`ahead` 里不在 `visible` 内的下标，离视口近的在前，上下交替。
- Produces: `warmMarkdown(text: string): void`：把 `text` 的每个块解析进 `htmlCache`；已缓存的块跳过；不画图表。

- [ ] **Step 1: 写失败的测试**

```ts
describe("which rows ahead of the view are warmed first", () => {
  test("nearest the view first, alternating above and below", () => {
    expect(aheadOrder({ first: 5, last: 6 }, { first: 2, last: 9 })).toEqual([4, 7, 3, 8, 2, 9]);
  });

  test("an edge of the list leaves one side to run on", () => {
    expect(aheadOrder({ first: 0, last: 1 }, { first: 0, last: 4 })).toEqual([2, 3, 4]);
  });

  test("nothing ahead is nothing to warm", () => {
    expect(aheadOrder({ first: 3, last: 5 }, { first: 3, last: 5 })).toEqual([]);
  });
});
```

`md-cache.test.ts` 新增：

```ts
test("warming parses into the cache and draws nothing", () => {
  const md = readFileSync(join(import.meta.dir, "md.tsx"), "utf8");
  const warm = md.slice(md.indexOf("export function warmMarkdown"));
  expect(warm.slice(0, 600)).toContain("parsed(block, true)");
  expect(warm.slice(0, 600)).not.toContain("drawDiagrams");
});
```

- [ ] **Step 2: 跑测试确认失败**：`cd apps/desktop/ui && bun test src/virtual-window.test.ts src/md-cache.test.ts`

- [ ] **Step 3: 实现**

`virtual-window.ts`：

```ts
export interface Range {
  first: number;
  last: number;
}

/**
 * The rows of `ahead` outside `visible`, nearest the view first, alternating
 * above and below — the order the reader reaches them in either direction.
 */
export function aheadOrder(visible: Range, ahead: Range): number[] {
  const out: number[] = [];
  let up = visible.first - 1;
  let down = visible.last + 1;
  while (up >= ahead.first || down <= ahead.last) {
    if (up >= ahead.first) out.push(up--);
    if (down <= ahead.last) out.push(down++);
  }
  return out;
}
```

`md.tsx`：`nodesFrom` 拆成 `parsed` + 图表：

```ts
function nodesFrom(markdown: string, finished: boolean): DocumentFragment {
  const content = parsed(markdown, finished);
  if (finished) drawDiagrams(content);
  return content;
}

/** Sanitised, highlighted nodes for one block; a finished block goes through the cache. */
function parsed(markdown: string, finished: boolean): DocumentFragment {
  const tpl = document.createElement("template");
  const cached = finished ? htmlCache.get(markdown) : undefined;
  if (cached === undefined) {
    tpl.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string);
    highlightCode(tpl.content);
    if (finished) htmlCache.set(markdown, tpl.innerHTML);
  } else {
    tpl.innerHTML = cached;
  }
  return tpl.content;
}

/**
 * Parse a message into the cache ahead of its row, so the row that mounts
 * later replays HTML instead of parsing it. Nothing is drawn: a diagram is
 * drawn by the block that mounts.
 */
export function warmMarkdown(text: string): void {
  for (const block of splitBlocks(text)) {
    if (htmlCache.get(block) === undefined) parsed(block, true);
  }
}
```

（`nodesFrom` 原有 doc 注释保留在 `nodesFrom` 上，把"replays its sanitised, highlighted HTML from the cache"那句移到 `parsed`。`md-cache.test.ts` 中断言 `finished ? htmlCache.get(markdown) : undefined` 的用例仍然成立。）

- [ ] **Step 4: 检查**：`bun run typecheck && bun run lint && bun run test:ui`

- [ ] **Step 5: Commit**：`refactor(transcript): a message can be parsed into the cache ahead of its row`

---

### Task 2: 窗口层预热

**Files:**
- Modify: `apps/desktop/ui/src/virtual.tsx`
- Modify: `apps/desktop/ui/src/transcript-view.tsx`（提供 `warm`）
- Test: `apps/desktop/ui/src/virtual-window.test.ts`、`apps/desktop/ui/src/virtual-tail.test.ts`

**Interfaces:**
- Consumes: `aheadOrder`、`Range`、`mountedRange`、`warmMarkdown`、`enqueuePaint`（返回 cancel）。
- Produces: `Virtual` 新增可选 prop `warm?: (item: T) => void`。没有 `warm` 时所有 overscan 行照旧立即挂载。

- [ ] **Step 1: 结构测试**

`virtual-window.test.ts` 新增：

```ts
describe("rows ahead of the view mount once they are warm", () => {
  test("the window mounts what is on screen, and what is ahead only once warmed", () => {
    const virtual = readFileSync(join(import.meta.dir, "virtual.tsx"), "utf8");
    expect(virtual).toContain("overscan: 0");
    expect(virtual).toContain("warmed.has(id)");
    expect(virtual).toContain("aheadOrder(");
    const view = readFileSync(join(import.meta.dir, "transcript-view.tsx"), "utf8");
    expect(view).toContain("warm={warmSegment}");
  });
});
```

`virtual-tail.test.ts` 第二组里 `mountedRange({` 仍在 `windowIds` memo 之前被调用（现在在 `ranges` memo 里），把切片起点改为 `const ranges = createMemo`，最后一条断言改为 `expect(call).toBeLessThan(rows.indexOf("stableKeys(prev, ids)"))` 保持不变。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: `Virtual`**

```ts
import { createEffect, createMemo, createSignal, For, onCleanup, untrack, type JSX } from "solid-js";
import { enqueuePaint } from "./paint-queue";
import { aheadOrder, mountedRange, type Range } from "./virtual-window";
```

props 新增：

```ts
  /**
   * Prepare a row before it mounts — parse its markdown into the cache — so a
   * row that comes into the window off screen mounts complete in one go. A row
   * on screen mounts at once, warmed or not. Without it every row mounts at once.
   */
  warm?: (item: T) => void;
```

`windowIds` 之前：

```ts
  const sameRange = (a: Range, b: Range) => a.first === b.first && a.last === b.last;
  /**
   * What is on screen and what is kept ahead of it. Compared by value, so the
   * scroll position only wakes the rows when a row crosses either edge.
   */
  const ranges = createMemo<{ visible: Range; ahead: Range } | undefined>(
    () => {
      const n = props.items.length;
      if (!n) return undefined;
      const at = (overscan: number) =>
        mountedRange({ count: n, top: props.top(), viewport: props.viewport(), overscan, rowAt: (y) => props.layout.rowAt(y) });
      return { visible: at(0), ahead: at(overscan()) };
    },
    undefined,
    { equals: (a, b) => a === b || (!!a && !!b && sameRange(a.visible, b.visible) && sameRange(a.ahead, b.ahead)) },
  );
  /** Ids whose row has been warmed. Bumping `warmth` re-runs the window. */
  const warmed = new Set<string>();
  const [warmth, setWarmth] = createSignal(0);
  const queued = new Map<string, () => void>();
```

`windowIds` 改为：

```ts
  const windowIds = createMemo<readonly string[]>((prev) => {
    warmth();
    const r = ranges();
    if (!r) return stableKeys(prev, []);
    const ids: string[] = [];
    for (let i = r.ahead.first; i <= r.ahead.last; i++) {
      const id = props.id(props.items[i]!);
      const onScreen = i >= r.visible.first && i <= r.visible.last;
      if (onScreen || !props.warm || warmed.has(id)) ids.push(id);
    }
    return stableKeys(prev, ids);
  });
```

（原 `rows` memo 上关于像素窗口和 clamp 的注释移到 `ranges` 上。）

预热调度 effect：

```ts
  // Rows ahead of the view are warmed nearest first, a budget per frame, and
  // mount as each finishes. A row that left the range before its turn is
  // dropped from the queue, so a fast fling does not leave a trail of parses.
  createEffect(() => {
    const warm = props.warm;
    const r = ranges();
    if (!warm || !r) return;
    const want = new Set<string>();
    for (const i of aheadOrder(r.visible, r.ahead)) {
      const id = props.id(props.items[i]!);
      if (warmed.has(id)) continue;
      want.add(id);
      if (queued.has(id)) continue;
      queued.set(
        id,
        enqueuePaint(() => {
          queued.delete(id);
          const item = untrack(() => props.items[props.layout.indexOf(id)]);
          if (item !== undefined) warm(item);
          warmed.add(id);
          setWarmth((n) => n + 1);
        }),
      );
    }
    for (const [id, cancel] of queued) {
      if (want.has(id)) continue;
      cancel();
      queued.delete(id);
    }
  });
```

`onCleanup` 里补上 `for (const cancel of queued.values()) cancel(); queued.clear();`。

- [ ] **Step 4: `TranscriptView` 的 `warmSegment`**

```ts
import { warmMarkdown } from "./md";
import { readThinkingOpen } from "./thinking";
```

在 keyed `<Show>` 里：

```ts
          /**
           * The markdown a segment will draw, parsed ahead of it. A reply
           * still being written is skipped — it mounts on screen and is new
           * on every token — and a thought only when thoughts open by default.
           */
          const warmSegment = (seg: TurnSegment) => {
            const thoughts = readThinkingOpen();
            const text = (blocks: readonly ContentBlock[] | undefined) => {
              for (const b of blocks ?? []) {
                if (b.type === "text" || (thoughts && b.type === "thinking")) warmMarkdown(b.text);
              }
            };
            if (seg.part === 0) text(seg.turn.user);
            for (let i = seg.msgFrom; i < seg.msgTo; i++) {
              const m = seg.turn.assistant[i];
              if (m && !m.partial) text(m.content);
            }
          };
```

`<Virtual ... warm={warmSegment}>`；`import type { ContentBlock, Turn } from "./api";`。

- [ ] **Step 5: 检查**：`bun run typecheck && bun run lint && bun run test:ui`

- [ ] **Step 6: bench**：`--flows A,B,C,D` 3 轮对比 `bench/results/est2-wk.json`（第 2 步前的 HEAD）看正确性；`A`、`D` 各交替 5 轮两对，看 `A/open`、`A/step-up`、`A/wheel-up`、`D/running-wheel-up`。

- [ ] **Step 7: Commit**：`perf(transcript): a row ahead of the view mounts once its markdown is warm`

---

### Task 3: 删掉行内的延后绘制

**Files:**
- Modify: `apps/desktop/ui/src/md.tsx`、`apps/desktop/ui/src/payload.tsx`、`apps/desktop/ui/src/transcript.tsx`（`StructuredAnswer`）
- Modify: `apps/desktop/ui/src/virtual.tsx`（删 holds、providers、`inView`、`queueMeasure`）
- Modify: `apps/desktop/ui/src/paint-queue.ts`（删 `firstPaint`、`prioritize`、`PaintCancel`）
- Delete: `apps/desktop/ui/src/paint-mode.ts`、`apps/desktop/ui/src/paint-mode.test.ts`
- Test: `apps/desktop/ui/src/paint-queue.test.ts`、`apps/desktop/ui/src/virtual-window.test.ts`

- [ ] **Step 1: 测试改为新不变式**

`virtual-window.test.ts` 的 "off-screen transcript rows wait for a later frame" 整块替换为：

```ts
describe("a mounted row is complete", () => {
  test("nothing inside a row waits for a later frame to draw", () => {
    for (const file of ["md.tsx", "payload.tsx", "transcript.tsx", "virtual.tsx"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).not.toContain("paint-mode");
      expect(src).not.toContain("useRowPaintMode");
    }
    const md = readFileSync(join(import.meta.dir, "md.tsx"), "utf8");
    expect(md).not.toContain("enqueuePaint");
    expect(md).not.toContain("firstPaint");
  });
});
```

`paint-queue.test.ts`：删掉 "a row that scrolled into view paints before the ones still waiting" 和 `describe("which frame a row's first paint belongs to")`；其余（预算、至少一个、取消）保留。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: `Md` 同步首帧**

删 `mode`、`paintHold`、`cancelIdle`、`releaseHold`、`release`、`started` 和 `firstPaint`/`enqueuePaint`/`paint-mode` import。

```ts
  const [shown, setShown] = createSignal<Painted>(current(), { equals: samePaint });
  /**
   * The first text renders with the row. Later text waits for the frame, so a
   * burst of tokens costs one paint rather than one each, and the frame reads
   * whatever is current rather than what was queued.
   */
  createEffect(
    on(
      () => [props.text, props.live],
      () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          setShown(current());
        });
      },
      { defer: true },
    ),
  );
  const live = () => shown().live;
  const blocks = createMemo(() => splitBlocks(shown().text));
```

（`current` 要定义在 `createSignal` 之前；`onCleanup` 只剩 `cancelAnimationFrame`。）

- [ ] **Step 4: `Code` 与 `StructuredAnswer` 同步**

`payload.tsx`：删 `mode`/`paintHold`/`shown`/effect 与两条 import，`tokens` memo 去掉 `if (!shown()) return [];`，删掉函数开头"Highlighting runs when the row is on screen…"注释。

`transcript.tsx`：

```tsx
/** The object the caller asked for with json_schema, drawn as the answer. */
function StructuredAnswer(props: { value: unknown }) {
  return <Code source={JSON.stringify(props.value, null, 2)} class="my-2" />;
}
```

删 `enqueuePaint`、`paint-mode` 两条 import。

- [ ] **Step 5: `Virtual` 去掉 holds**

删 `rowHolds`、`held`、`pendingEls`、`flushQueued`、`queueMeasure`、行内 `inView`/`mode`/`rowEl`/`paintHold` 与两个 Provider、`createPaintHold` import。RO 回调与清扫里的 `held(id)` 条件去掉。行渲染变为：

```tsx
        {(id) => {
          const index = createMemo(() => props.layout.indexOf(id));
          // (existing comment)
          const item = createMemo<T>((prev) => props.items[index()] ?? prev!);
          return (
            <div
              class="absolute left-0 right-0"
              ref={(el) => {
                observed.set(el, id);
                ro.observe(el);
              }}
              // (existing `top` comment)
              style={{ top: `${props.layout.offsets()[index()]}px` }}
            >
              {/* (existing comment, minus "and it still runs under the provider…") */}
              {untrack(() => props.children(item))}
            </div>
          );
        }}
```

- [ ] **Step 6: `paint-queue.ts`**

删 `firstPaint`、`PaintCancel`、`prioritize`；`enqueue` 返回 `() => void`。文件头注释改为说明它只做预热："Spread warming across frames …"；`enqueuePaint` 改名 `enqueueWarm`，`virtual.tsx` 同步。`git rm apps/desktop/ui/src/paint-mode.ts apps/desktop/ui/src/paint-mode.test.ts`。

- [ ] **Step 7: 检查**：`bun run typecheck && bun run lint && bun run test:ui`

- [ ] **Step 8: bench**：同 Task 2 Step 6，基线换成 Task 2 的提交；对照回退阈值。

- [ ] **Step 9: Commit**：`refactor(transcript): a row that mounts is drawn whole`

---

### Task 4: 收尾

- [ ] 全量检查（含 `bun test packages`）。
- [ ] 总对比：A–D 对 `est2-wk.json`，A/D 交替 5 轮；S 5 轮。
- [ ] 设计文档第 2 步补落地记录；提交 `docs(transcript): step 2 landed`。
