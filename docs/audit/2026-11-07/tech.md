# 维度 A · 技术栈与依赖

## 栈矩阵

| 层 | 选择 | 备注 |
|---|---|---|
| 运行时 | Bun 1.3.14（本机）/ 1.4.2（CI） | 本地与 CI 不一致，见 A1 |
| Rust | 1.95.0 | CI 固定；Cargo.toml 未声明 MSRV |
| UI | SolidJS 1.9.x + Vite 7 + Tailwind 4 | 生产构建通过 |
| 桌面 | Tauri 2 | CLI 2.12.4 |
| 数据 | SQLite（bun:sqlite、WAL、FTS5） | 无 busy_timeout / 版本化迁移 |
| Schema | zod 3.23.8 / 3.25.76 | 多版本并存，见 C3 |
| 终端 | xterm 5.5.0 | 静态进入主 chunk |
| 渲染 | marked 16 + DOMPurify 3.4.16 + Mermaid 12 | DOMPurify 有 advisory，见 C2 |

## 依赖健康

- 根工作区只覆盖 `packages/*`；`apps/desktop/ui` 是第二套 install/lockfile（`apps/desktop/ui/bun.lock`），CI 分两步安装。
- 同一依赖可能存在两份解析：zod 3.25.76 被 `adapter-acp` 拉起，其他包是 3.23.8；UI 自己声明 3.23.8 但没有直接 import，实际 schema 依赖从根解析。多版本会增加包体和行为差异。
- 未使用/错位依赖（详见 findings P3-1）：
  - `adapter-acp`：zod 未使用；store/projector 仅测试使用。
  - `adapter-opencode`：store/projector 仅测试使用。
  - `store`/`projector`：直接依赖 zod/ulid 但 src 未用。
  - `policy`：ulid 未使用。
  - UI：zod 未使用；`@types/dompurify` 是弃用 stub。
  - 根：`@tauri-apps/plugin-shell` 只被 UI 使用。
- 安全公告（2026-11-07 实测）：
  - root：zod high（GHSA-mrhx-c7xc-m3w5）、diff low（GHSA-73rr-hh4g-fpgx）。
  - UI：DOMPurify critical/high/low、zod high、seroval moderate ×2。

## 架构边界

- packages 之间用 `@agent-strata/*` 引用，依赖方向清晰；service 组合 adapters，core/projector 不反向依赖 service。
- UI 不通过包名引用 packages，而是深层相对路径：
  - `src/api.ts` → `packages/api/src/index`、`projector/src/index`、`schema/src/index`
  - `src/view-cache.ts` → `projector/src/files-key`（内部文件）
  - `bench/*` 6 处 → `store`、`schema`、`service`
- UI 的 package.json 没有声明这些包，包边界无法由 workspace/依赖图约束；UI 直接打源码，也绕过了 package `main`/exports。
- 结果：包内部文件（如 `files-key`）事实上成为 UI 的公开 API；重构 packages 时无法用工具发现 UI 的依赖。

## 类型严格度

- `tsconfig.base.json`：`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`。
- `apps/desktop/ui/tsconfig.json`：只有 `strict`，没有上述两项；bench 同样。
- UI 是 20,730 行 TSX，比 packages 更容易漏掉索引越界和类型导入问题；建议继承 base，作为一次独立迁移处理。

## 代码规模与热点

| 文件 | 行数 | 说明 |
|---|---:|---|
| `packages/service/src/index.ts` | 2,825 | 路由、驱动、连接、SSE、维护逻辑集中 |
| `apps/desktop/src-tauri/src/embed.rs` | 2,693 | OpenCode 嵌入/平台进程逻辑 |
| `apps/desktop/ui/src/session-detail.tsx` | 1,932 | 会话页状态与渲染 |
| `apps/desktop/ui/src/session-composer.tsx` | 1,516 | 输入、命令、附件、队列 |
| `apps/desktop/ui/src/theme.css` | 1,527 | 6 套主题 × 明暗 + 组件规则 |

不是立即缺陷，但 service 路由和 session-detail 已进入“改动需要长上下文”的区间。建议按领域拆 service 路由（dev、provider、session、maintenance），UI 按子视图拆，纯移动、测试保持。

## 构建

- 生产构建通过；主 JS 1.2 MB / **356.9 KB gzip**，CSS 97 KB / **18.6 KB gzip**。
- Mermaid 的 elk/cynefin/cytoscape 等大 chunk 是按需加载，方向正确。
- `sprite.svg` 301 KB；xterm/终端、settings 等静态依赖仍在主 chunk，Vite 给出 >500 kB 警告。
- 建议：按需加载终端/设置/舰队视图，sprite 按使用拆块；CI 记录 chunk 预算。

## 结论

技术栈选择一致、现代，主要债务集中在**边界与版本治理**：UI 不是 workspace、严格度较低、两套依赖图、zod/DOMPurify 版本需要处理。先处理 C2/C3/A1，再做 A2/A3 的结构性迁移。
