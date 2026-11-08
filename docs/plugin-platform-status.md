# 插件化平台：落地状态

> 这份文件跟着 `plugin-platform.md` 走，但只记**做完的东西和它跟方案不一样的地方**。
> 方案说什么、为什么，看那份；这里回答"现在代码里到底有什么、怎么验"。

## 一句话

M0–M3 全部落地并通过检查（typecheck / lint / 包测试 / UI 测试 / cargo 测试）。侧车已实测能编译、启动、并在编译产物里跑通三个插件的工具。

方案里 M0–M3 的**验收条目**逐条都有对应用例，不只是"功能跑通了"：

| 验收条目 | 用例 |
| --- | --- |
| `dev_*` 行为不变、拦截与 GUIDANCE 不变 | `dev-service.test.ts`（policy/ask/workdir/port/restart 全量迁到新路由） |
| echo = 一个包 + 一行注册 | `plugin-echo` + `builtin.ts` 两行；`plugins.test.ts` 用它跑遍所有贡献面 |
| 无 service 的 OpenCode 不受影响 | `shim.test.ts`「registers no tools and stands out of the way」 |
| `deny`/`ask`/auto 对插件工具生效 | `plugins.test.ts` + `dev-service.test.ts` |
| `plugin_id` 进 `evaluate` | `policy.test.ts`「a rule can name a plugin」+ `plugins.test.ts`「a policy rule can be scoped to a plugin」 |
| manifest `ask` 不被 auto 放行、能被显式规则放行 | `plugins.test.ts`（`echo_risky` 两个方向） |
| ACP 会话能看到并调用插件工具 | `acp-plugins.test.ts`（fixture 回显 `session/new` 收到的 MCP server，再真调一次） |
| echo 经 shim 与 MCP 双路跑通 | `shim.test.ts` + `acp-plugins.test.ts` |
| browser__* 完成 navigate/snapshot/click/screenshot | `plugin-browser.test.ts` + `packages/plugin-browser` |
| session 结束清理 tab | `browser-lifecycle.test.ts` |
| service 重启接管已有 Chrome | `packages/plugin-browser`「a second manager adopts a window a crash left running」 |
| 不修改 `KINDS` 也能显示 `browser_*` | `plugin-registry.test.ts` + `transcript-format.ts` 的插件优先 |
| 面板关闭/崩溃不影响主界面 | `plugin-panel.tsx` 的 fallback + `plugin-registry` 失败保留旧值 |

```
bun run typecheck     # 15 projects
bun run lint          # 0 warnings
bun test packages     # 730 tests
bun run test:ui       # 1157 tests
cargo test --locked   # 70 tests (apps/desktop/src-tauri)
bun run sidecar       # 64.7 MB, includes every builtin plugin
```

## 代码落点

| 方案里的位置 | 实际文件 |
| --- | --- |
| `packages/plugin-sdk` | `src/index.ts`（manifest zod + `StrataPlugin` + 名字拆分）、`src/version.ts`（`engines.strata` 区间） |
| `packages/service/src/plugins/` | `host.ts`（registry/生命周期/guards/timeout/hooks）、`routes.ts`（HTTP 面）、`call.ts`（请求解析）、`builtin.ts`（一行一个）、`mcp.ts`（ACP 的 MCP 面）、`tickets.ts`（per-session endpoint） |
| `packages/plugin-dev-process` | `src/index.ts`（manifest + 工具 + 面板路由）、`src/dev-process.ts`（原管理器整体搬入）、`src/guidance.ts`（GUIDANCE + `detaches`） |
| `packages/plugin-browser` | `src/index.ts`（15 个工具 + 资源 + panel 路由）、`src/manager.ts`（BrowserManager）、`src/cdp.ts`（自写 CDP 客户端）、`src/snapshot.ts`（页面内快照/动作表达式） |
| `packages/plugin-echo` | 参考插件：每类贡献各一份，用来证明"一个包 + 一行" |
| `plugins/strata-shim.ts` | 唯一安装的 OpenCode 插件（取代 `dev-process.ts`） |
| UI | `plugin-registry.ts`（渲染器/面板注册表）、`plugin-panel.tsx`（typed panel）、`plugin-progress.ts`（`tool.progress` join） |

## 与方案的偏差（都记了原因）

1. **浏览器不用 Playwright，自己讲 CDP。** 方案 §8 的预案是"进不了产物就上子进程"。实测是 `bun build --compile` 直接失败在 `chromium-bidi`/`electron`（1.55、1.64 都一样）。子进程会把 MCP 协议面提前到 M2，代价比自写客户端大得多：CDP 是 JSON over WebSocket，Bun 自带 WebSocket。`cdp.ts` ~300 行，打包体积 65MB。
   - 保留：持久 profile、重启接管、多 tab、ref 快照、截图、console/pageerror/failed request、panel 的 trusted input。
   - 放弃：Playwright 的自动等待与选择器引擎。动作前会先用 ref 找元素、滚动到可见，找不到就报错——本来也要求每次动作后重新快照。

2. **`browser_navigate` 的 manifest floor 是 `allow`。** 方案 §5.2 写的是 `ask`，但 floor 对"不再询问"（auto stance）是不可抬升的，结果是读者每打开一个页面就被问一次——而这正是他们打开那个开关的原因。导航是这个能力的主路径，不是需要逐次确认的 `eval` 一类动作；把关交给 policy 文档、`net` guard，以及"没有策略时默认 ask"。`browser_eval` / `browser_attach` 保持 `ask`。

3. **浏览器默认 headless、页面尺寸跟随右栏。** 原方案 §5.3 只说"面板是 `screencast` 类型化贡献"，没说浏览器窗口本身该不该可见；照字面实现成可见窗口是过度解读，且和面板重复。现在窗口是纯实现细节。代价：需要人工登录的站点要靠 `STRATA_BROWSER_PROFILE` 预先准备 profile。

3. **`dev` 插件的 manifest `policy.default` 是 `allow`，不是 `ask`。** 方案 §5.2 写着 `dev_start` 默认 `ask`。按方案的合并语义（显式规则 > manifest floor > 其余），`ask` floor 会把**读者已经写 allow 规则**的命令也压回 ask，这与"读者显式规则仍生效"矛盾。真正的语义由 policy 引擎承担：`dev_start` 在 `SHELL_TOOLS` 里，命令照样被拆段分析，引擎的 floor 照样 ask。floor 只该"对没人表态的工具提高下限"，`echo_risky` 是它的测试用例。

4. **`Decision` 加了 `overridable`，没有加 `source`；规则多了 `plugin_id`。** 方案说"`rule_id` 的存在与否就是 provenance"。这对"是否命中规则"成立，但区分不了"文档 default 说了 allow"和"文档什么都没说所以默认 allow"——而 floor 只需要在后者生效。`overridable: true` 标在 default / 引擎 floor / auto stance 上，`floorDecision()` 只在它上面加严。

5. **`/plugins/mcp` 的 session 用 ticket，不是 session id。** agent 手里拿着这个 URL，里面要是能写 session id，就等于给了它"以任意 session 调工具"的能力。ticket 由 service 侧铸造、绑一个 casf session、随 session 关闭失效。

6. **`SessionEnded` 之外的 lifecycle 钩子。** SDK 多了 `sessionEnded` 和 `releaseDirectory`：dev 的命令要跟着 session 清，Chrome 里占着要删的目录的 tab 要让路。方案里这两件事写在 §5.1 的"生命周期语义"里，但没有对应的接口位。

## 用户可见行为

- 右栏多了插件面板 tab（browser 的 screencast）。帧走 `/plugins/browser/events`，指针/滚轮/键盘走 `/plugins/browser/panel/input`，坐标是**比例**不是像素。
- **画面是两路合成的**，这是和官方做法对齐后的结论：
  - **动**用 `Page.startScreencast`。Chrome 每次绘制推一帧（实测本机 ~58fps），service **逐帧立刻 ack**（协议上 ack 就是流控，排队 ack 会让流停在一帧），再按面板的 12fps 节流后才转发。协议只能输出页面 CSS 尺寸的图（`maxWidth/maxHeight` 只能缩不能放大，`deviceScaleFactor` 对它无效），所以流帧是"看得见动作"，不是"读得清小字"。
  - **静**时补一张 `Page.captureScreenshot`，按面板 `devicePixelRatio`（限 2）出图，停在最后一次绘制后 220ms 发。实测：面板 700×900、2x → 流帧 700×900（约 20KB），静止帧 1400×1800（约 180KB）。
  - 这样滚动/打字不再像幻灯片（原来 3fps 定时截图），停下时又是清晰的一帧，成本是每次静止一张截图而不是每帧一张。
- **浏览器是 headless 的，页面只活在右栏里。** 一开始做成可见窗口是错的：面板和窗口显示同一个页面，等于让读者看两个地方。现在启动固定带 `--headless=new`，面板把自身 CSS 尺寸（`ResizeObserver`）报给 service，service 用 `Emulation.setDeviceMetricsOverride` 把页面**按面板宽度重新排版**——不是把 1280 宽的页面缩小，所以字号是真实浏览器在窄栏里的大小。面板变化（拖右栏、改窗口）会重新协商，帧随之重启。
- 登录态靠**持久 profile**（`<data>/browser-profile`）。headless 下没法人工在那个窗口里登录，所以 `STRATA_BROWSER_PROFILE` 可以指向一个你手动登录过的 profile 目录。
- 工具行能显示 `tool.progress`（百分比或一句消息），结束即清。
- 工具渲染：manifest 的 `ui.toolRenderers` 生效，未声明的一律回落到 `wrench`（插件工具用 `fork` 标记"这不是内置的"）。
- dev 的 `/dev*` 路由**移到了** `/plugins/dev/processes*`，UI 已同步；旧的 `/dev` 不再存在。

## 验证方式

```bash
# 平台本身
bun test packages/service/test/plugins.test.ts           # 注册/生命周期/工具/资源/events/hooks/floor/guards
bun test packages/service/test/shim.test.ts              # 通用 shim：无 service 全惰性、有则纯转发
bun test packages/service/test/acp-plugins.test.ts       # ACP session 拿到 MCP endpoint，能列能调
bun test packages/service/test/plugin-progress.test.ts   # 内存事件、abort、timeout
bun test packages/service/test/progress-stream.test.ts   # progress 真的到 /stream，且不进 store
bun test packages/service/test/plugin-browser.test.ts    # browser_* 过 service（真的开 Chrome，headless）
bun test packages/service/test/browser-lifecycle.test.ts # session 结束/disable/正常关闭的清理
bun test packages/plugin-browser                         # manager 对真 Chrome，含崩溃后接管
bun test packages/plugin-sdk                             # manifest 与版本区间

# 编译产物里的真实链路（手动）
bun run sidecar
STRATA_PORT=7791 ./apps/desktop/src-tauri/binaries/strata-service-* &
curl -s localhost:7791/plugins | jq -r '.plugins[] | "\(.id) \(.state)"'
```

## 检视意见的处理（第二轮）

审阅提出的 3 个严重问题 + 4 个次要问题，全部确认属实并修复；每条都有能失败的用例。

| # | 问题 | 修法 | 用例 |
| --- | --- | --- | --- |
| 1 | `/plugins/mcp` 在带 token 的桌面环境全部 401 | 该路径改为**凭 ticket 授权**（URL 即凭证），ticket 不认时由 route 回 403 | `acp-plugins.test.ts`「the MCP endpoint when the service has a token」（带 `apiToken`，无 header 调通；去掉修复即红） |
| 2 | net guard 比插件契约严，`localhost:3000` 打不开 | URL 解析收进 SDK `parseHttpUrl`，host 与插件共用一套归一化 | `plugin-sdk` 单测 + `plugin-browser.test.ts`「a bare host:port passes the guard」 |
| 3 | echo 参考插件随产品出厂 | 从 `builtinPlugins` 移除，测试通过 `ServiceOpts.plugins` 注册 | `plugins.test.ts`「what a fresh install ships」（只有 dev + browser） |
| 4 | `tool.progress` 缺 fallback join；shim 读 `context.callID` 而非 `context.id` | host 在派发前用 session 的待决 `tool.call` 补齐 join 键；shim 两个字段都读 | `progress-join.test.ts` 三条（fallback / 显式优先 / 无待决不丢） |
| 5 | 旧握手文件 `strata-dev-process.json` 不清理 | Rust `RETIRED_HANDSHAKES` 在安装时删除（里面存着上一轮的 token） | `plugin_install.rs` 安装用例断言旧文件消失 |
| 6 | `evaluate` 的非字符串 command 分支丢 `plugin_id` | 该分支补传 | `policy.test.ts`「plugin_id survives every branch」 |
| 7 | `toolKind` 注释与实现相反；两个死接口 | 注释改为描述真实顺序，并写明不变量由 manifest 校验保证；删掉 `usePluginRegistry`、`PluginRouteDeps.policyFor` | typecheck + lint |

第三轮（真机反馈）：右栏 Browser tab 一直是"等待插件画面"。

原因是 `screencast` 在没有 tab 时直接返回，**而且不装定时器**：读者在 agent 还没导航前就点开 Browser tab 是常态，那一次 cast 就此放弃，之后没有任何东西再启动它。修法：cast 在没有页面时保持运行，`shoot` 等页面出现再拍；面板路由的 session 也走 `ctx.resolveSession`，避免面板和工具调用用两种写法命名同一个会话。用例：`plugin-browser.test.ts`「a panel opened before the agent navigates still gets its first frame」（HTTP 全程：cast → SSE → navigate → 等帧）。

顺带发现并修的一个洞（#2 的延伸）：`file:/etc/passwd` 只写一个斜杠时，旧的"只有 `//` 才算 scheme"规则把它读成主机 `file`，会真的去网络请求。现在冒号后不是端口数字就按 scheme 处理并拒绝。

### 第四轮检视（外部）

| # | 问题 | 结论 | 修法 / 用例 |
| --- | --- | --- | --- |
| 1 | `hooks.beforeTool: ["shell"]` 永远不触发 | **属实，且旧 `dev-process.ts` 就有**。本机 1.18.30 二进制里只注册 `bash` 和 `powershell` | 声明改成 `SHELL_TOOL_IDS`（bash / powershell / shell / execute / terminal），`beforeToolCall` 用同一集合；用例 `plugins.test.ts`「the shell guard names the tools that exist」（去掉修复即红） |
| 1b | （由此暴露）policy 的 `SHELL_TOOLS` 没有 `powershell` | 属实，Windows 上所有命令都跳过了 shell 分析 | 加入 `SHELL_TOOLS`；用例 `policy.test.ts`「a command that arrives as powershell」 |
| 2 | `mcp` 没被当作保留 id | 属实，会造成"半影子"插件 | `PluginId` refine 排除 `mcp`；用例在 manifest validation |
| 3 | `manifest.test.ts` 偶发失败 | 12 次单独重跑未复现，判断为旧转译缓存 | 未改代码，记录在案 |
| 4a | `toolTable()` 每次 dispatch 全量重建，且一个插件抛异常拖垮全表 | 属实 | 按插件缓存（生命周期变化时失效）+ per-plugin try/catch；用例 `plugins.test.ts`「one broken plugin does not take the table with it」 |
| 4b | events 的 session 过滤语义（未声明 session = 全局） | 属实的语义说明 | 在过滤处写明，不改行为 |

### 右栏真的能用了（第五轮）

- **键盘。** 面板的帧区可获得焦点，按键走 `Input.dispatchKeyEvent`，带修饰键位（alt 1 / ctrl 2 / meta 4 / shift 8），所以 ctrl+a、ctrl+click 这类是它们本来该是的样子。
- **文本与输入法。** 帧上叠一个透明 `<textarea>`：canvas 收不到文本也收不到 IME，真输入框可以。每次插入整段转发（`Input.insertText`），中文一次组合完成是一整串，不是那串按键。
- **拖拽。** 指针按下/移动/抬起分成三条消息，移动时带 `buttons`，页面才知道手势还在进行——否则每次拖拽都读成"悬停后取消"。
- **地址栏只读。** 右上角显示页面地址（只读字段，可选中复制），**不能改**：导航归 agent，读者自己跳转会让 agent 在看的页面和读者看的不是同一个。旁边的按钮是重连帧流，不是刷新页面。

## 没做的

- **M4**：`entry.kind: "process"`、`~/.agent-strata/plugins/` 扫描、scoped token、安装授权 UI、`iframe` panel kind。契约里的位置都留着（`entry` 是 discriminated union，`McpServer` 的传输面已具备）。
- **OpenCode v2 shim 分支**：方案 §4.5 的"v2 变体（预留）"没有写。v2 的插件 API 未发布，写一个猜的适配层只会变成要维护的猜测。`strata-shim.ts` 里留了探测点。
- **`tool.progress` 的最后一跳**：插件 emit → 宿主 → `/stream` → UI 的 store → 行内文本，前四段都有自动化用例（`progress-stream.test.ts` + `plugin-progress.test.ts`）；缺的是"行内真的渲染出百分比"那一段 DOM 断言，因为 `test:ui` 没有挂载整套 transcript 的 harness。
- **面板的进一步交互**：现在有 click / wheel / 键，没有文本输入法（IME）、拖拽、右键菜单。中文输入要走 `Input.insertText`，但面板目前只发 `key`。
- **`component` / `logs` panel kind**：`logs` 有 `DataPanel` 实现但 browser 用不到；`component` 只留了类型，没有编译期注册表。
