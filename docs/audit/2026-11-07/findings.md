# 代码健康检查 · findings

- 日期：2026-11-07
- 基线：`a1ede8a`
- 范围：技术栈、依赖、架构边界、CI/发版、测试，以及五条信任边界的静态安全审查
- 说明：本文件是唯一裁决入口；分维度细节见 `tech.md`、`workflow.md`、`security.md`。审计未修改产品代码。

## 本轮修复进展（2026-11-07）

按“先安全、避免大迁移”的顺序处理了 C1/C2/C3/C4/C6 与 B3；A/B 类结构性与发布项保持原状。

| ID | 状态 | 变更 |
|---|---|---|
| C2 | **已修复** | DOMPurify 升至 3.4.17，并用 `overrides` 统一 mermaid 的嵌套副本；移除 `@types/dompurify`；`bun audit` 对 DOMPurify 已干净 |
| C1 | **已修复** | `/dev` 以 bash 规则评估命令，`deny` 直接 403；`ask` 生成一张 local permission card，5 分钟后按 deny 超时；`dev_start` 加入 `SHELL_TOOLS`；新增路由测试 |
| C6 | **已修复** | `resolveWorkdir` 改用 `pathInside`（realpath 后比较）；新增 symlink 逃逸测试 |
| C3 | **已缓解** | zod 统一到 3.25.76；事件数组加 `.max()`；请求体加 80 MiB 上限；Zod 4 迁移未做，GHSA 以到期例外登记 |
| C4 | **已修复** | `Bun.serve` `maxRequestBodySize` + `content-length` 413；prompt parts 上限 1,000；schema 集合上限 |
| B3 | **已加入** | `bun run audit` 脚本 + CI 步骤；critical/high 默认失败，zod 为带原因与到期日的例外 |
| P3-1 | **部分处理** | 移除 UI 的未使用 zod 与弃用 `@types/dompurify`；其余未使用依赖未动 |
| 其余 | 未处理 | A1/A2/A3、B1/B2/B4、UI workspace/严格度、Zod 4 迁移等按稳定性要求暂缓 |

## 结论摘要

整体健康度**良好**：类型检查、lint、1,786 个测试和生产构建全部通过；零 `TODO/FIXME`、零 `@ts-ignore`、没有 `any` 类型标注（扫描命中的 2 处只是注释里的英文单词 `any`）；安全边界（loopback、Origin、capability token、CSP、路径约束、HTML 清洗、进程组回收）有明确实现和测试。

需要处理的主要风险：

1. **`dev_start` 可能绕过 shell 策略**：策略引擎只把 `bash/shell/execute/terminal` 当 shell 工具，而后台插件可以执行任意 `command`。
2. **依赖漏洞**：UI 的 DOMPurify 3.4.16 命中 critical/high advisory；zod <4.6.6 命中 high advisory；diff/seroval 也有 advisory。
3. **CI 门禁不完整**：没有生产构建、依赖审计、`cargo fmt`/`clippy`；依赖与 Rust 质量靠人工。
4. **工程边界**：UI 不是 workspace，11 处直接相对导入 packages 源码；UI 的 TS 严格度低于 packages；两套 lockfile。
5. **测试与性能门禁**：UI 测试大量是源码字符串断言，sanitizer 没有 DOM 行为测试；bench 不在 CI；主 chunk 356.9 KB gzip 触发 Vite 警告。

## 风险登记表

| ID | 严重度 | 维度 | 发现 | 建议 | 工作量 |
|---|---|---|---|---|---|
| C1 | **P1** | 安全 | `dev_start` 不受 shell 策略规则约束 | 纳入 `SHELL_TOOLS` 并在 `/dev` 路由执行策略/授权 | M |
| C2 | **P1** | 依赖/安全 | DOMPurify 3.4.16 三条 advisory（1 critical、1 high） | 升级 ≥3.4.17，补 DOM 清洗测试与审计门禁 | S |
| C3 | **P1** | 依赖/安全 | zod <4.6.6 high advisory；6 处 3.23/3.25 并存 | 先限输入尺寸并统一版本，再规划 Zod 4 | L |
| C4 | **P2** | 安全 | HTTP/事件没有 body/数组上界 | 加请求体上限与 zod 数组上限 | M |
| C5 | **P2** | 安全 | 远程 OpenCode 连接未强制 TLS | 非 loopback 只允许 `https:` 或显式警告 | S |
| C6 | **P2** | 安全 | `dev_start` 的 `workdir` 只做词法包含检查，symlink 可逃出 workspace | realpath 后再判定，并补 symlink 测试 | S |
| A1 | **P2** | 技术栈 | 本地 Bun 1.3.14 vs CI 1.4.2，无版本钉住 | `packageManager`/`.bun-version` 对齐 | S |
| A2 | **P2** | 架构 | UI 非 workspace，11 处深层相对导入 packages | 纳入 workspace/子路径 exports，声明依赖 | M |
| A3 | **P2** | 类型 | UI/bench 缺 `noUncheckedIndexedAccess`、`verbatimModuleSyntax` | 继承 `tsconfig.base.json` 并修 fallout | M |
| B1 | **P2** | CI | check job 不跑生产构建 | CI 加 `bun run build` | S |
| B2 | **P2** | CI/Rust | 无 `cargo fmt`/`clippy` 门禁；16 处 fmt 漂移、10 条 clippy warning | 加门禁并清理告警 | S |
| B3 | **P2** | 供应链 | CI 不跑 `bun audit`/`cargo audit` | 加审计 job 与例外流程 | S/M |
| B4 | **P2** | 测试 | sanitizer 无 DOM 行为测试；UI 测试以源码断言为主 | 加 Playwright/browser 测试，bench 夜间化 | M |
| P3-1 | P3 | 依赖 | 多处未使用/仅测试用依赖、已弃用 `@types/dompurify` | 清理并移到 `devDependencies` | S |
| P3-2 | P3 | 元数据 | UI 0.4.5 vs app 0.26.7；版本无一致性测试 | 对齐并加检查 | S |
| P3-3 | P3 | Rust | 无 `rust-version`/`rust-toolchain.toml` | 声明 MSRV | S |
| P3-4 | P3 | 脚本 | `scripts/*.ts` 不参与 typecheck | 加 scripts tsconfig | S |
| P3-5 | P3 | 测试 | 无覆盖率门禁；bench 不在 CI | 建立覆盖基线与夜间 bench | M/L |
| P3-6 | P3 | 构建 | 主 JS 356.9 KB gzip、sprite 301 KB | 懒加载终端/设置，按需拆 sprite | M |
| P3-7 | P3 | 发布 | tag 跳过 Rust test；macOS 未签名；actions 未按 SHA 固定 | 记录取舍；可加非阻断 Rust job | S |
| P3-8 | P3 | 运维 | `desktop.json` 644、README 称其为 secret；检查因此红 | 修文件模式/检查清单与文档 | S |
| P3-9 | P3 | 存储 | 无 `busy_timeout`；迁移是临时 `ALTER TABLE` | 建 `user_version` 迁移与 busy timeout | M |
| P3-10 | P3 | 安全 | `shell:allow-open` 通配 http/https；CSP 允许所有 localhost 端口 | 记录为本地取舍，必要时收紧 | S |

## P1 详情

### C1 · `dev_start` 可能绕过 shell 策略

**证据**

- `packages/policy/src/index.ts:26`：`SHELL_TOOLS = ["bash", "shell", "execute", "terminal"]`。
- `plugins/dev-process.ts:223`：`dev_start` 接受任意 `command`，由 service 的 shell 执行。
- `packages/service/src/index.ts:2363`：`POST /dev` 校验 `session_id`、`command`、`workdir`、`port`，但没有调用 `evaluate` 或 `policyFor`。
- `packages/adapter-opencode/src/map.ts:21`：后端权限映射只认 `bash/pwsh/powershell/cmd`；`ingest.ts:119` 只在收到 permission 事件时评估策略。

**影响**

用户写的 `deny` shell 规则（例如禁 `rm`、只允许 `git status`）不会匹配 `dev_start` 的 `command`。会话处于 auto-accept 时，模型可以用 `dev_start` 启动同一个命令而不触发对应规则。策略本身是 advisory，不是 sandbox，但这是对“规则覆盖所有 shell 执行路径”的直接破坏。

**建议**

- 将 `dev_start` 加入 shell 工具集合，让 `command` 参与 `splitShell`/规则匹配。
- 在 `POST /dev` 内用 `policyFor(sessionID)` 评估 `{ tool: "dev_start", input: { command } }`：`deny` 直接 400；`ask` 必须接入现有 permission 卡或明确拒绝，不能默默启动。
- 先确认真实 OpenCode 是否为插件工具发 permission 事件；无论答案如何，service 侧都应有兜底。
- 补 `dev_start` 的 deny/ask 策略测试和路由测试。

### C2 · DOMPurify 3.4.16 漏洞

**证据**

- `apps/desktop/ui/bun.lock:470`：`dompurify@3.4.16`。
- `bun audit`（UI）：
  - critical：`GHSA-cg2g-xh64-v4q7`（SAFE_FOR_TEMPLATES bypass，attached shadow root）
  - high：`GHSA-mrv2-3pqr-j5jr`（IN_PLACE hook 的 detached subtree 事件处理器）
  - low：`GHSA-c6gr-qvv4-5v3f`（SMIL attributeName=href，XHTML parser）
- `apps/desktop/ui/src/md-tags.ts:15`：只设置 `FORBID_TAGS` 与 `FORBID_ATTR: ["style"]`，未启用 `SAFE_FOR_TEMPLATES` 或 `IN_PLACE`。

**影响**

模型输出是不可信内容，transcript 的 Markdown/HTML 清洗是主要 XSS 边界。当前配置没有打开 critical/high 的前置选项，实际可利用性较低，但该依赖处于最关键的位置，patch 成本极低，不应等待。

**建议**

- 升级 `dompurify` 到 ≥3.4.17（或当前 3.x 最新 patch）。
- 移除已弃用的 `@types/dompurify`（DOMPurify 自带类型）。
- 加浏览器行为测试：`script`、`iframe`、`style=`、`onerror=`、`javascript:`、`<video autoplay>`、shadow-root 内容。
- 把 `bun audit` 放进 CI。

### C3 · zod high advisory 与多版本并存

**证据**

- `bun audit`（root/UI）：`GHSA-mrhx-c7xc-m3w5`，`zod <4.6.6`，high。
- 版本：`packages/api/schema/store/projector/policy` 与 UI 使用 `3.23.8`；`packages/adapter-acp` 使用 `3.25.76`；根锁文件同时解析两个版本。
- `packages/schema/src/index.ts` 中 9 处 `z.array(...)` 均无 `.max()`；`store` 对每个事件调用 `parseEvent`，service 对请求体直接 `req.json()`。

**影响**

攻击面是“超大 constrained collection”导致内存耗尽。当前服务只监听 loopback 且有 token，但事件来自后端/模型，请求体又没有上限；一旦输入被放大，可在解析阶段拖垮 service。多版本 zod 还会增加包体与 schema 行为差异。

**建议**

- 立即缓解：所有 HTTP body 加尺寸上限；对事件数组/字符串加 `.max()` 或入口长度检查。
- 统一到单一 zod 版本（先 3.25.76，或直接 4.6.6+），消除 `adapter-acp` 的独立版本。
- 规划 Zod 4 迁移：`z.record`、错误消息、`z.infer` 等可能需要调整；按包分批升级并跑全量测试。
- CI 加 `bun audit`，对 high/critical 默认失败。

## P2 详情

### C4 · 请求与事件没有尺寸上界

`POST /dev`、`/connect`、prompt 等路由直接 `await req.json()`（例如 `packages/service/src/index.ts:2368`）；没有 `Content-Length` 检查或流式上限。zod schema 的数组也没有 `.max()`。建议在 HTTP 层加 body 上限（例如 2 MB，按路由可调），在 schema 层给数组/字符串加上界；与 C3 一起做。

### C5 · 远程 OpenCode 连接未强制 TLS

`packages/service/src/connections.ts` 的 `looksEmbedded` 只对 loopback 判定“嵌入式”，但连接本身不限制 scheme；`packages/service/src/index.ts:770` 只检查 `baseUrl` 存在。用户输入 `http://remote:4096` 并提供 basic-auth 密码时，凭据会明文过网。建议非 loopback 只接受 `https:`，或在 UI 明确警告并默认阻止。

### C6 · `dev_start` 的 workdir 可经 symlink 逃出 workspace

`resolveWorkdir` 用 `resolve` + `insideWorkspace` 做词法检查（`packages/service/src/dev-process.ts:780-788`），没有像 `checkPath` 那样 `realpath`（`packages/service/src/paths.ts:83-89`）。workspace 内一个指向外部的 symlink（`workspace/link -> /tmp`）会让 `workdir: "link"` 通过检查，进程 cwd 实际落在 `/tmp`。现有测试只覆盖 `..`（`packages/service/test/dev-process.test.ts:1035-1044`）。建议：先 `realpathSync(target)`（不存在则拒绝），再对 real path 做包含检查；补 symlink 正/反用例。

### A1 · 工具链未钉住

`package.json` 无 `packageManager`/`engines`；CI 固定 Bun 1.4.2（`.github/workflows/ci.yml:33`），本机 1.3.14；`@types/bun` 解析到 1.4.2。锁文件与运行时/类型可能不一致。建议加 `packageManager` 和 `.bun-version`，本地与 CI 统一；Rust 侧加 `rust-toolchain.toml`。

### A2 · UI 与 packages 的边界未机器化

根 `workspaces` 只有 `packages/*`（`package.json:4-6`），UI 有独立 lockfile；UI 通过相对路径直接导入 packages 源码：

- `apps/desktop/ui/src/api.ts:1-42`
- `apps/desktop/ui/src/view-cache.ts:2`
- `apps/desktop/ui/bench/*` 6 处

UI 的 `package.json` 没有声明 `@agent-strata/*` 依赖。后果是包边界、导出面、依赖版本都无法被工具约束。建议把 UI 纳入 workspace 并声明依赖，或至少为用到的内部模块加 `exports` 子路径（如 `@agent-strata/projector/files-key`），用 tsconfig paths + lint 约束。

### A3 · UI 的 TypeScript 严格度低于 packages

`tsconfig.base.json` 启用了 `noUncheckedIndexedAccess` 与 `verbatimModuleSyntax`；`apps/desktop/ui/tsconfig.json` 与 `bench/tsconfig.json` 只开 `strict`。UI 是 20,730 行 TSX，数组索引和类型导入的检查弱于 packages。建议继承 base，分批修复；这是发现潜在 bug 的机会，不是纯风格问题。

### B1 · CI 没有生产构建

`.github/workflows/ci.yml:50-66` 只跑 typecheck/lint/packages/UI tests；没有 `bun run build`。生产构建由 release 的 `beforeBuildCommand` 才第一次执行，Vite/Tailwind/chunk 问题可能到 tag 才暴露。建议在 check job 末尾加 `bun run build`（UI），并考虑 chunk 预算。

### B2 · Rust 没有 fmt/clippy 门禁

`cargo fmt --check` 失败：`embed.rs` 8 处、`main.rs` 7 处、`plugin_install.rs` 1 处。`cargo clippy` 10 条 warning，包括 `DocumentOpen`/`document_open` dead code（`main.rs:1369/1375`，仅 Windows 使用）、`io::Error::other`、`div_ceil`、参数过多等。CI 只跑 `cargo test`。建议加 `cargo fmt --check` 与 `cargo clippy --all-targets -- -D warnings`，先清理现有告警。

### B3 · CI 没有依赖审计

`bun audit` 与 `cargo audit` 都不在 CI；本次已经发现 critical/high。建议 root 与 UI 分别跑 `bun audit`，Rust 加 `cargo audit`/`cargo deny`；建立“新 critical/high 阻断、低危登记”的例外流程。

### B4 · 测试结构偏源码断言，sanitizer 缺行为测试

1,099 个 UI 测试大量读取源码字符串（`visual-*`、`tip-listeners`、`primitive-adoption`），能锁设计约定，但不能证明渲染行为。`md.tsx`/`md-tags.ts` 的 DOMPurify 清洗没有 `<script>`/`style=`/`javascript:` 的 DOM 行为测试；`files.tsx` 的 sandbox iframe 也没有。bench 有 flows A-F 但不在 CI。建议至少补 md 管线的 Playwright 测试，并把关键 flow 放到夜间 macOS job。

### B5 · 可维护性热点

`packages/service/src/index.ts` 2,825 行、`session-detail.tsx` 1,932 行、`session-composer.tsx` 1,516 行、`embed.rs` 2,693 行。不是立即缺陷，但路由/平台逻辑与 UI 状态已经进入“改一处要读很久”的区间。建议按领域拆 service 路由（dev、providers、sessions、maintenance）和 session-detail 的子视图；每次只做纯移动，保持测试。

## P3 / 维护项

- **未使用/错位依赖**：
  - `adapter-acp` 的 `zod` 未使用；`store`/`projector` 仅在测试中使用，应移到 `devDependencies`。
  - `adapter-opencode` 的 `store`/`projector` 同样只在测试中使用。
  - `store`、`projector` 的 `zod`/`ulid` 未被 src 使用；`policy` 的 `ulid` 未使用。
  - UI 的 `zod` 未使用（实际由 packages schema 走根解析）；`@types/dompurify` 已弃用。
  - 根 `@tauri-apps/plugin-shell` 未被根脚本使用，只被 UI 使用。
- **版本元数据**：`apps/desktop/ui/package.json` 是 `0.4.5`，应用是 `0.26.7`；release 只校验 tag 与 `tauri.conf.json`，不校验 `Cargo.toml`。加一个版本一致性测试。
- **脚本未 typecheck**：根 `typecheck` 列表不含 `scripts`；`scripts/*.ts` 只被 oxlint 检查。加 `scripts/tsconfig.json` 或把脚本纳入一个 tsc 项目。
- **覆盖率/性能**：没有 coverage 脚本或门禁；bench 只在 AGENTS 中描述，不在 CI。建议先记录基线，再设“不回退”阈值。
- **构建体积**：主 JS 356.9 KB gzip；`sprite.svg` 301 KB；Vite 警告。可把 terminal/xterm、settings、fleet 等按需加载，sprite 按使用拆块。
- **发布取舍**：tag 只跑 check job（Rust test 跳过，文档已说明）；macOS 产物未签名（README 已说明）；actions 用 tag 而非 SHA。都是已记录取舍，建议保持显式并在 release notes 提醒。
- **secret 检查**：`desktop.json` 实际内容只有 `{"opencode":"embed"}`，不是凭据；脚本把它列入 secret 清单，当前机器上为 644，导致 `check:secrets` 红。要么把该文件移出清单/README 措辞改为“运行标记”，要么保证写入即 600。
- **存储**：`openStore` 只设 `journal_mode=WAL`，没有 `busy_timeout`；迁移是 `PRAGMA table_info` + `ALTER TABLE`。多 service 实例或未来 schema 变化会变脆。建议 `PRAGMA user_version` 迁移表 + `busy_timeout`。
- **CSP/打开外链**：CSP 允许所有 `localhost/127.0.0.1` 端口与 `style-src 'unsafe-inline'`；`capabilities/default.json` 的 `shell:allow-open` 允许任意 http/https。当前是本地应用，风险可接受；如果未来加载不可信页面，需要收紧。
- **advisory 低危项**：`diff@5.2.0`（low DoS）、`seroval@1.6.8`（moderate，Solid 客户端未用 SSR）。升级 `diff` ≥5.2.2、solid-js/seroval 到修复版本即可。

## 已确认良好的点

- 没有 `TODO`/`FIXME`/`HACK`，没有 `@ts-ignore`/`@ts-expect-error`/lint-disable；产品代码没有 `any` 类型标注（扫描命中的 2 处只是注释里的英文单词 `any`）。
- 安全边界实现完整：127.0.0.1 绑定、Host/Origin 校验、capability token、CORS 测试、路径 canonicalize/根目录约束、provider key 不回显、终端 socket token、进程组回收。
- CSP 由 Tauri 为内联首帧脚本注入 hash（`tauri-codegen` 的 inline-script hash 路径），不是裸 `unsafe-inline` script。
- Markdown 渲染有 DOMPurify + `FORBID_TAGS`/`FORBID_ATTR`，Mermaid `securityLevel: strict`，HTML 预览是空 sandbox iframe。
- 测试与设计约束密度高：622 package tests、1,099 UI tests、69 Rust tests；主题 token 完整性/对比度、plan stepper、权限 tooltip 等都有回归测试。
- 提交历史以 Conventional Commits 为主，最近 30 天提交范围集中，没有把生成物或密钥带进版本库。
