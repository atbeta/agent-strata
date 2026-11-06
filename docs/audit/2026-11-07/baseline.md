# 基线快照 · 2026-11-07

- 仓库：`agent-strata`
- 提交：`a1ede8a fix(tip): follow a trigger that moves under the label`
- 工作区：干净
- 审计方式：静态检查 + 本地命令；这是**修复前**快照，修复进展见 `findings.md`

## 工具链

| 项 | 本地 | CI |
|---|---|---|
| Bun | 1.3.14 | 1.4.2 |
| Node（本机） | 24.19.0 | 未单独安装（Bun 执行） |
| Rust | 1.95.0 | 1.95.0 |
| TypeScript | 5.5.4 | 5.5.4（锁文件） |
| Tauri CLI | 2.12.4 | 2.12.4 |
| Tauri crate | `2`（Cargo.lock 锁定） | 同左 |

本地没有 `packageManager`、`.bun-version`、`rust-toolchain.toml` 或 `rust-version` 约束。

## 代码规模

`tokei`（排除 `node_modules`、`target`、`dist`）：

| 语言 | 文件 | Code | Comment | Blank |
|---|---:|---:|---:|---:|
| TypeScript | 365 | 51,332 | 9,697 | 4,632 |
| TSX | 74 | 20,730 | 3,223 | 881 |
| Rust | 5 | 3,714 | 334 | 271 |
| CSS | 1 | 1,288 | 203 | 36 |
| 合计（含 JSON/SVG 等） | 512 | 78,662 | 22,327 | 8,042 |

最大文件（行数）：

1. `packages/service/src/index.ts` 2,825
2. `apps/desktop/src-tauri/src/embed.rs` 2,693
3. `apps/desktop/ui/src/session-detail.tsx` 1,932
4. `apps/desktop/ui/src/session-composer.tsx` 1,516
5. `apps/desktop/ui/src/theme.css` 1,527
6. `packages/adapter-opencode/test/opencode.test.ts` 4,441（测试）

## 检查结果

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | 通过 |
| `bun run lint` | 通过（warnings 视为失败） |
| `bun test packages` | 622 run / 618 pass / 4 skip / 0 fail，112s |
| `bun run test:ui` | 1,099 pass / 0 fail |
| `cargo test --locked` | 69 pass / 0 fail |
| `bun run build`（UI） | 通过；有 >500 kB chunk 警告 |
| `bun run check:secrets` | **失败**：`~/.agent-strata/desktop.json` 为 644（内容为 `{"opencode":"embed"}`，不是凭据） |
| `cargo fmt --check` | **失败**：3 个文件、16 处（embed.rs 8、main.rs 7、plugin_install.rs 1） |
| `cargo clippy --locked --all-targets` | 10 warnings，含 2 个 dead-code 项 |
| `bun audit`（root） | 2 个漏洞：zod high、diff low |
| `bun audit`（UI） | 6 个漏洞：DOMPurify critical/high/low、zod high、seroval moderate ×2 |
| `cargo audit` | 未安装，未执行 |

跳过的 4 个测试全部是 `AGENT_STRATA_OPENCODE_E2E` 才启用的 live E2E。

## 构建体积

- 主 JS：`index-B72GZUjr.js` 1.2 MB / **356.9 KB gzip**
- 主 CSS：`index-Cw_6UUbQ.css` 97 KB / **18.6 KB gzip**
- `sprite-CAhVckip.svg` 301 KB
- Mermaid 相关 chunk 按需加载：`elk` 1.4 MB、`cynefin` 639 KB、`mermaid.core` 618 KB 等
- Vite 提示存在 >500 kB chunk

## 审计边界

- 未做动态渗透测试、未运行 Playwright bench、未连接真实 OpenCode 做 live E2E。
- 安全结论基于源码、路由、适配器、策略引擎和现有测试的静态审查。
- `check:secrets` 的失败是当前机器上的文件模式漂移，脚本本身只读。
