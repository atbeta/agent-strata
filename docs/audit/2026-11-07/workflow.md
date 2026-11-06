# 维度 B · 开发方式与发布

## CI 门禁矩阵

| 门禁 | check job | rust job | release |
|---|---|---|---|
| 安装 workspace / UI 依赖 | ✅ | ✅ | ✅ |
| `bun run typecheck` | ✅ | — | — |
| `bun run lint` | ✅ | — | — |
| `bun test packages` | ✅ | — | — |
| UI `bun test` | ✅ | — | — |
| `cargo test --locked` | — | ✅ | **跳过**（`only_check: true`） |
| UI 生产构建 | ❌ | — | 由 Tauri `beforeBuildCommand` 执行 |
| `cargo fmt --check` | ❌ | ❌ | ❌ |
| `cargo clippy` | ❌ | ❌ | ❌ |
| `bun audit` / `cargo audit` | ❌ | ❌ | ❌ |
| bench（性能/交互） | ❌ | — | ❌ |

缺口对应 findings B1/B2/B3/B4。CI 的 check job 覆盖了大多数正确性检查，但**生产构建第一次发生在 release**，这是最值得补的一格。

## 提交卫生

- 最近 30 天 696 次提交，主题集中在 Conventional Commits（feat/fix/refactor/docs 等）。
- 没有发现提交生成物、密钥或 `.DS_Store`；`.gitignore` 覆盖 `dist`、`target`、`node_modules`、bench 结果与缓存。
- 工作区在本次审计开始时干净；本次只新增 `docs/audit/`。

## 文档漂移

- `README.md:53` 把 `desktop.json` 列入“持有 secret 的文件”，但实际内容只有 `{"opencode":"embed"}`；同时当前机器上该文件是 644，导致 `check:secrets` 红。这是**脚本清单 + 文档措辞 + 本机模式**三者不一致（P3-8）。
- `apps/desktop/ui/package.json` 版本 0.4.5，应用版本 0.26.7；release 只校验 tag 与 `tauri.conf.json`，不校验 `Cargo.toml`。版本元数据没有测试（P3-2）。
- AGENTS.md 对 checks、bench、Chromium 限制的描述与当前脚本一致，没有发现漂移。
- DESIGN.md 对主题/plan/permission footer 的描述与代码一致。

## 测试结构

- `bun test packages`：622 tests / 41 files / 618 pass / 4 skip / 112s。4 skip 都是 live OpenCode E2E（`AGENT_STRATA_OPENCODE_E2E`），默认不跑。
- UI：1,099 pass；大量是**源码字符串断言**，用于锁设计约定（主题 token、primitive adoption、视觉细节、tooltip listener）。它们很有价值，但不能替代渲染行为测试。
- Rust：69 pass；没有 clippy/fmt；有 10 条 warning。
- bench：flows A-F 覆盖冷开、滚动、长会话、流式、巨型 turn；需要 Playwright WebKit，未进 CI。
- 没有 coverage 脚本或阈值；不知道关键包的覆盖率。

**测试缺口（详见 B4）**

1. Markdown/HTML 清洗没有 DOM 行为测试：`<script>`、`iframe`、`style=`、`onerror=`、`javascript:`、媒体自动播放。
2. HTML 预览的 sandbox iframe 没有行为测试。
3. 远程连接/TLS、请求体上限等负向路径缺少测试（新增 C4/C5 后应补）。
4. 真实 OpenCode live E2E 默认跳过；CI 没有夜间 live 任务。
5. UI 交互（composer 队列、主题切换、plan、tooltip）主要靠源码断言，bench 不阻断。

## 发布流程

- tag `v<version>` / `v<version>-branded` 触发 `desktop-release.yml`；先跑 check job，再 Windows NSIS + macOS dmg。
- tag 必须等于 `tauri.conf.json` 版本（`desktop-release.yml` 的 pwsh 检查）；不校验 `Cargo.toml`。
- `only_check: true` 明确跳过 Rust test，避免测试失败导致安装包不产出（0.21.0 的历史教训）；权衡已写在 AGENTS/README。
- macOS 产物未签名（README 已说明）；没有 updater 配置（`uploadUpdaterJson: false`）；actions 使用 tag 而非 SHA。
- 这些是已记录的取舍，不是隐藏问题；如果发布对象扩展到不受控用户，建议补签名/公证、action SHA 固定与 Rust 非阻断测试。

## 代码规模与维护

- 78,662 行 code（TS 51,332 / TSX 20,730 / Rust 3,714 / CSS 1,288）。
- 热点文件见 `tech.md`；service 路由与 session-detail 是后续拆分首选。
- 没有 TODO/FIXME 积压，说明维护者在及时清理；但也意味着不能用 TODO 统计来发现已知债务，需要依赖本审计的登记表。

## 结论

开发流程的基础很好：提交卫生、AGENTS/DESIGN、测试密度、bench 工具链都超过一般项目。主要改进是**把已有的质量工具接入 CI**：生产构建、Rust fmt/clippy、依赖审计、sanitizer 行为测试；然后把 bench 放到夜间，而不是要求每个 PR 跑。
