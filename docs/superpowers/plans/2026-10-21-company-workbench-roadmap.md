# 公司内部工作台路线图

**日期：** 2026-10-21
**目标：** 让 agent-strata 成为公司内部使用 OpenCode 时的默认桌面端。不是再做一个聊天壳，而是把“装上、用顺、交付、可管”这四件事做完整。
**边界：** 公司只允许 OpenCode。ACP 多后端、远程 relay、移动端不作为这一阶段的投入方向；能力可以保留，但默认不暴露给普通用户。

## 已确认的约束

- **不捆绑 opencode sidecar。** 运行时是用户机器上的 `opencode`，由公司/个人安装和升级。应用负责发现、配置、版本探测、健康检查和清晰的失败指引，不负责分发二进制。
- **Provider 由服务端下发。** 凭据和 provider 列表来自上层 OpenCode 配置；应用不复制、不接管。公司内多个部门的 provider 会混在同一份列表里，应用需要能只显示其中一部分。
- **权限统一下发短期不做。** 如果将来有，也更可能落在上层 OpenCode 的设置里。strata 现在只保留 `PolicySource` 这个 seam，不新建一套中心化权限系统，也不覆盖 OpenCode 自己的 permission 配置。
- **公司网络是常态。** 代理、自定义 CA、内部模型网关、离线/无 models.dev 都可能出现；这些必须能配置，并且能诊断。
- **默认无遥测。** 日志、导出、分享都必须先过脱敏；hosted share 默认不作为公司内可用能力。

## 产品原则

1. **先让现有用户更顺，再让新用户能装，最后做深工作流。**
2. **事件日志是护城河。** 回放、对比、成本、审计都从同一份 CASF 记录长出来；不要为单个面板复制状态。
3. **能力缺失要可见。** 不能出现“按钮在、点了没反应”或“看起来能发、发出去 400”的状态。
4. **每个功能都要能在没有网络和没有 LLM 的情况下测试。** 纯函数优先，组件只做接线。

## P0：运行时可控（不捆绑 sidecar）

- 发现顺序：显式配置路径 → `PATH` → 平台常见目录。Windows 同时尝试 `opencode`、`opencode.exe`、`opencode.cmd`、`opencode.bat`、`opencode.ps1`；macOS 保留 Homebrew/bun 回退。
- 配置入口：设置页显示当前使用的路径，允许选择/清除自定义路径；保存后提示“重启应用生效”。
- 版本探测：启动时运行 `opencode --version`，把 binary、version、检查时间和错误写进运行时状态；服务通过 `GET /desktop/opencode` 暴露。
- 健康检查：状态页显示 模式（内嵌/外部）、进程状态、版本、server URL、最近一次检查；失败时给出“未找到 / 版本不兼容 / 端口被占用 / server 无响应”的具体下一步。
- Doctor：一条可复制的诊断摘要（版本、路径、连接、代理、provider、MCP/LSP、日志位置）。不做自动修复。
- **不做：** 随包分发 opencode；自动升级 opencode；修改用户的全局 `opencode.json`。

**验收：** 在只装了 opencode 的干净机器上，内嵌模式能起来；把 `opencode` 换成 `opencode.cmd`（Windows）或自定义路径后，设置页能指出实际使用的二进制；缺失时页面给安装指引，而不是一个空窗口。

## P0：Provider 可见性

- 设置页每个 provider 行增加“在模型选择中显示/隐藏”开关；隐藏只影响 UI，不改变凭据、不改变 OpenCode 可用性。
- 模型选择器只列可见 provider 的模型；当前会话正在用的模型即使被隐藏也保留在列表顶部，标为“已隐藏”，避免静默切模型。
- 提供“全部显示”恢复入口；隐藏集合按机器保存（localStorage），后续可以换成服务端下发的只读列表。
- **不做：** 修改 OpenCode 的 `enabled_providers`/`disabled_providers`；不把隐藏当成权限控制。

**验收：** 隐藏一个 provider 后，厂商页仍有它并可恢复；模型选择器不再出现它的模型；已有会话仍能用原模型发送。

## P1：等待与落地（每天都会踩）

- 审批/提问通知：`needs_input` 变化时发系统通知 + 提示音，点击聚焦对应会话；托盘/窗口标题已有计数，补上可点击入口。
- 全局搜索命中落地：`CommandPalette` 的 transcript 命中把 session 和事件位置带到会话页，直接跳到匹配 turn，而不是只打开会话。
- 会话生命周期：归档视图、恢复、删除确认；`/sessions` 支持分页或提高上限，避免第 201 个会话消失；归档会话不计入 usage/questions。
- 断线状态：composer 在 backend 不可用时换成“重连 / 交接”CTA，不允许看起来可写。
- 空会话上手：项目、分支、AGENTS.md 是否存在、provider/model 就绪、最近会话、推荐动作（`/init`、读 README、跑测试）。
- 窄窗口：右栏在 <1100px 改 overlay；侧栏可折叠；头部低频操作收进“更多”。

## P1：公司网络与分享闸门

- 代理/CA：设置页可填 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`NODE_EXTRA_CA_CERTS`，注入内嵌 opencode 子进程；提供“测试连接”。
- 内部网关：支持 OpenAI 兼容 base URL、模型白名单、连接测试；优先读取上层 OpenCode 已下发的 provider，不重复实现一套凭据管理。
- 分享闸门：`/share` 默认禁用或明确提示“会把会话发到 OpenCode 托管服务”；公司内用脱敏 export/handoff 替代。
- 权限 seam：`GET /policy` 增加 `source`（local / managed / none）和 `read_only`；UI 能显示“由公司管理”。不实现中心化下发。

## P2：交付闭环

- Review：diff 行评论可持久化、批量发送为一条 prompt；生成 commit message；stage/commit。
- 成本：项目/日预算、阈值告警、CSV/chargeback；子代理成本计入。
- 仓库上手：检测项目、预览/生成 AGENTS.md、按仓库默认模型/agent/policy、`/init` 引导。
- 审计：按用户/项目/时间导出脱敏后的决策与工具调用；OTel/CSV 作为后续。

## P3：并行与团队

- 每个会话一个 git worktree，带 setup/cleanup hook；并行 agent 不互相踩。
- 团队交接包：脱敏 CASF/HTML、只读打开、评论；替代 hosted share。
- 代码签名、macOS 公证、Windows MSI/portable、内部更新通道。

## 明确不做

- 自带 opencode 二进制或自动升级它。
- 复制 OpenCode 的 provider 配置、权限配置或凭据。
- 远程 relay / 手机端 / 多设备接力（OpenChamber 的定位，不是我们的办公场景）。
- 在短期里做中心化权限下发。

## 进度

- **2026-10-21：** Provider 可见性已落地。设置页每个厂商行有“在模型选择中显示/隐藏”的开关，模型选择器按可见厂商过滤，当前会话正在用的隐藏模型仍保留在列表顶部并标注“已隐藏”。隐藏集合存在本机 localStorage，不改变凭据和 OpenCode 配置。`provider-visibility.test.ts` 覆盖存储、过滤和当前模型保留。
- **2026-10-21：** 运行时配置与健康检查已落地。运行时面板收成一张紧凑卡片：默认只显示版本、来源、二进制路径和三个动作，状态用圆点表示，服务地址只留在诊断信息里。内嵌启动会先清理上一次留下的 opencode（`opencode.pid`，以及仍占着上次端口的 `opencode serve`），复用上次端口而不是再开一个。侧栏的连接徽标加了 600ms 稳定期，避免同步期间端口号出现又消失。发现顺序为设置路径 → `STRATA_OPENCODE_BIN` → PATH → 官方/Homebrew/bun 目录；Windows 同时尝试 `.exe/.cmd/.bat/.ps1`，`.cmd/.bat` 经 `cmd /C`、`.ps1` 经 `powershell -File` 启动。启动时写 `opencode-runtime.json`（来源、路径、版本、错误、检查时间），`GET /desktop/opencode` 一并返回；设置页显示运行时并在桌面应用内支持选择/清除路径、重新检测和复制诊断。不做 sidecar、不自动升级 opencode。`cargo test` 与 `bun test` 覆盖新的发现、版本读取和状态读写。
- **2026-10-22：** 数据维护第一版。事件在 schema 里按“可重建 / 仅本地记录”分类，维护页显示文件与内容体积、完整性、WAL/FTS 优化、压缩、`VACUUM INTO` 备份、手工 `.bak` 清理，以及按天/仅归档预览的“清理可重建缓存”。清理只删可重建事件，权限、提问、状态、目标和计划保留；归档会话放在侧栏顶部（搜索/概览下方）的折叠区，支持恢复和删除；删除会先取 `/sessions/:id/data` 的“仅本地记录”数量，后端可管理时同时删后端和本地，否则只删本地（`?local=1`）。维护页只保留存储、完整性/优化/压缩/备份/旧快照和可重建缓存清理，不再承载归档。`/sessions` 支持 `limit` 与 `more`，侧栏可继续加载。尚未做“彻底删除会话/保留期自动清理/后端数据目录管理”。
- **2026-10-22（等待与落地）：** 权限/提问出现时，后台窗口会收到系统通知并可用点击回到会话；完成通知也带上了会话跳转。全局搜索的 transcript 命中不再只打开会话、落在末尾：它把查询交给会话页，打开页内搜索并跳到第一条可定位的命中（tool.result 通过 call_id 反查回合）。
- **2026-10-22（会话细节）：** 后端断开时输入区显示提示、发送键禁用且 Enter 不再丢草稿；空会话给出三条可一键填入的起步提示（解释项目 / 未提交改动 / 跑测试），并保留 @、/、Shift+Enter；空项目只留一行标题和常显的“新建会话 +”，去掉占位的“还没有会话”，长列表不再被空项目撑开。
- **2026-10-22（OpenCode doctor）：** 运行时卡新增“重启”和“日志”。启动器收到重启请求后杀掉当前子进程，在同一个 plan 上重新拉起；页面轮询状态而不是假装成功。日志按钮打开 shell 与内嵌 OpenCode 共用的 `service.log`；复制诊断沿用原有入口。
- **2026-10-22（日志）：** `service.log` 的 shell 启动标记、service/OpenCode 的 stdout/stderr 现在统一经过一个带本地时间戳的写入器，行不会互相穿插；端口已被占用、遗留进程清理、找不到二进制和启动失败也会写明原因，不再只有一行空的 shell starting。
