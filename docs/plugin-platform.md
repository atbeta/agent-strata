# 插件化平台方案（草案）

> 状态：Draft for review。先定架构与契约，再按里程碑落地。
> 首个验证对象：内置浏览器能力；骨架验证对象：dev-process 迁移。
> 修订：ABI 定为 host API 而非 MCP；v1 仅内置插件 in-process；UI 走类型化贡献；
> 第三方插件（子进程、scoped token、授权 UI）整体推至 M4，契约中保留扩展位。

## 1. 背景与目标

当前 strata 已经有一条“事实上的工具注入通道”：

- `plugins/dev-process.ts` 通过 OpenCode 的 plugin API 注册 `dev_*` 工具；
- Tauri 用 `include_str!` 把它编进壳，安装到 `~/.config/opencode/plugin/`；
- 插件直接调用 service 的扁平路由（`/dev`、`/dev/:id/logs`），并携带全局 `STRATA_API_TOKEN`。

这条通道能工作，但它不是插件系统：只有一个固定文件、只覆盖 OpenCode、没有 manifest/发现/启停/版本、没有权限隔离，插件也无法贡献 service 路由或 UI。

**目标：**

1. 增加一个能力时，不再同时修改 service、UI、Tauri 三处。
2. 插件能声明并贡献：工具、资源、面板、后端驱动、提示词与拦截钩子。
3. 工具执行始终经过 strata 的 policy 与权限询问，插件不能绕过。
4. 浏览器作为第一个 capability 插件，验证整条链路。

**非目标（v1 不做）：**

- 第三方插件运行时整体：子进程隔离、安装/授权 UI、在线分发与自动更新；
- 跨机器调度、远程插件；
- 任意第三方 UI 代码直接运行在主窗口；
- 完整的 OS 级沙箱。v1 所有插件都是一方可信代码，in-process 运行；`permissions` 字段先作为声明与宿主中介限制的依据。

## 2. 设计原则

1. **Manifest-first。** 插件的能力、工具、资源、权限、UI 入口都写在 `plugin.json`，宿主只读 manifest 做路由与授权。
2. **执行必须回到 service。** agent 调用的工具最终落到 `POST /plugins/:id/tools/:tool`，由 service 做 session 解析、policy 判定、`askPermission`，再交给插件。这是唯一的策略执行点；任何适配器若绕过这一层，就等于绕过了策略。
3. **v1 只有内置插件：in-process、实例长命。** “宿主”不是 service 主代码，是 registry 持有的长命插件实例 —— 能力的长期资源（Chrome、设备连接）归实例所有。第三方子进程是 `entry.kind` 的扩展位，隔离边界随它一起落地，不提前付成本。
4. **ABI 是 host API，不是 MCP。** 每个后端一个哑适配器，只做三件事：向 service 拉工具表、把工具注册进本后端、调用时附上 session 转发。适配器不认识任何具体能力，加能力永远不改适配器。MCP 只是 ACP 适配器的传输层，不是执行点。
5. **UI 贡献是类型化的，且必须有 fallback。** 工具行拿渲染元数据，面板从少量参数化 kind 里选；没有 UI 声明的工具仍然渲染成通用工具行，面板贡献失败不能拖垮主界面。任意插件代码不进主窗口。
6. **命名空间 + 最小权限。** 路由、工具名、资源 key 都以 `plugin_id` 为前缀；第三方落地时插件拿不到全局 token。

## 3. 分层与术语

一个插件可以同时提供多种东西，用 `provides` 声明：

| 值 | 含义 |
| --- | --- |
| `tools` | 向 agent 暴露工具 |
| `resources` | 暴露可读资源（截图、日志、状态） |
| `panel` | 向右栏贡献一个面板 |
| `backend` | 注册一个新的 `BackendDriver` |

提示词注入与工具拦截是另一类贡献，走 manifest 的 `hooks` 字段（见 4.1/4.3），不进 `provides`；`ui` 渲染元数据同样不进 `provides`，它依附于 `tools` 声明。校验规则：`provides` 与对应 manifest 段必须互相一致 —— `provides: ["panel"]` 就必须有 `panel` 段，声明了 `panel`/`resources` 段就必须出现在 `provides` 里，否则拒绝加载。

按运行位置分两层：

- **Agent 面**：agent 看到的工具。由后端适配器注入 —— OpenCode 是通用 shim，ACP 是 per-session MCP。
- **宿主面**：service 里的 plugin host。负责生命周期、路由、策略、资源、事件。

数据面沿用 CASF：

```
agent tool call
  -> adapter（OpenCode 通用 shim / ACP per-session MCP，哑转发 + session）
  -> POST /plugins/<id>/tools/<tool>  { session_id, input, call_id? }
  -> session resolve + policy + askPermission
  -> plugin instance（in-process，registry 持有）
  -> tool.call / tool.result / tool.progress
  -> UI 订阅 /plugins/<id>/events 与 /stream
```

## 4. 核心契约

### 4.1 Manifest

```json
{
  "id": "browser",
  "name": "Browser",
  "version": "1.0.0",
  "engines": { "strata": ">=0.28.0" },
  "entry": { "kind": "builtin" },
  "provides": ["tools", "resources", "panel"],
  "permissions": {
    "browser": true,
    "net": ["*"],
    "fs": [],
    "shell": false
  },
  "tools": [
    {
      "name": "navigate",
      "description": "Open a URL in the session's browser tab.",
      "input": {
        "type": "object",
        "properties": { "url": { "type": "string" } },
        "required": ["url"]
      },
      "policy": { "default": "ask", "risk": "network" },
      "guards": { "url": "net" },
      "timeout_ms": 30000
    },
    {
      "name": "eval",
      "description": "Evaluate JavaScript in the session's tab.",
      "input": { "type": "object", "properties": { "source": { "type": "string" } }, "required": ["source"] },
      "policy": { "default": "ask", "risk": "exec" }
    }
  ],
  "resources": [
    { "key": "screenshot", "mime": "image/png" },
    { "key": "console", "mime": "application/json" }
  ],
  "panel": { "id": "browser", "title": "Browser", "kind": "screencast" },
  "config": { "type": "object", "properties": {} }
}
```

dev-process 这类需要拦截与提示词贡献的插件，加 `hooks`：

```json
"hooks": { "beforeTool": ["shell"], "systemPrompt": true }
```

第三方落地时 `entry` 换成：

```json
{ "kind": "process", "command": ["bun", "run", "index.ts"], "protocol": "mcp" }
```

字段约束：

- `id` 只允许 `[a-z][a-z0-9-]*`，不能包含 `..`、`/`。字符集刻意不含 `_`：`<id>_<tool>` 按首个下划线无歧义拆分；`tools`、`hooks` 为保留段，不得作为插件 id。
- `tools[].name` 在插件内唯一；对外暴露为 `<id>_<name>`，CASF 里同时保留 `plugin_id` 与原始 `tool`。
- `tools[].guards`：执行前由宿主校验的输入约束，形如 `{ "<input 字段>": "net" | "workspace" }`。`net` 按 `permissions.net` 的 host 允许列表校验 URL；`workspace` 要求路径解析后仍在 session 工作区内。校验失败返回 403，不进插件。只约束声明的字段 —— 这是宿主真正能执行的安全面（见 4.8）。
- `tools[].timeout_ms`：单次执行上限，缺省 120s；超时按 `interrupted` 收尾。
- `panel`：v1 为单数，一个插件至多一个面板。
- `provides` 与 manifest 段的一致性校验见 §3。
- `entry.kind`：v1 只实现 `builtin`；`process` 为第三方预留，届时协议固定为 MCP over stdio（见 4.4）。
- `hooks.beforeTool`：插件要参与判定的**内置**工具名列表，经 `POST /hooks/before-tool` 回调插件。v1 不允许拦截其他插件的工具。
- `hooks.systemPrompt`：插件贡献 system prompt 文本，经 `GET /hooks/system-prompt` 汇总。
- `permissions`：v1 是声明与 `guards` 校验的依据；第三方落地时成为安装授权清单。
- `engines.strata` 不匹配时拒绝加载，并给出可读原因。

### 4.2 生命周期

状态机：

```
discovered -> disabled -> starting -> running -> stopping -> disabled
                                |          |
                                +-> failed <+
```

- **发现**：内置插件在 `packages/service/src/plugins/builtin.ts` 的静态数组注册（一行一个）；`~/.agent-strata/plugins/<id>/plugin.json` 的目录扫描留给第三方，M4 落地。
- **启用**：检查 manifest、版本；in-process 实例化并 `initialize`，失败进入 `failed`。
- **健康**：`GET /plugins/:id/health`；实例抛异常进入 `failed`。`restart` = `shutdown` + `initialize`；子进程自动重启/退避属于 `process` 语义，随第三方落地。
- **停用/卸载**：`shutdown` 后释放实例全部资源 —— 例如 browser 插件停止即关闭其全部 tab 与 Chrome（attached 的外部目标除外）。卸载删除插件目录与数据目录是第三方语义，v1 不涉及。
- **状态持久化**：enable/disable 写入 `plugins-state.json`（数据目录，0600），重启后保留；内置插件缺省为 enabled。
- **日志**：插件日志带 `[plugin:<id>]` 前缀写入 `service.log`。
- **变更广播**：插件启停改变 `GET /plugins` 的内容时，向 `/stream` 广播 `plugins.changed`，UI 重拉注册表。

### 4.3 Host API

所有路由都在 loopback + 现有 Host/Origin/token 守卫之下。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /plugins` | 列出插件、状态、manifest 摘要（tools/resources/panel/ui/hooks） |
| `GET /plugins/tools` | 全部已启用插件的工具表：`<id>_<tool>`、描述、input schema。与会话无关 —— session 相关判定全部在执行时的 policy 里，不在可见性里 |
| `POST /plugins/:id/lifecycle` | `{ "action": "enable" \| "disable" \| "restart" }` |
| `POST /plugins/:id/tools/:tool` | 执行工具；body `{ session_id, input, call_id? }`；内部做 guards 校验 + policy + ask。**唯一执行入口** |
| `GET /plugins/:id/resources/:key` | 读资源；`?session=`；返回 bytes 或 JSON |
| `GET /plugins/:id/events?session=` | SSE：进度、日志、面板事件；query token 放行 |
| `GET /plugins/:id/health` | 存活与最近错误 |
| `ANY /plugins/:id/<rest>` | 固定动词之外的路径交给插件的 `route()`：panel 输入、能力私有端点都走这里，不再为单个端点改 service |
| `POST /hooks/before-tool` | `{ session_id, tool, input }` -> `{ allow, message? }`；按 manifest `hooks.beforeTool` fan-out，首个 deny 生效 |
| `GET /hooks/system-prompt?session=` | 各插件 `systemPrompt` 贡献的拼接结果 |

要点：

- `/tools/:tool` 是唯一的工具执行入口，插件不能自己接 agent 请求。该路由从 M0 起就做完整的 session resolve + policy + `askPermission`（与 `/dev` 同一代码路径），不是 M1 才补的安全层。
- `session_id` 接受 casf 或 native，复用现有 `resolveSessionId`；policy 复用 `policySourceFor`（连接级 policy 优先于共享 policy）。
- `call_id` 是工具调用在 CASF 里的 join key：适配器拿得到后端调用 id 就传（ACP 适配器自己铸造、同时用于其 CASF 上报；新版 OpenCode 的 `Tool.Context.id`），拿不到时宿主按“该 session 该工具的最近未决 `tool.call`”尽力 join。join 不上的 `tool.progress` 退化为 session 级展示，不阻塞执行。
- 取消与超时：宿主把 abort 传进 `callTool` 的 `signal`（见 4.4）。取消源：调用方断开（OpenCode shim 里 `context.abort` -> fetch abort -> 服务端 `req.signal`）、session/turn cancel、manifest `timeout_ms`。被取消的调用以 `status: "interrupted"` 收尾。
- `guards` 校验在 policy 之前、插件之外：声明了 `guards` 的输入字段先过宿主约束，再进 `callTool`。
- 事件流需要把 `/plugins/:id/events` 加入 query-token 白名单（与 `/stream`、WebSocket 同一处理）。
- 资源响应默认 `content-security-policy: sandbox`，与 extension 路由一致。
- 固定动词先匹配，剩余路径才进插件 `route()`；`route()` 只能见到自己命名空间内的子路径。

### 4.4 插件接口

内置插件实现 `StrataPlugin`（`packages/plugin-sdk`）：

```ts
export interface StrataPlugin {
  initialize(ctx: PluginContext): Promise<void>;
  listTools(): PluginTool[];                                   // provides: tools
  /** req: { callId?, sessionId, input, signal } —— signal 中止来源见 4.3 */
  callTool(req: ToolCallRequest): Promise<ToolCallResult>;
  readResource?(req: ResourceRequest): Promise<ResourceResult>;
  /** /plugins/:id/<rest> 的私有端点；返回 undefined 则 404 */
  route?(req: Request, subpath: string): Promise<Response | undefined>;
  /** hooks.beforeTool 声明的工具被调用前回调；deny 时 message 原样回给模型 */
  beforeToolCall?(req: { tool: string; input: Record<string, unknown>; sessionId: string }):
    Promise<{ allow: true } | { allow: false; message: string }>;
  /** hooks.systemPrompt；返回拼进系统提示词的文本 */
  systemPrompt?(sessionId: string): Promise<string | undefined>;
  /** 插件 -> 宿主事件；宿主转成 /plugins/:id/events SSE */
  onEvent?(emit: (event: PluginEvent) => void): void;
  shutdown(): Promise<void>;
}
```

`PluginContext` 提供：`pluginId`、数据目录、manifest `config`、logger、`emit`。

第三方协议预留：`entry.kind: "process"` 落地时**直接用 MCP over stdio**，不发明第二套 JSON-RPC —— 所需的 `tools/list`、`tools/call`、`resources/read`、进度通知与 MCP 一一同构，插件同时是一个可独立运行的 MCP server；`panel/input`、`beforeToolCall` 等扩展作为同一信封上的自定义方法。届时宿主侧只多一个“spawn + 握手”的实现，`StrataPlugin` 的方法集不变。

### 4.5 工具暴露给 agent

每个后端一个**哑**适配器：拉工具表 -> 注册 -> 调用时附 session 转发。适配器不认识任何具体能力，加能力不改它。

**OpenCode：通用 shim（这是长期形态，不是兼容层）。**

- `plugins/strata-shim.ts`：一个文件，取代 dev-process.ts 成为唯一安装的 OpenCode 插件。
- init：握手文件/env 找 service -> `GET /plugins/tools` -> 把全部 `<id>_<tool>` 动态注册成 OpenCode 工具。plugin 加载时没有 session（`context.sessionID` 只在 `execute` 里），所以工具表是全集、不带 session 过滤；session 相关判定在执行时做。
- `execute`：`POST /plugins/:id/tools/:tool`，带 `context.sessionID`；当前稳定版 OpenCode 的 `ToolContext` 没有 callID，`call_id` 缺省走宿主回退 join（见 4.3），`context.id` 出现在上游后透传。OpenCode 侧只有 plugin API 给得出 session —— 这是 MCP 不覆盖 OpenCode 的根本原因，不是临时妥协。
- `context.abort` 中止 fetch，宿主经 `req.signal` 取消 `callTool`。
- `tool.execute.before` -> `POST /hooks/before-tool`；`experimental.chat.system.transform` -> `GET /hooks/system-prompt`。拦什么、提示词写什么都在插件里，shim 只是电话线。
- service 不可达时全惰性：不注册工具、hook 直接放行 —— 复用现有握手文件 + `/health` 探测机制，形态与今天的 dev-process 一致。
- 已知限制：OpenCode 在 plugin 加载时拿到一次工具表，插件启停对**已运行**的 OpenCode 在其下次启动时生效。
- **v2 变体（预留）**：OpenCode v2 的插件 API 不兼容（`Plugin.define` + domain hooks，无旧 hook 兼容层），但 `<config>/plugin/` 目录扫描与 `OPENCODE_CONFIG_*` 注入不变，安装面不用动。shim 按宿主 API 探测分支；v2 的 `tool.transform`（运行时改工具表）、execute context 的 `id: CallID`/`signal`/`progress()` 恰好原生覆盖我们的 call_id/取消/进度需求，平台契约不变，只多一个 shim 变体。

**ACP：per-session MCP。**

- `session/new` 的 `mcpServers` 注入 MCP endpoint，不再写死 `[]`（`packages/adapter-acp/src/index.ts:444`）。
- session 编进注入参数（推荐 URL token，备选 stdio 参数），适配器因此知道自己在服务哪个 session —— 这是它与 OpenCode 路径的本质差别。URL token 只允许 loopback 绑定、短 TTL、且必须脱敏不落 `service.log`。
- `call_id` 由适配器铸造：同一个 id 同时用于它上报的 CASF `tool.call` 与转发的 execute body，progress 因此严丝合缝。
- MCP 适配器只做 `tools/list` -> `GET /plugins/tools`、`tools/call` -> `POST /plugins/:id/tools/:tool`。它**不**做 policy：执行点只有 host API 一处，不存在“MCP 绕过策略”这个面。

### 4.6 CASF 扩展

现有 `tool.call` / `tool.result` 已经够通用（`packages/schema/src/index.ts:217,236`），只加可选字段：

- `tool.call.plugin_id?: string`：工具来自哪个插件；老日志没有这个字段，解析不受影响。
- `tool.result.plugin_id?: string`：同上，便于 UI 和策略回溯。
- 工具名对外仍是字符串，但约定为 `<plugin_id>_<tool>`；`plugin_id` 是权威来源。

新增**仅内存**事件：

- `tool.progress`：`{ call_id, message?, percent?, data? }`；`call_id` 的来源与缺失时的回退 join 见 4.3。
- 不写入 store，只走 live overlay / SSE；与 `isStreamingSnapshot` 同类，由新增的 `isEphemeralEvent` 判定。
- 这样不会破坏已落盘的 CASF 日志兼容性，也不需要给 `EVENT_DATA_CLASS` 增加分类。

附件沿用 `tool.result.attachments`；大截图走现有 `spillAttachment`（`packages/service/src/index.ts:297`），小图内联。

### 4.7 UI 贡献

**工具渲染元数据。** manifest 可以声明：

```json
"ui": {
  "toolRenderers": {
    "navigate": { "kind": "web", "icon": "globe" },
    "screenshot": { "kind": "read", "icon": "image" }
  }
}
```

- UI 启动时拉 `GET /plugins`，建立 `pluginId/tool -> renderer` 注册表；`plugins.changed` 广播驱动失效重拉。
- 没有声明的工具继续落到现有通用渲染（`transcript-format.ts:221` 的 `wrench` fallback），保证不崩。
- 现有 `KINDS` 表保留给内置工具，插件元数据优先。

**面板：类型化贡献，不是任意代码。** `panel.kind` 从固定集合里选：

| kind | 用途 | 数据面 |
| --- | --- | --- |
| `screencast` | 帧流 + 指针/键盘回传（browser、未来的远程桌面/相机共用） | 帧走 `/plugins/:id/events` SSE；输入走插件 `route()`（如 `POST /plugins/:id/panel/input`） |
| `logs` | 滚动日志 | events SSE |
| `status` | 键值状态/简单表单 | resources 轮询 + `route()` |
| `component` | 编译期注册的 Solid 组件 —— 一方插件的逃生舱 | 任意 |

- 新 kind = 显式改 UI 的例外路径，只发生在能力真有新交互形态时；`iframe` kind 与第三方一起落地（sandbox + postMessage + scoped token，不给 iframe 全局 token）。
- `SidePanelTab` 从固定 union 改为 `string` + 注册表；内置的 `changes/files/background` 仍是默认项。
- 面板事件走 `/plugins/:id/events`；用户输入走插件自己的 `route()`，天然按 plugin 命名空间隔离。

**进度。** 工具行可以订阅 `tool.progress`，显示分步状态；没有进度就保持现有行为。

### 4.8 权限与安全

- **宿主侧限制，边界说清。** 宿主只能在自己中介的面上执行限制，具体到两处：`tools[].guards` 声明的输入字段（`net` 按 allowlist、`workspace` 按工作区）在 dispatch 前校验；`route()` 进来的私有端点天然在 `plugin_id` 命名空间内。in-process 插件自己发起网络/文件访问宿主拦不住 —— 第三方子进程落地后也一样，除非届时引入 OS sandbox。`"shell": false` 的准确含义是“service 不会替它执行 shell”，不是“它执行不了 shell”。`permissions` 其余字段在 v1 是安装授权前的声明性文档。
- **策略。** `evaluate` 的输入增加 `plugin_id`；manifest 的 `policy.default` 是一道下限，裁决优先级为：**显式规则 > manifest floor > 其余裁决**（含 session auto 与文档 `default`）。合并规则是机械可验的：`evaluate` 返回带 `rule_id` 的裁决视为命中显式规则，原样生效；不带 `rule_id` 的裁决（文档 default、auto stance、引擎 floor）与 manifest `policy.default` 按 `deny > ask > allow` 取严。读者显式写的 allow/always 规则仍能放行 `browser_eval` —— 那是做过决定；auto stance 和宽松文档 default 不能 —— 前者是懒得被打扰，后者没就这个工具说过话。实现上不需要 `Decision` 加字段，`rule_id` 的存在与否就是 provenance；若想更可读可加 `source` 字段，语义不变。
- **token。** scoped token 与第三方一起落地；in-process 插件运行在 service 内，不需要 token。第三方插件届时一个插件一个随机 token，只允许 `/plugins/<id>/*` 与必要的只读 session 路由，全局 `STRATA_API_TOKEN` 不下发。
- **安装授权。** `permissions` 届时在启用前展示，授权结果写入 `plugin-grants.json`（0600）；默认不启用第三方插件。
- **审计。** 每次工具执行记录 `plugin_id`、工具名、session、决策来源（policy/ask/auto）。

## 5. 浏览器作为第一个 capability 插件

### 5.1 谁来持有浏览器

浏览器不是无状态工具：它有一个长期存活的 Chrome、持久 profile、跨 session 的 tab 集合、CDP 端口、截图/录屏流，以及重启后的接管。这些东西不能放在“每次调用起一个子进程”的形态里，否则：

- 多 session 无法共享登录态；
- service 重启后无法接管仍在运行的窗口；
- UI 的 screencast 没有唯一 owner；
- 清理、超时、权限都无法统一。

因此 v1 的分工是：

- **browser 插件实例持有 BrowserManager**：实例由 registry 持有、随 service 长命，Chrome 生命周期、CDP、tab、snapshot refs、screencast 都归它。“宿主持有”的正确粒度是长命插件实例，而不是 service 主代码 —— 这正是插件化相对“service 里写死 `browser.ts`”的收益。
- **生命周期语义**：disable/stop 插件 = 释放全部 tab 与 Chrome；session 结束只清理该 session 的 tab；attach 的外部目标永不关闭。
- service 主代码不出现任何 `browser_*` 分支，全部走 manifest + host。

### 5.2 工具与资源

工具（对外名 `browser_*`）：

`navigate`、`attach`、`snapshot`、`click`、`type`、`fill`、`press`、`hover`、`select`、`eval`、`console`、`screenshot`、`tabs`、`use`、`close`。

资源：

- `screenshot`：当前页截图，`image/png`；
- `console`：控制台/页面错误/失败请求的尾部；
- `tabs`：当前 session 的 tab 列表。

作用域：所有 tab 操作（`use`/`close`/`tabs`/`snapshot` 等）只作用于**本 session** 的 tab 集合，session A 的 agent 够不到 session B 的 tab；`attach` 接入的外部目标也按 session 记账。

策略默认值建议：

| 工具 | 默认 |
| --- | --- |
| `navigate` | `ask`（`risk: network`），host 允许列表由 `permissions.net` 决定 |
| `eval` | `ask`（`risk: "exec"`）：session auto 不放行，读者显式规则仍可放行 |
| `click` / `fill` / `type` / `press` | `allow`（在已授权的浏览器上下文内） |
| `screenshot` / `console` / `tabs` | `allow` |

### 5.3 面板与数据流

面板是 `kind: "screencast"` 的类型化贡献，UI 组件是通用件，输入端点是插件 `route()` 的私有路由：

```
Chrome (CDP)
  -> BrowserManager (plugin-browser 实例)
  -> /plugins/browser/events (SSE: screencast frame, console, tabs)
  -> UI screencast 面板

UI pointer/wheel/key
  -> POST /plugins/browser/panel/input   (插件 route() 接住)
  -> BrowserManager
  -> Chrome
```

截图作为工具结果时走 `tool.result.attachments`；实时 screencast 不走 CASF，避免把视频帧写进事件日志。

### 5.4 历史参考

v0.25.0–0.25.3 已经实现过一版浏览器（`f4e524b`、`bddf70d`、`6e86278`），形态是“service 里的 `browser.ts` + 第二个写死的插件 + 写死的 UI pane”。它没有进入当前 main。这份代码是很好的实现参考，但**不要按原样加回去**：那正是本方案要泛化的特例。

## 6. 里程碑

### M0 — 插件骨架 + 通用 shim（不动行为）

- 新增 `packages/plugin-sdk`：manifest 类型、`StrataPlugin`、`PluginContext`。
- 新增 `packages/service/src/plugins/`：registry、`builtin.ts`、生命周期、`GET /plugins`、`GET /plugins/tools`、`/hooks/*` 路由、插件 `route()` 挂载。
- 新增 `plugins/strata-shim.ts`：通用 OpenCode shim，动态注册工具 + 转发 hooks + `context.abort` 中止。
- `/tools/:tool` 从第一天就走 session resolve + policy + `askPermission` —— 与 `/dev` 同一代码路径，不是后补的安全层；`guards` 校验与 `signal`/`timeout_ms` 一并落地。
- dev-process 迁成首个内置插件 `packages/plugin-dev-process`：`dev_*` 经 tools 路由，Start-Process 拦截经 `beforeToolCall`，GUIDANCE 经 `systemPrompt`。插件 id 取 `dev` 时对外工具名与今天完全一致 —— `dev_start` 因此仍在 `SHELL_TOOLS` 里，命令分析、读者的 shell 规则都照常生效，迁移对 policy 透明。
- Tauri：`plugin_install.rs` 通用化 —— 仍写“那一个 shim + handshake”，但不再 per-能力；保留 `browser.ts` 残留清理。
- **验收**：`dev_*` 全部测试通过（policy/ask 行为与今天一致）；Start-Process 拦截与 GUIDANCE 注入行为不变；新增 echo 内置插件 = 一个包 + 一行注册，不改 Rust/UI/shim；无 service 的 OpenCode 不受影响。

### M1 — 策略细化 + ACP

- `plugin_id` 进 `evaluate` 输入与 CASF；manifest floor 与显式规则/auto 的合并语义落地；`tool.progress` 仅内存，接 `call_id` join。
- `/plugins/:id/events` 进 query-token 白名单。
- ACP `mcpServers` 注入 + MCP 哑适配器（含 per-session `call_id` 铸造）。
- **验收**：`deny`/`ask`/auto 对插件工具生效；manifest `ask` 不被 session auto 放行、能被显式规则放行；ACP 会话能看到并调用插件工具；echo 插件经 shim 与 MCP 双路跑通。

### M2 — 浏览器工具面

- `packages/plugin-browser`：实例持有 BrowserManager（参考 `f4e524b`），manifest 声明 `browser_*` 工具与资源。
- 不新增任何硬编码的 `browser_*` service 分支；全部走 manifest + host。
- **验收**：OpenCode 与 ACP 都能完成 navigate/snapshot/click/screenshot；session 结束时 tab 被清理；service 重启能接管已有 Chrome；**打包评估已完成：结论是不用 Playwright**（见 §8）。

### M3 — UI 贡献

- `/plugins` 元数据驱动的工具渲染注册表。
- `SidePanelTab` 动态化；`screencast` 面板通用件 + browser 面板接入（SSE + `route()` input）。
- `tool.progress` 接入工具行。
- **验收**：不修改 `transcript-format.ts` 的 `KINDS` 也能让 `browser_*` 正确显示；面板关闭/崩溃不影响主界面。

### M4 — 第三方插件（可选，另立项）

- `entry.kind: "process"` + MCP over stdio 宿主实现；`~/.agent-strata/plugins/` 扫描。
- per-plugin scoped token、`plugin-grants.json`、安装授权 UI、`iframe` panel kind、失败回滚。

## 7. 改动范围（预估）

| 区域 | 文件 |
| --- | --- |
| 新包 | `packages/plugin-sdk`（manifest、类型）；`packages/plugin-dev-process`；`packages/plugin-browser` |
| service | `packages/service/src/plugins/*`（registry、host、hooks）、`index.ts` 挂载、`api-token.ts`（query 白名单）、`extension-route.ts` 参考 |
| shim | `plugins/strata-shim.ts`（新，通用）；`plugins/dev-process.ts` 移除，业务入 `plugin-dev-process` |
| schema | `packages/schema/src/index.ts`：`plugin_id`、`tool.progress`、`isEphemeralEvent` |
| policy | `packages/policy/src/index.ts`：`plugin_id` 输入；manifest floor 与 auto stance 的合并 |
| adapter | `packages/adapter-acp/src/index.ts`：`mcpServers` 注入；MCP 哑适配器（service 内或新包） |
| Tauri | `apps/desktop/src-tauri/src/plugin_install.rs`：通用化为 strata-shim + handshake，保留 stale 清理 |
| UI | `apps/desktop/ui/src/api.ts`、`right-pane.ts`、`transcript-format.ts`、typed panel 通用件 |
| 浏览器 | `packages/plugin-browser` 内含 BrowserManager（参考历史实现 `f4e524b`） |

## 8. 风险与取舍

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| 适配器夹带业务 | 哑适配器纪律一旦破例，能力又开始往适配器里长 | 适配器只有拉表 + 转发两个动作；review 盯住“适配器是否认识具体工具名” |
| OpenCode 拿不到 session | MCP 调用不含 session 上下文，OpenCode 的 MCP 配置还是全局的 | OpenCode 长期走 shim，`context.sessionID` 是唯一可靠来源；MCP 只服务 per-session 注入的 ACP |
| hooks 路由成为新的万能口 | `before-tool` 若不加约束就是又一个拦截面 | 按 manifest `hooks.beforeTool` 声明 fan-out，没声明的插件不被调用；v1 只允许拦内置工具；hook 超时 fail-open（与“无 service 全惰性”一致） |
| CASF 兼容性 | 新增事件类型会让旧解析器拒绝日志 | `tool.progress` 只走内存/SSE，不落盘 |
| sidecar 打包 | `playwright-core` 塞进编译产物会重演 `c3d16ff`/`94ae556` | **已实测：`bun build --compile` 失败**（`chromium-bidi`/`electron` 在打包期无法解析，1.55 与 1.64 都一样）。结论不是迁子进程，而是**不依赖 Playwright**：`packages/plugin-browser/src/cdp.ts` 直接讲 CDP（Bun 自带 WebSocket），打包从 95MB 降到 65MB，协议面只多 ~300 行。代价：点击是 CDP 的 trusted input 而非 Playwright 的自动等待，快照/ref/截图/多 tab 全部保留 |
| UI 沙箱 | WebKit 下 iframe/CSP 行为与 Chromium 不同 | 类型化面板把任意代码挡在主窗口外；`iframe` kind 与 scoped token 随第三方落地 |
| 插件信任 | 第三方插件是任意代码 | v1 全一方代码无此面；M4 落地时：默认停用、安装授权、scoped token、MCP stdio、审计 |
| 多 session 浏览器 | 一个 Chrome、多个 session、多个 tab | BrowserManager 按 session 持有 tab；关闭 session 只清理自己的 tab；attached 目标永不关闭；disable 插件全释放 |
| 工具重名 | 两个插件都叫 `snapshot` | 对外 `<plugin_id>_<tool>`；CASF 保存 `plugin_id` |
| ACP MCP 支持差异 | 不同 ACP agent 对 `mcpServers` 支持不一致 | 能力探测失败则该 session 无插件工具，其余路径不受影响；OpenCode 不走此路 |
| 工具表快照过期 | OpenCode 在 plugin 加载时拿一次工具表 | v1 接受：启停对已运行 OpenCode 在下次启动生效；v2 的 `tool.transform` 支持运行时改表，届时消解 |
| OpenCode v2 分叉 | v2 是全量重写：插件 API（`Plugin.define`）、事件清单、`/api/*` REST、action/resources 权限模型全换，且无旧 hook 兼容层；同时 v1/v2 会长期共存于用户机器 | 平台契约后端无关，v2 只新增一个 `BackendDriver` 适配器 + 一个 shim 变体；v2 事件反而更贴 CASF（durable/ephemeral 原生分类、`session.tool.progress` 原生存在）。v2 未发布、API 仍在流动 —— 适配器等其稳定再写，shim 探测分支现在预留 |

## 9. 待决策

1. **内置插件注册**：`builtin.ts` 静态数组（显式、可 typecheck）vs 启动时扫 `packages/*/plugin.json`（零触碰但隐式）。v1 建议静态数组 —— 一行也是接缝，但可读可查。
2. **ACP MCP 传输**：per-session HTTP URL token，还是每 session 一个 stdio 参数？v1 建议 URL token —— HTTP 已是宿主母语；约束是 loopback only、短 TTL、日志脱敏（query token 不能写进 `service.log`）。
3. **hooks 覆盖面**：v1 只允许拦内置工具、`systemPrompt` 只追加不修改 —— 是否够用？插件拦插件是更后面的问题。
4. ~~**浏览器打包预案**~~：已定。`playwright-core` 进不了编译产物，方案改为自写 CDP 客户端（零依赖、可打包）；`entry.kind: "process"` 的 MCP 协议面仍留在 M4。
5. **插件工具是否进入应用自己的命令面板/斜杠命令**：v1 不做，避免与后端命令混淆。
6. **OpenCode v2 适配器介入时机**：等 v2 正式发布、事件清单稳定后再写；当前只在 shim 里预留 API 探测分支，不提前绑定未定的形状。

## 10. 验收与测试策略

- **单元**：manifest 校验（含 `provides` 与段的一致性、`guards`/`timeout_ms`）、工具表生成、hooks fan-out 与超时、路由命名空间匹配、guards 校验、policy floor/auto 合并、CASF 新字段。
- **集成**：echo 内置插件完成 tools/list、tools/call、resources/read、events、`route()` 私有端点；`call_id` 透传与缺失时的回退 join；abort/`timeout_ms` 以 `interrupted` 收尾。
- **hooks**：dev-process 的 Start-Process 拦截与 GUIDANCE 注入回归；无 service 时全惰性；多插件 fan-out 顺序与首个 deny 生效。
- **策略**：`deny`、`ask`、session auto 三种情况对插件工具都成立；manifest floor 不被 auto 放行、被显式规则放行。
- **后端**：OpenCode 通用 shim 全链跑通；ACP `mcpServers` 注入后能看到并调用插件工具。
- **浏览器**：navigate/snapshot/click/screenshot；session 结束清理；service 重启接管；面板 SSE 断线重连。
- **回归**：现有 `dev_*`、MCP add、extension 路由、policy 测试全部保持通过；无 shell 的 OpenCode 不受 shim 影响。

---

修订后的关键变化：ABI 收敛到 host API（MCP 降为 ACP 传输），v1 砍掉子进程/自定义协议/授权 UI，UI 改为类型化贡献，补上了 dev-process 证明存在但原方案没盖的 `hooks` 贡献面。复审后修正的工具链细节：`/plugins/tools` 与会话解耦（shim 加载时无 session）、`call_id` 进 execute body 并有回退 join、`guards`/`timeout_ms`/`signal` 补齐了“宿主中介”与取消的真实落点、policy 从 M0 起就在执行路径上。
