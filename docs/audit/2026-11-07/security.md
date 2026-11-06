# 维度 C · 安全边界

> 策略引擎是 advisory 静态分析，不是 sandbox；这一点在 README 与代码注释里都写明。本报告按这个前提评估“绕过护栏”和“信任边界”风险。

## 信任边界总览

| # | 边界 | 入口 | 主要控制 | 结论 |
|---|---|---|---|---|
| 1 | 页面 ↔ service | HTTP/SSE/WS | loopback bind、Host/Origin、capability token、CORS、请求体校验 | 强；补 body 上限即可 |
| 2 | service ↔ 后端 | OpenCode HTTP、ACP stdio | Basic auth/凭据文件 600、扩展读取 allow-list、超时 | 强；远程 http 需 TLS 约束 |
| 3 | agent ↔ 文件/命令 | shell、policy、dev 进程、reveal | 路径 canonicalize/根约束、shell 分词、进程组回收、策略规则 | 有明确 bypass：`dev_start` |
| 4 | 模型输出 ↔ 渲染 | Markdown/HTML、Mermaid、图片、HTML 预览 | DOMPurify + FORBID_TAGS/ATTR、Mermaid strict、sandbox iframe、外链委托 | 设计正确；受 DOMPurify advisory 影响 |
| 5 | 凭据 | token、provider keys、connections | 600 文件、token 不落响应、handshake 600 | 强；`desktop.json` 模式需澄清 |

## 边界 1：页面 ↔ service

**做得好的部分**

- 只监听 `127.0.0.1`（`packages/service/src/index.ts:2578`）。
- Host/Origin 拒绝 DNS rebinding 与跨站请求（`shell-origin.ts:35`；`index.ts:2593`）。
- 每个请求（除 `/health`）要求 capability token；SSE/WS 支持 query token（`index.ts:2613`、`api-token.ts:50`）。
- CORS 只回显 shell 允许的 origin；有 `vary: origin`、`nosniff`。
- 路由对高风险参数做类型与范围检查（session id、port、wait_ms、command、model 等）。

**缺口**

- 没有请求体大小上限（C4）；大 JSON 在 `req.json()` 阶段就能占满内存。
- 没有速率限制；本地 token 持有者可以造成资源耗尽。桌面场景可接受，但值得记录。

## 边界 2：service ↔ 后端

**做得好的部分**

- 嵌入式 OpenCode 的 basic-auth 密码由 shell 生成（32 字节 CSPRNG）并写 600 状态文件；`connections.json` 只存引用，不复制密码。
- Provider API key 写入 OpenCode 后不进入响应；`apiCredential` 限制类型/长度；provider id 有正则约束。
- 扩展文件读取是 GET-only 且 allow-list；路径检查有 canonicalize。
- 连接/启动有超时；进程树有回收。

**缺口**

- `baseUrl` 只要求非空，没有 scheme 约束；用户连接远程 `http://` OpenCode 时，basic-auth 密码会明文过网（C5）。
- 远程连接属于用户主动行为，不是 agent 可达的路径；风险等级 P2，但应在 UI/服务端显式限制。

## 边界 3：agent ↔ 文件/命令

**做得好的部分**

- `checkPath`/`checkPaths` 使用 realpath，限制在 HOME 与已知 workspace roots 内；`resolveWorkdir` 阻止 `workdir` 逃逸（`index.ts:2403`）。
- `revealTarget` 对 symlink 解析后的真实路径再做 roots 检查，明确区分目录/文件与 `.app` bundle。
- 策略引擎对 shell 做分词、重定向/子 shell 降级为 ask；`autoAccept` 只软化 fallback，不覆盖文档规则（见 README 与 policy tests）。
- dev 进程按进程组/tree 停止；`forget` 拒绝删除仍在运行的记录；dev 进程的 cwd 来自 session workspace。

**缺口：`dev_start` 绕过 shell 规则（C1）**

- `SHELL_TOOLS` 不含 `dev_start`（`packages/policy/src/index.ts:26`）。
- `dev_start` 的 `command` 由 service shell 执行（`plugins/dev-process.ts:223`）。
- `POST /dev` 没有调用策略（`packages/service/src/index.ts:2363`）。
- 后端权限映射只把 `bash/pwsh/powershell/cmd` 当 shell（`packages/adapter-opencode/src/map.ts:21`），策略只在 permission 事件到达时运行（`ingest.ts:119`）。

结论：用户针对 shell 写下的 `deny`/`ask` 规则，不必然覆盖后台命令；auto-accept 下可能静默执行。建议按 findings C1 修复，并在真实 OpenCode 上验证插件工具是否产生 permission 事件。

另有一个独立的路径缺口（C6）：`resolveWorkdir` 只做词法包含检查，workspace 内的 symlink 可以指向外部；`checkPath` 已经用 realpath，正确的做法应保持一致。

## 边界 4：模型输出 ↔ 渲染

**做得好的部分**

- `md.tsx` 先 `marked` 再 DOMPurify；`SANITIZE_CONFIG` 禁止 `button/form/iframe/object/embed/video/audio` 等交互/自动播放标签，禁止 `style` 属性；`class` 另行剥离。
- 被清洗掉的标签以源码文本回显（`revealDroppedTags`），避免“假按钮”和静默吞内容。
- Mermaid `securityLevel: "strict"`。
- HTML 预览使用 `sandbox=""` 的 `srcdoc` iframe，脚本/表单/顶层导航被沙箱阻止。
- 外链统一委托给系统浏览器，阻止 webview 导航；`isOpenableUrl` 限制可打开协议。

**缺口**

- DOMPurify 3.4.16 命中 critical/high/low advisory（C2）。当前配置未启用 `SAFE_FOR_TEMPLATES`/`IN_PLACE`，critical/high 的前置条件不完全成立，但这是最敏感的边界，patch 成本极低。
- 清洗行为没有 DOM 测试（B4）：`script`、`style=`、`javascript:`、shadow root 等回归只能靠人工。

## 边界 5：凭据

**做得好的部分**

- `api-token`、`opencode-status.json`、`connections.json` 等由服务/壳以 600 写入；handshake 文件 600。
- token 不进日志/响应；`api_token` 只通过 Tauri command 给页面。
- `check:secrets` 提供只读模式检查。

**缺口**

- 当前机器 `~/.agent-strata/desktop.json` 是 644；内容只有 `{"opencode":"embed"}`，不是凭据，但 README 把它描述为“持有 secret 的文件”，脚本也把它列入清单，导致检查红。应二选一：确认它不是 secret 并移出清单/改文案，或保证写入即 600（P3-8）。
- handshake 文件包含 token，位于 `~/.config/opencode/`，600；同一用户进程可读，这是本地威胁模型的固有边界，不是缺陷。

## 其他安全相关

- CSP：`default-src 'self' ipc: http://ipc.localhost`；`connect-src` 允许所有 loopback 端口；`style-src 'unsafe-inline'`。Tauri 会为 `index.html` 的内联首帧脚本注入 hash（`tauri-codegen` 的 inline-script hash 路径），不是裸 `unsafe-inline` script。当前取舍合理；未来若 webview 会加载不可信页面，需收紧 `connect-src`。
- Capability：`shell:allow-open` 允许 http/https/mailto 通配；UI 的外链处理已经限制协议，但 capability 本身较宽。低风险。
- 没有 `cargo audit`；Tauri/Rust 依赖树未做漏洞扫描（B3）。
- 没有 rate limit / body limit；本地 token 被盗后的影响面较大（C4）。

## 结论

安全工程的整体质量高于一般桌面应用：边界有明确代码、测试和注释，且没有把“策略”误称为 sandbox。最需要处理的是 **C1（dev_start 绕过 shell 规则）**、**C2（DOMPurify patch）**、**C3/C4（zod 与输入上限）**；其余是本地威胁模型下的取舍和运维/文档一致性。
