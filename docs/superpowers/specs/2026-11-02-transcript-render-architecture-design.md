# 会话内容渲染架构：身份、时间与 Markdown

日期：2026-11-02　基线：`77fdabd`（0.22.7）　范围：`apps/desktop/ui/src` 的 transcript 渲染链

## 问题

最近几轮 transcript 修复（`b510abd`、`3cc132b`、`4ab8c19`、`d18451c`）都在补同一类症状：行跳一下、展开状态丢一次、流式回复闪。逐个修补之后，症状换了个地方再出现。代码里能找到三个结构性原因。

### 1. 一行的内容高度随时间变化

`paint-queue` + `paint-mode` + `paint-hold` 让一个已经挂载、已经定位的行先以空壳出现，过若干帧再填内容（`Md`、`payload.tsx` 的 `Code`、`StructuredAnswer`）。为此 `virtual.tsx` 维护 `rowHolds`（未画完不提交测量）、`queueMeasure`（画完补测）、`inView`（决定当帧画不画）。`b510abd` 之后，滚进视口的未画行要等下一帧：视口里出现一帧空白和估算高度，随后测量落地、`absorb` 补偿，读者看到的就是跳动。

### 2. 组件按位置复用，数据按身份移动

- `Virtual` 的 `<For each={rows()}>` 以数字下标为键。`ECHO_TURN_ID` 被真实 turn 替换时，同一下标的 DOM 换了主人，所以才有 rebind sweep。
- `TurnBlock` 的 `<Index each={flow()}>` + `<Switch>` 按位置复用。工具调用被归属到前面的消息时，后续位置整体错位，消息组件被销毁重建（Markdown 重解析），工具组展开状态丢失。
- 模块级 `runChoice` / `thinkingChoice` 是这个问题的补丁：跨会话共享、只增不减。

### 3. `md.tsx` 一个 effect 里做四件事

解析（marked、DOMPurify、高亮、缓存）、流式 stable/tail 增量修补、调度（rAF、队列、hold、可见性）、光标与图表。`stableBoundary` 只在闭合 fence 处切，普通散文的 stable 区永远为空，整条回复每帧都是 tail。

### 不是问题的部分

`row-layout`（行高与前缀和唯一来源）和 `scroll-owner`（`scrollTop` 唯一写入者）已经是单一所有者；`virtual-window`、`virtual-tail`、`turn-segments`、`scroll-defer`、`md-reconcile`、`md-stream` 是纯函数且有测试。本次不合并滚动与布局模块。

## 目标与不变式

1. **挂载的行总是完整的。**行内不存在"已挂载但未绘制"的状态。延后只发生在"挂不挂这一行"的层面，由 `Virtual` 决定。
2. **组件生命周期跟随数据身份。**行按 segment id、turn 内的块按 flow row id、Markdown 块按块键复用；位置变化只移动节点，不重建组件。
3. **读者的展开选择属于会话，不属于组件或模块。**按 (pane, session) 记忆，和行高、阅读位置同一套机制。
4. **Markdown 渲染是"源码 → 带键的块 → 节点"。**只有正在写的最后一块会被原地修补；其余块按键复用，HTML 按块缓存。

非目标：改滚动锚定算法；改虚拟窗口的像素预算；改外观。

## 设计

### 第 1 步：按身份做键

**`keyed.ts`（新，纯函数）**

```ts
/** Same array back when the keys did not change, so a `<For>` over it stays quiet. */
export function stableKeys(prev: readonly string[] | undefined, next: readonly string[]): readonly string[];
```

**`Virtual`**

- 窗口改为 id 列表：`mountedRange` 算出 `[first, last]` 后取 `items[first..last]` 的 id，经 `stableKeys` 复用上一次数组；`<For each={windowIds()}>` 以 id 字符串为键。
- 行内：`index = () => layout.indexOf(id)`，`item = () => items[index()]`，`top = offsets()[index()]`。
- `observed` 改为 `Map<Element, string>`，元素在生命周期内只对应一个 id；删除 rebind 逻辑。保留"已挂载但无测量则主动读一次"的兜底。
- id 离开 `items` 时 `<For>` 移除该行，新 id 挂新行。`ECHO_TURN_ID` → 真实 turn 因此会重挂一次用户行，这是正确行为。

**`TurnBlock`**

- `flow()` 照旧算出行数组，另派生 `flowIds = stableKeys(prev, rows.map(r => r.id))` 和 `byId: Map<string, FlowRow>`。
- `<For each={flowIds()}>`，每行 `row = () => byId().get(id)`。一个 id 的 kind 固定（`m${i}` 永远是消息，`runKey` 永远是工具组），所以每行内直接选择 `AssistantMessage` 或 `ToolRun`，不再用 `<Switch>` 按位置切换。
- `footer` 改为 `id === flowIds().at(-1)`。

**`disclosure.ts`（新）**

```ts
export interface Disclosure {
  get(key: string): boolean | undefined;
  set(key: string, open: boolean): void;
}
export const DisclosureContext: Context<Disclosure>; // 默认值：组件内私有、不持久
export function useDisclosure(): Disclosure;
```

- 记忆放在 `transcript-layout.ts`，与 `readRowHeights` / `recallReading` 同构：`readDisclosure(key): Map<string, boolean>`，按 `layoutKey(pane, session)` 存。
- `TranscriptView` 在 keyed `<Show>` 内提供 `DisclosureContext`。
- `ThinkingBlock` 和 `ToolRun` 改用 `useDisclosure()`，删除 `thinkingChoice` / `runChoice`。`strata-thinking` 偏好事件仍只影响没有显式选择的块。

**`renderTurn`**：去掉没人用的 `index` 参数。

### 第 2 步：把时间从视图里拿掉

**不变式落地**：挂载即完整绘制。`Md`、`Code`、`StructuredAnswer` 首次渲染全部同步；删除 `paint-mode.ts`、`firstPaint`、`rowHolds`、`queueMeasure`、`inView` 及 `rowPaintMode` / `rowPaintHold` 两个 context。

**延后移到窗口层**（`Virtual`）：

- `visible`：`mountedRange` 的 overscan 设为 0 得到的区间，永远挂载。
- `ahead`：带 overscan 的区间中不在 `visible` 内的行。这些行只有在 `warmed` 集合里才挂载。
- `warmed: Set<string>`（每个 transcript 一份）。不在集合里的 `ahead` 行排进 `paint-queue`，任务内容是调用 `props.warm(item)`，完成后把 id 加入 `warmed`（一个 signal 版本号触发窗口重算）。
- `props.warm?: (item: T) => void` 由 `TranscriptView` 提供：遍历 segment 内消息的 text 块，调用 `warmMarkdown(text)` 把 HTML 填进 `htmlCache`，不碰 DOM。
- 进入 `visible` 的行无论是否 warmed 都同步挂载。

**`paint-queue.ts`**：保留 `createPaintQueue`（预算、每帧至少一个），删掉 `prioritize` 与 `firstPaint`。它只负责预热，不再影响任何可见状态。

**取舍**：快速甩进从未预热的重内容时，`visible` 行会在滚动帧里冷解析。用 bench B/C/D 的 `maxGap`、`over50`、`blockedMs` 在 WebKit 下判断；回退阈值见"验证"。

### 第 3 步：Markdown 块化

**`md-blocks.ts`（新，纯函数，不碰 DOM）**

```ts
export interface MdBlock { key: string; raw: string }
/** Top-level blocks from `marked.lexer`. Key = `${index}\0${raw}`: same text in the same place, same block. */
export function splitBlocks(source: string): MdBlock[];
```

**`md-render.ts`（新，碰 DOM，不碰调度）**

- `blockNodes(raw, { finished }): Node[]`：缓存命中则 `innerHTML = cached`，否则 marked → DOMPurify → 高亮 → 写缓存；`finished` 时包装并异步绘制图表（现有 `drawDiagrams` 逻辑搬过来）。
- `warmMarkdown(source)`：对每个块调用解析并写缓存，供第 2 步预热用。
- `withCaret(nodes)`：在最后一块的光标目标里追加光标 span，作为节点树的一部分参与修补（替代 `syncCursor` 的查询删除再插入）。

**`md-reconcile.ts`**：新增 `reconcileList(prev: readonly Node[], next: readonly Node[]): Node[]`，返回复用（就地修补）后的节点数组；`reconcileChildren` 改为基于它实现。

**`Md` 组件**

```tsx
const source = coalesced(() => props.text);       // 首次同步，之后每帧至多一次
const blocks = createMemo(() => splitBlocks(source()));
const settled = () => (live ? blocks().slice(0, -1) : blocks());
const tail = createMemo<Node[]>((prev) => live && last ? reconcileList(prev ?? [], withCaret(blockNodes(last.raw, { finished: false }))) : []);

<div class="md ...">
  <For each={stableKeys(prevKeys, settled().map(b => b.key))}>{(key) => blockNodes(rawOf(key), { finished: true })}</For>
  {tail()}
</div>
```

- 块节点直接插入 `.md`，不加包装元素，因为 `theme.css` 依赖 `.md > :first-child` 等选择器。
- 回复写完时最后一块从 tail 变成 settled，键出现在 `<For>` 中，用 `finished: true` 创建一次，图表在这时绘制。
- setext 标题等改写前一块的情况：该块 raw 变化、键变化，只重建那一块。
- `md-stream.ts` 不再被 `Md` 使用；确认无其他引用后删除模块及其测试。
- 图片点击、`md-bubble` 等外部接口不变。

## 测试

- 纯函数单测：`stableKeys`、`splitBlocks`（散文增长时前块键不变、fence 闭合、setext 改写、空串）、`reconcileList`（沿用 `md-reconcile.test.ts` 的 fake DOM）、disclosure 记忆。
- 改写依赖源码文本的结构测试：`virtual-window.test.ts` 中断言 `useRowPaintMode` / `enqueuePaint` 存在的用例，改为断言新不变式（例如 `md.tsx` 不再引用 `paint-queue`）。
- 每步都跑：`bun run typecheck`、`bun run lint`、`bun run test:ui`、`bun test packages`。

## 验证

- 基线：`bench/results/baseline-77fdabd-wk.json`（WebKit，A–D，3 reps，无正确性失败）。
- 每步提交前：`bun run bench --engines webkit --flows A,B,C,D --compare bench/results/baseline-77fdabd-wk.json`。退出码 1（落点错、空白帧、页面错误）一律视为阻断。
- 第 2 步额外关注 `A/open settleMs`、`B/C step-up`、`D/running-wheel-up` 的 `maxGap` / `over50` / `blockedMs`。若中位数 `over50` 或 `blockedMs` 明显恶化（超过基线一倍），先调大预热范围；仍不行再讨论。
- 手动：在 Tauri 桌面端打开真实长会话，检查流式回复、工具调用归属时展开状态、回显替换、滚动上翻。

## 交付顺序

三步各自独立提交（`refactor(transcript): …` / `perf(transcript): …`），每步都能单独回滚。备份分支 `backup/pre-forcepush-0.22.5` 上的 `d726cb3`（行高跟随内容）和 `e4b72fa`（工具调用只归属一次）在第 1 步时对照，有价值的部分一并带回。
