# Transcript 渲染：流式 bench + Markdown 块化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让流式回复每帧只解析正在写的最后一块，并用新 bench 流程 S 证明。

**Architecture:** `splitBlocks` 用 `marked.lexer` 把消息切成顶层块（纯函数）；`Md` 以块源码为键 `<For>` 渲染已完成的块（HTML 按块缓存），正在写的最后一块经 `reconcileList` 原地修补。首帧调度（`firstPaint` / `enqueuePaint` / paint hold）本计划不动，留给 spec 第 2 步。

**Tech Stack:** SolidJS 1.9、marked 16、DOMPurify、bun test、Playwright bench。

Spec：`docs/superpowers/specs/2026-11-02-transcript-render-architecture-design.md`

## Global Constraints

- 每个任务结束跑：`bun run typecheck`、`bun run lint`（warning 也失败）、`bun run test:ui`；涉及 packages 时 `bun test packages`。
- 性能判断以 WebKit 为准：`cd apps/desktop/ui && bun run bench --engines webkit ...`；bench 退出码 1 是正确性失败，一律阻断。
- 块节点直接插入 `.md`，不加包装元素（`theme.css` 依赖 `.md > :first-child`）。
- 代码注释只写代码本身表达不了的约束，风格与周边一致（英文、完整句子）。
- 提交信息沿用仓库风格：`perf(transcript): …` / `test(bench): …`。

---

### Task 1: bench 流程 S（流式长回复）与基线

**Files:**
- Modify: `apps/desktop/ui/bench/scenarios.ts`（新增 `longReply`、`streamReply`、`streamingReply`、`replyDone`、`flowS`，注册到 `FLOWS`）
- Modify: `apps/desktop/ui/bench/run.ts:175-178`（`busy` 包含 S 的长会话）
- Modify: `AGENTS.md`（Transcript bench 一节加一行 `--flows S`）

**Interfaces:**
- Produces: `FLOWS.S`；步骤名 `S/open`、`S/stream-reply`、`S/reply-done`。

- [ ] **Step 1:** 在 `scenarios.ts` 的 `runningWheelUp` 之后加入：

```ts
/**
 * A reply the way a model writes one: headings, mixed-language prose, lists,
 * several code blocks, a table and a quote, about 10KB. D's snapshot is one
 * line of plain words and never reaches the markdown parser's real cost.
 */
export function longReply(): string {
  const sections: string[] = [];
  for (let i = 0; i < 6; i++) {
    sections.push(
      [
        `## 第 ${i + 1} 节：render pipeline step ${i + 1}`,
        `这一节说明第 ${i + 1} 步在做什么。The renderer reads the source once per frame, keeps the blocks that have already closed, and only parses the part that can still change. 如果某一块已经结束，它的节点就不应该再被替换；selection、图片和滚动锚点都依赖这一点。`,
        `- 第一项：\`stableKeys\` 在键不变时返回原数组`,
        `- 第二项：**已完成的块**按源码缓存 HTML`,
        `- 第三项：[参考链接](https://example.com/${i}) 和行内 \`code\``,
        "```ts",
        ...Array.from({ length: 16 }, (_, k) => `const value${k} = compute(${i}, ${k}); // step ${k} of section ${i}`),
        "```",
        `| 指标 | 之前 | 之后 |`,
        `| --- | --- | --- |`,
        `| maxGap | ${40 + i} | ${20 + i} |`,
        `| blockedMs | ${30 + i} | ${10 + i} |`,
        `> 第 ${i + 1} 节结束。A quote closes the section so the next heading starts a new block.`,
      ].join("\n\n"),
    );
  }
  return sections.join("\n\n");
}

/** Stream `text` into the latest turn, `chunk` characters every 50ms, as whole-message snapshots. */
function streamReply(ctx: FlowContext, id: string, text: string, chunk: number): Promise<number> {
  const turnId = orderOf(ctx, id).at(-1)!;
  let sent = 0;
  let count = 0;
  return new Promise((resolve) => {
    const write = () => {
      sent = Math.min(text.length, sent + chunk);
      count += 1;
      ctx.emit({
        session_id: id,
        type: "turn.assistant",
        data: {
          turn_id: turnId,
          msg_id: "bench-reply",
          partial: true,
          content: [{ type: "text", text: text.slice(0, sent) }],
        },
      });
      if (sent >= text.length) {
        clearInterval(timer);
        resolve(count);
      }
    };
    const timer = setInterval(write, 50);
    write();
  });
}

export async function streamingReply(ctx: FlowContext, name: string, id: string): Promise<StepResult> {
  const b = bench(ctx.page);
  const t0 = await b.now();
  const partials = await streamReply(ctx, id, longReply(), 64);
  await ctx.page.waitForTimeout(200);
  const t1 = await b.now();
  const rec = await b.take(t0);
  const atTail = openStats(rec.samples, orderOf(ctx, id), t0, t1).atTail;
  return runningResult(ctx, name, rec, t0, t1, partials, { atTail });
}

/** The reply finishes: the last block stops being the tail and is drawn as a finished block. */
export async function replyDone(ctx: FlowContext, name: string, id: string): Promise<StepResult> {
  const b = bench(ctx.page);
  const turnId = orderOf(ctx, id).at(-1)!;
  const t0 = await b.now();
  ctx.emit({
    session_id: id,
    type: "turn.assistant",
    data: {
      turn_id: turnId,
      msg_id: "bench-reply",
      partial: false,
      content: [{ type: "text", text: longReply() }],
    },
  });
  const r = await b.settle(t0, 400, 8_000);
  const rec = await b.take(t0);
  return finish(ctx, name, common(rec, t0, r.at, r), []);
}
```

- [ ] **Step 2:** 在 `flowD` 之后加入，并把 `S: flowS` 加进 `FLOWS`：

```ts
/** S: a long reply streams into the session the reader is following, then finishes. */
export const flowS: Flow = async (ctx, s, record) => {
  record(await openCold(ctx, "open", s.long));
  record(await streamingReply(ctx, "stream-reply", s.long));
  record(await replyDone(ctx, "reply-done", s.long));
};
```

- [ ] **Step 3:** `run.ts` 的 `busy` 改为 D 或 S 任一出现都把长会话标为 busy：

```ts
    busy: [
      ...(opt.flows.includes("D") || opt.flows.includes("S") ? [(real ? opt.long! : FIXTURE_SESSIONS.long)] : []),
      ...(opt.flows.includes("F") && small[3] ? [small[3]] : []),
    ],
```

- [ ] **Step 4:** `bun run typecheck && bun run lint`，期望通过。
- [ ] **Step 5:** 在 `77fdabd` 的 UI 代码上测 S 基线（bench 改动不影响 UI 构建）：`cd apps/desktop/ui && bun run bench --engines webkit --flows S --out bench/results/baseline-77fdabd-wk-S.json`。期望：无正确性失败，`S/stream-reply` 的 `partials` ≈ 160。
- [ ] **Step 6:** `AGENTS.md` 的 bench 列表加：`` - `--flows S` — a ~10KB markdown reply streams into the followed tail (64 chars / 50ms), then finishes: what the markdown parser costs per frame. ``
- [ ] **Step 7:** 提交 `test(bench): a long markdown reply streams into the tail`。

### Task 2: `keyed.ts` 与 `md-blocks.ts`（纯函数）

**Files:**
- Create: `apps/desktop/ui/src/keyed.ts`、`apps/desktop/ui/src/keyed.test.ts`
- Create: `apps/desktop/ui/src/md-blocks.ts`、`apps/desktop/ui/src/md-blocks.test.ts`

**Interfaces:**
- Produces: `stableKeys(prev: readonly string[] | undefined, next: readonly string[]): readonly string[]`；`splitBlocks(source: string): string[]`

- [ ] **Step 1: 失败测试 `keyed.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { stableKeys } from "./keyed";

describe("stableKeys", () => {
  test("the same keys hand back the previous array", () => {
    const prev = ["a", "b"];
    expect(stableKeys(prev, ["a", "b"])).toBe(prev);
  });
  test("a changed, added or missing key is a new array", () => {
    const prev = ["a", "b"];
    const next = ["a", "c"];
    expect(stableKeys(prev, next)).toBe(next);
    expect(stableKeys(prev, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(stableKeys(prev, ["a"])).toEqual(["a"]);
  });
  test("nothing before is a new array", () => {
    const next = ["a"];
    expect(stableKeys(undefined, next)).toBe(next);
  });
});
```

- [ ] **Step 2: 失败测试 `md-blocks.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { splitBlocks } from "./md-blocks";

describe("splitBlocks", () => {
  test("an empty message has no blocks", () => {
    expect(splitBlocks("")).toEqual([]);
  });
  test("prose is cut at paragraphs, and a growing paragraph leaves the ones before it alone", () => {
    expect(splitBlocks("这是第一段。\n\n这是第二")).toEqual(["这是第一段。", "这是第二"]);
    expect(splitBlocks("这是第一段。\n\n这是第二段")[0]).toBe("这是第一段。");
  });
  test("a fence still being written is the last block", () => {
    const blocks = splitBlocks("Para\n\n```ts\nconst a");
    expect(blocks).toEqual(["Para", "```ts\nconst a"]);
  });
  test("a closed fence, a list and a setext heading are blocks of their own", () => {
    const blocks = splitBlocks("Para\n\n```ts\nconst a = 1\n```\n\n- a\n- b\n\nTitle\n===\n");
    expect(blocks).toHaveLength(4);
    expect(blocks[1]).toBe("```ts\nconst a = 1\n```");
    expect(blocks[3]).toBe("Title\n===\n");
  });
  test("reference definitions travel with every block, so a block parsed alone still links", () => {
    const blocks = splitBlocks("see [x][r]\n\n[r]: http://e.com\n\nnext");
    expect(blocks).toEqual(["see [x][r]\n\n[r]: http://e.com", "next\n\n[r]: http://e.com"]);
  });
  test("the same block twice is two blocks", () => {
    expect(splitBlocks("ok\n\n---\n\nok")).toHaveLength(3);
  });
});
```

- [ ] **Step 3:** `bun test apps/desktop/ui/src/keyed.test.ts apps/desktop/ui/src/md-blocks.test.ts`，期望 FAIL（模块不存在）。
- [ ] **Step 4: 实现 `keyed.ts`**

```ts
/**
 * The previous array when `next` holds the same keys in the same order.
 *
 * A `<For>` handed a fresh array of the same strings still walks every entry,
 * and every memo that reads the list wakes for nothing.
 */
export function stableKeys(prev: readonly string[] | undefined, next: readonly string[]): readonly string[] {
  if (prev && prev.length === next.length && prev.every((key, i) => key === next[i])) return prev;
  return next;
}
```

- [ ] **Step 5: 实现 `md-blocks.ts`**

```ts
import { marked } from "marked";

/**
 * A message as the top-level blocks it renders to, each as the source that
 * renders it on its own.
 *
 * The source is the block's identity: while a reply streams, every block but
 * the last comes back byte-identical, so its nodes and its cached HTML stay.
 * A block is parsed alone, which loses reference definitions written elsewhere
 * in the message — so when the message has any, every block carries them.
 */
export function splitBlocks(source: string): string[] {
  if (!source) return [];
  const tokens = marked.lexer(source);
  const defs = tokens
    .filter((t) => t.type === "def")
    .map((t) => t.raw.trim())
    .join("\n");
  const blocks: string[] = [];
  for (const t of tokens) {
    if (t.type === "space" || t.type === "def") continue;
    blocks.push(defs ? `${t.raw.trimEnd()}\n\n${defs}` : t.raw);
  }
  return blocks;
}
```

- [ ] **Step 6:** 再跑 Step 3 的命令，期望 PASS。
- [ ] **Step 7:** 不单独提交，和 Task 3、4 一起作为一个可回滚的提交。

### Task 3: `reconcileList`

**Files:**
- Modify: `apps/desktop/ui/src/md-reconcile.ts:87-106`（`reconcileChildren` 替换为 `reconcileList`）
- Modify: `apps/desktop/ui/src/md-reconcile.test.ts`

**Interfaces:**
- Produces: `reconcileList(current: readonly Node[], incoming: readonly Node[]): Node[]`

- [ ] **Step 1:** 测试改为基于 `reconcileList`：`run(existing, incoming)` 返回挂上结果列表的 host；“a growing reply reuses the text node” 改为循环中 `list = reconcileList(list, [para(s)])`；删除 “the tail starts after the finished region”（已完成区域不再归这个函数管），新增 “nothing is moved by the patch itself”：

```ts
const run = (existing: FakeNode[], incoming: FakeNode[]): FakeNode => {
  const list = reconcileList(existing as unknown as Node[], incoming as unknown as Node[]) as unknown as FakeNode[];
  const host = new FakeNode(ELEMENT, "DIV");
  for (const c of list) host.appendChild(c);
  return host;
};

  test("a growing reply reuses the text node on every step", () => {
    let list: Node[] = [];
    const seen: FakeNode[] = [];
    for (const s of ["这", "这是", "这是一个", "这是一个回复"]) {
      list = reconcileList(list, [para(s)] as unknown as Node[]);
      seen.push((list[0] as unknown as FakeNode).childNodes[0]!);
    }
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]!.nodeValue).toBe("这是一个回复");
  });

  test("the list is returned, not written: the nodes on screen stay where they are", () => {
    const host = new FakeNode(ELEMENT, "DIV");
    const before = host.appendChild(para("一"));
    reconcileList([before] as unknown as Node[], [para("一二")] as unknown as Node[]);
    expect(host.childNodes).toEqual([before]);
    expect(before.childNodes[0]!.nodeValue).toBe("一二");
  });
```

- [ ] **Step 2:** `bun test apps/desktop/ui/src/md-reconcile.test.ts`，期望 FAIL（`reconcileList` 不存在）。
- [ ] **Step 3:** 用下面的实现替换 `reconcileChildren`：

```ts
/**
 * The nodes to show for `incoming`, reusing `current` where it can.
 *
 * Used for the block a reply is still writing, which is re-parsed on every
 * token. Nodes are patched in order until one cannot be; that one and every
 * incoming node after it are taken as they are, because a structural change
 * early on can change what the rest of the block means. The caller puts the
 * list on screen — nothing here moves a node.
 */
export function reconcileList(current: readonly Node[], incoming: readonly Node[]): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < current.length && i < incoming.length && patchNode(current[i]!, incoming[i]!)) {
    out.push(current[i]!);
    i += 1;
  }
  for (let j = i; j < incoming.length; j += 1) out.push(incoming[j]!);
  return out;
}
```

- [ ] **Step 4:** 再跑测试，期望 PASS。

### Task 4: `Md` 改为块化渲染

**Files:**
- Modify: `apps/desktop/ui/src/md.tsx`（整体改写 `Md` 与 `paint`；`syncCursor` → `withCaret`；`nodesFrom` 去掉 `useCache` 参数，按 `finished` 决定是否走缓存）
- Modify: `apps/desktop/ui/src/md-cache.ts:14`（`maxEntries` 默认 4000 → 50_000）
- Delete: `apps/desktop/ui/src/md-stream.ts`、`apps/desktop/ui/src/md-stream.test.ts`
- Modify: `apps/desktop/ui/src/mermaid.ts:42`（注释里的 `stableBoundary` 改为“the block is finished”）
- Modify（源码断言）: `md-cache.test.ts:57-63`、`mermaid.test.ts:15-21`、`transcript-format.test.ts:466-471`

**Interfaces:**
- Consumes: `splitBlocks`、`stableKeys`、`reconcileList`
- Produces: `Md` 的 props 不变：`{ text: string; class?: string; live?: boolean }`

- [ ] **Step 1:** 改源码断言为新的不变式：
  - `md-cache.test.ts`：`expect(src).toContain("finished ? htmlCache.get(markdown) : undefined")`、`expect(src).toContain("blockNodes(source, true)")`、`expect(src).toContain("blockNodes(last, false)")`，保留 `drawDiagrams` 在 `htmlCache.set` 之后。
  - `mermaid.test.ts`：`expect(src).toContain("if (finished) drawDiagrams(tpl.content)")`、`expect(src).toMatch(/blockNodes\(last, false\)/)`；注释改为“only a finished block is asked to draw”。
  - `transcript-format.test.ts`：`expect(markdown).toContain("withCaret(blockNodes(last, false))")`、`expect(markdown).toContain("target.append(caret)")`。
- [ ] **Step 2:** `bun run test:ui`，期望这三处 FAIL。
- [ ] **Step 3:** 改写 `md.tsx` 的 `Md`：

```tsx
type Painted = { text: string; live: boolean };

const samePaint = (a: Painted | undefined, b: Painted | undefined) =>
  a?.text === b?.text && a?.live === b?.live;

export function Md(props: { text: string; class?: string; live?: boolean }) {
  let frame = 0;
  let started = false;
  const mode = useRowPaintMode();
  const paintHold = useRowPaintHold();
  let cancelIdle: PaintCancel | undefined;
  let releaseHold: (() => void) | undefined;
  const release = () => {
    releaseHold?.();
    releaseHold = undefined;
  };
  /**
   * The text on screen and whether it was still being written. A frame that
   * resolves to the same pair is not a change: the view refreshes faster than
   * a reply grows, and nothing downstream should wake for it.
   */
  const [shown, setShown] = createSignal<Painted | undefined>(undefined, { equals: samePaint });
  const current = (): Painted => ({ text: props.text, live: props.live === true });

  /* …首帧调度注释与逻辑保持原样，把 paint(...) 换成 setShown(current())… */

  const live = () => shown()?.live === true;
  const blocks = createMemo(() => splitBlocks(shown()?.text ?? ""));
  /** Every block but the one still being written. Each renders once, by its source. */
  const settled = createMemo<readonly string[]>((prev) =>
    stableKeys(prev, live() ? blocks().slice(0, -1) : blocks()),
  );
  /**
   * The block a reply is still writing, patched into the nodes it had a frame
   * ago — a paragraph that grew keeps its node and its text node, so nothing
   * blinks, a selection holds and an image does not reload.
   */
  const tail = createMemo<Node[]>((prev) => {
    const last = live() ? blocks().at(-1) : undefined;
    if (last === undefined) return [];
    return reconcileList(prev, withCaret(blockNodes(last, false)));
  }, []);

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame);
    cancelIdle?.();
    cancelIdle = undefined;
    release();
  });

  return (
    <div class={`md ${props.class ?? ""}`} onClick={/* 原样 */}>
      <For each={settled()}>{(source) => blockNodes(source, true)}</For>
      {tail()}
    </div>
  );
}

function blockNodes(source: string, finished: boolean): Node[] {
  return [...nodesFrom(source, finished).childNodes];
}

/** The streaming caret, placed at the end of the text the last block ends with. */
function withCaret(nodes: Node[]): Node[] {
  const last = nodes.findLast((n): n is Element => n.nodeType === 1);
  const target = last ? cursorTarget(last) : undefined;
  if (!target) return nodes;
  const caret = document.createElement("span");
  caret.className = "streaming-caret ml-0.5 inline-block h-[1em] w-[2px] translate-y-0.5 motion-safe:animate-pulse bg-foreground/70 align-text-bottom";
  caret.setAttribute("aria-hidden", "true");
  target.append(caret);
  return nodes;
}
```

  `nodesFrom(markdown, finished)`：`const cached = finished ? htmlCache.get(markdown) : undefined;`，写缓存条件同为 `finished`。删除 `renderedStable`、`stableCount`、`lastSource`、`lastLive`、`host` 与 `syncCursor`，删除 `stableBoundary`、`reconcileChildren` 的导入。
- [ ] **Step 4:** `md-cache.ts` 的 `maxEntries` 默认值改为 `50_000`，并在类注释补一句：entries are blocks now, so the count cap sits far above the cost cap and the cost cap decides。
- [ ] **Step 5:** 删除 `md-stream.ts` 与 `md-stream.test.ts`；`rg "md-stream|stableBoundary" apps/desktop/ui` 期望只剩 `mermaid.ts` 注释，改掉。
- [ ] **Step 6:** `bun run typecheck && bun run lint && bun run test:ui`，期望全绿。
- [ ] **Step 7:** 构建并在浏览器里人工确认：`cd apps/desktop/ui && bun run bench --engines webkit --flows S --reps 1 --headed`，观察流式时段落不闪、光标在行尾、代码块写完后高亮正确、表格与引用正常。

### Task 5: 验证与提交

- [ ] **Step 1:** `cd apps/desktop/ui && bun run bench --engines webkit --flows S --compare bench/results/baseline-77fdabd-wk-S.json`。期望：无正确性失败；`S/stream-reply` 的 `blockedMs`、`longtaskMs`、`over50` 低于基线。
- [ ] **Step 2:** `bun run bench --engines webkit --flows A,B,C,D --compare bench/results/baseline-77fdabd-wk.json`。期望：无正确性失败；A/B 的 open、step-up 无明显恶化（缓存按块后首次解析次数变多，需要确认）。
- [ ] **Step 3:** `bun test packages`、`cd apps/desktop/src-tauri && cargo test --locked`（未改 Rust，确认环境完整即可）。
- [ ] **Step 4:** 提交 `perf(transcript): a streaming reply parses only the block it is still writing`，提交说明写明 S 流程前后数字。
