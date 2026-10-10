# OpenCode 第一公民：P0 路线图

**目标：** 在界面、交互和功能细节上，让 agent-strata 桌面版可以替代 OpenCode 官方 Desktop（2.0.x），同时保留 strata 作为跨后端会话层的定位和已有优势。

**这份文档是什么：** P0 的拆分与顺序。每个子项单独写一份可执行的实施计划（`docs/superpowers/plans/` 下），做完一个再写下一个，因为后一个要建立在前一个落地后的代码上。第一份已写好：[`2026-10-10-opencode-live-streaming.md`](./2026-10-10-opencode-live-streaming.md)。

---

## 现状（2026-10-10 核实）

- 本机 `opencode serve` 为 1.18.32，SDK 为 `@opencode-ai/sdk` 1.18.35。服务端 OpenAPI 约 190 个端点，strata 用到约 16 个：`session.get/list/create/update/delete/messages/promptAsync/abort`、`provider.list`、`app.agents`、`project.list`、`permission.reply`、`question.reply/reject`、`event.subscribe`、`global.event`。
- 实测流式（同一条回复，同时监听两端）：OpenCode 在约 2 秒内推送了 22 个 `message.part.delta`；strata 推给界面的流式快照文本长度从 0 直接跳到 1408。adapter 完全没处理 `message.part.delta`，回复是整段出现的。
- 同一次实测里，新建的会话在生成过程中被 strata 整体重建（`session.rebuilt`）：实时见到的会话在库里 `mapper` 为空，被 `/sync` 当成旧映射，侧栏每 12 秒同步一次就重建一次。
- 生成中每个持久事件都让会话页整份重拉 view；最大会话的 view 为 6.8MB，其中最后 3 轮约 47KB，`files_changed` 约 785KB。
- 子会话被过滤：`parentID` 非空的会话在 list、index、sync 三处都被跳过，`task` 工具无法进入子代理会话。
- 权限只有允许/拒绝两档，卡片显示原始 JSON；`prompt` 只发文本 part；没有 `/` 命令、`@` 文件、附件。
- 内嵌 opencode 需要 `STRATA_OPENCODE_EMBED=1`，端口固定 4096，没有密码，工作目录是编译时的 `repo_root()`，在用户机器上不存在。

## 架构决定：两个平面

strata 的读路径（CASF 事件 → store → projector → view）只承载**会话记录**。OpenCode 专属的**工作区与配置能力**走另一个平面，不进事件库。

| 平面 | 装什么 | 怎么走 |
| --- | --- | --- |
| 会话记录 | 对话、工具调用与结果、文件改动、权限与提问、计划、会话元数据（含父子关系、撤回点） | adapter 映射成 CASF → store → projector → `/sessions/:id/view` |
| 命令平面 | 改变会话的动作：发送、中止、撤回、分叉、压缩、执行命令、分享 | `BackendDriver` 方法 → service 路由；结果经 adapter 回到会话记录 |
| 扩展平面 | 不属于会话记录的实时状态和后端配置：文件树与内容、文件/符号搜索、命令列表、VCS/diff、终端（PTY）、LSP/MCP/formatter 状态、Provider 认证、配置 | `BackendDriver.extension`（按后端类型）→ service `/connections/:id/<backend>/*` 白名单透传 → UI 按 `capabilities` 显隐 |

判断规则：**回放一个月前的会话时还需要它吗？** 需要 → 会话记录；只在"现在、这台机器上"有意义 → 扩展平面。ACP 后端只实现它能做的部分，UI 隐藏其余。

## P0 子计划（按顺序）

### 1. 实时流式与刷新 —— 已写详细计划

- 计划：`2026-10-10-opencode-live-streaming.md`
- 内容：
  - 消费 `message.part.delta`
  - 快照节流从 150ms 降到 50ms，并在增量停下时补发最后一帧
  - 实时见到的会话记下 mapper 版本，不再被 `/sync` 重建
  - 会话页在生成中只拉最后几轮（`?tail=`）
  - 侧栏不再每个事件都去问 OpenCode 的项目列表
- 验收：`scripts/probe-stream.ts` 对同一条回复报告不少于 10 个流式快照、文本长度单调不减、生成期间没有 `session.rebuilt`。

### 2. 扩展平面骨架

- `BackendDriver` 增加 `extension?: { kind: "opencode"; request(path: string, init?: RequestInit & { directory?: string }): Promise<Response> }`，由 opencode 驱动用同一套 baseUrl、Basic 鉴权和 `directory` 参数实现。
- service 增加 `/connections/:id/opencode/*`，只放行白名单路径（第一批：`/find/file`、`/find`、`/file`、`/file/content`、`/file/status`、`/command`、`/vcs`、`/vcs/diff`、`/lsp`、`/mcp`、`/path`、`/agent`、`/skill`），其余返回 404；ACP 连接返回 404。
- UI 增加按连接调用的 client 和 `capabilities.extension` 判断。
- 验收：在 UI 里能列出当前连接的命令、按名字搜索文件；断开连接或换成 ACP 时这些入口消失。

### 3. 输入框

- `@` 文件补全（`find.files`），选中后作为 file part 附带。
- `/` 命令：`command.list` 出菜单，执行走新命令平面方法 `command(nativeId, name, args, opts)` → `session.command`。
- 粘贴、拖拽图片和文件：转成 file part（data URL + mime）。
- Tab 在主智能体之间切换（build/plan），和官方一致。
- 命令平面：`prompt(nativeId, parts, opts)` 接受 part 数组，替换现在的纯文本参数。
- 会话记录：确认 adapter 把 `image/*` 的 FilePart 映射为 `image` 块而不是 `file_ref`。
- 验收：
  - `@` 一个文件后发送，模型读到该文件
  - `/init` 等内置命令能执行
  - 粘贴截图后用户气泡里显示缩略图

### 4. 权限与提问 —— 已写详细计划

- 计划：`2026-10-11-opencode-permissions.md`
- 三档回复：一次、始终（OpenCode `reply: "always"`）、拒绝；strata 策略仍然先于用户询问执行。
- 按工具渲染权限卡片：bash 显示命令；edit/write 显示 diff（权限 metadata 里带）；webfetch 显示 URL；其余回退到 `JsonView`。
- `/sessions` 增加 `needs_input`（有待处理的权限或提问），侧栏用明显的标记显示，窗口标题带计数。
- 验收：一个需要批准的 bash 调用在侧栏可见；点"始终"后同类调用不再询问。

### 5. 子会话 —— 已写详细计划

- 计划：`2026-10-11-opencode-child-sessions.md`
- adapter 不再丢弃有 `parentID` 的会话；侧栏默认只列根会话。
- `task` 工具卡片显示子会话标题与状态，点击进入；子会话页头显示面包屑，可以返回父会话。
- 会话记录：从 task 工具的 `state.metadata.sessionId` 取子会话 id，写进 `tool.call`/`tool.result`（schema 增加可选字段 `child_session_id`），并提升 `OPENCODE_MAPPER_VERSION`。
- 验收：一个调用了子代理的会话，能从父会话点进子会话，再回来。

### 6. 消息操作 —— 已写详细计划

- 计划：`2026-10-11-opencode-message-actions.md`
- 撤回/恢复（`session.revert`/`unrevert`）：会话记录里 `session.updated` 增加 `revert?: { turn_id: string } | null`，projector 标记撤回点之后的轮次，UI 灰显并提供"恢复"。
- 从某条消息分叉（`session.fork`），完成后跳到新会话。
- 压缩（`session.summarize`）：CompactionPart 映射为转录里的分隔标记。
- 复制消息；编辑后重发（等于撤回到该消息再发送新文本，与官方行为一致）。
- 验收：撤回最后一轮后文件改动回滚、轮次灰显；恢复后复原。

### 7. 内嵌 opencode 生命周期

- Tauri shell 默认启动内嵌 `opencode serve`：挑一个空闲端口，生成随机 `OPENCODE_SERVER_PASSWORD`，通过 `STRATA_OPENCODE_URL/USERNAME/PASSWORD` 交给 service；工作目录用用户主目录。
- 健康检查，崩溃后按退避重启；退出时结束进程。
- 找不到 `opencode` 时，UI 给出安装指引；设置页可以切换"内嵌"或"连接外部服务"。
- 这一项和 2–6 互不依赖，可以并行。
- 验收：在一台只装了 opencode 的干净机器上，安装包打开即可用，不需要设置任何环境变量。

## P0 之后（各自单独立项）

- **工作台：**
  - Review 面板：会话级和上一轮改动（`session.diff`），git 和分支改动（`vcs.diff`）；并排/统一视图；行内评论回填输入框
  - 文件树与查看器，"在 VS Code / Cursor 中打开"
  - 集成终端：`pty` + websocket，xterm.js，多标签
  - 状态栏：git 分支、LSP/MCP 状态
- **应用：**
  - 系统通知与提示音
  - 命令面板（Ctrl+K）和完整的快捷键体系
  - 多会话快速切换
  - 防休眠
  - 自动更新
  - macOS/Linux 构建
- **配置：**
  - Provider 接入（API key / OAuth）
  - MCP 管理
  - 配置编辑
  - 分享
  - worktree 管理

## 要保留的差异化

长会话虚拟滚动与会话内/跨会话全文搜索、回放与 trace、策略引擎、会话对比与导出、ACP 多后端、中文优先。追平官方的过程中不弱化这些。
