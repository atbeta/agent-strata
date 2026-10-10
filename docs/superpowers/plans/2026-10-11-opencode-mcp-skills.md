# OpenCode MCP and Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** From an OpenCode session the reader can see MCP server status, connect or disconnect a server, and see installed skills. Picking a skill puts `/name` in the composer.

**Architecture:** Listing stays on the read-only extension (`GET /mcp`, `GET /skill`), which is already allow-listed. Connect and disconnect are command-plane POSTs. They are directory-scoped through the session the reader has open. Adding a server and OAuth stay out.

**Tech Stack:** Bun 1.3, TypeScript, `bun:test`, `@opencode-ai/sdk` 1.18.35, Solid + Tailwind.

## Global Constraints

Every task includes `.superpowers/sdd-mcp/constraints.md`.

---

## Facts (SDK 1.18.35; do not re-verify against a model)

1. `GET /mcp` returns `{ [name: string]: { status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration"; error?: string } }`. `failed` and `needs_client_registration` carry `error`.
2. `POST /mcp/{name}/connect` and `POST /mcp/{name}/disconnect` take the name in the path. Confirm those pathnames in `sdk.gen.js` before locking the fake. Do not change the call to fit a guessed path.
3. `GET /skill` returns `{ name: string; description?: string; location: string; content: string }[]`. The list UI shows name and description only. Do not render `content`.
4. The extension route is GET-only and matches the path exactly (`packages/service/src/extension-route.ts`). `/mcp/name/connect` is not an extension read.
5. Slash commands whose `source` is `mcp` or `skill` already appear in the composer menu. This plan does not change that menu.

---

## File map

- `packages/adapter-opencode/src/index.ts` — `mcpConnect`, `mcpDisconnect` on the client returned by `connectOpencode`.
- `packages/service/src/driver.ts`, `opencode-driver.ts`, `index.ts` — the two POSTs.
- `packages/service/test/service.test.ts` — the fake sees the SDK paths; ACP gets 400.
- `apps/desktop/ui/src/api.ts`, `session-detail.tsx`, `icons.tsx`, locales — the popover.

---

### Task 1: Connect and disconnect an MCP server

**Files:** `packages/adapter-opencode/src/index.ts`, `packages/service/src/driver.ts`, `packages/service/src/opencode-driver.ts`, `packages/service/src/index.ts`, `packages/service/test/service.test.ts`.

**Produces:** `BackendDriver` optional methods `mcpConnect(name, directory?)` and `mcpDisconnect(name, directory?)`. The OpenCode driver forwards them to `client.mcp.connect({ name, directory })` and `client.mcp.disconnect({ name, directory })`. Routes, both POST:

- `/sessions/:id/mcp/:name/connect`
- `/sessions/:id/mcp/:name/disconnect`

Same ownership checks as revert (`driverFor`, `nativeId`, `directoryOf`, `owners.set`). Missing method, or a backend that is not OpenCode, is 400. An empty name or a name containing `/` is 400. Success is `{ ok: true }`. A thrown SDK error is 502. ACP gets 400.

- [ ] **Step 1: Failing service test** with `fakeOpencode`. Register the pathnames read from `sdk.gen.js`. After connect, POST both routes for a server named `srv` and assert the fake saw `POST /mcp/srv/connect` and `POST /mcp/srv/disconnect`. The existing ACP test asserts disconnect returns 400.

- [ ] **Step 2: Run it and confirm it fails because the routes are missing.**

- [ ] **Step 3: Implementation.** Await the SDK call the way `abort` does. Pass `directory ?? opts.directory`.

- [ ] **Step 4: Root `bun test`, root typecheck.** Commit `feat(service): connect and disconnect an MCP server`.

---

### Task 2: The MCP and skills popover

**Files:** `apps/desktop/ui/src/api.ts`, `icons.tsx`, `session-detail.tsx`, `locales/zh/session.ts`, `locales/en/session.ts`.

**Consumes:** `readOpencode` for `GET /mcp` and `GET /skill`. The two POSTs from Task 1. `caps()?.extension === "opencode"` already exists.

- [ ] **Step 1: API.**

```ts
export type McpServerStatus = {
  status: "connected" | "disabled" | "failed" | "needs_auth" | "needs_client_registration";
  error?: string;
};
export type SkillInfo = { name: string; description?: string; location: string; content: string };

export function readMcp(sessionId: string): Promise<Record<string, McpServerStatus> | undefined>
export function readSkills(sessionId: string): Promise<SkillInfo[] | undefined>
export function connectMcp(sessionId: string, name: string): Promise<void>
export function disconnectMcp(sessionId: string, name: string): Promise<void>
```

Reads go through `readOpencode`. The POSTs use `throwOnError` and encode the name in the path.

- [ ] **Step 2: Strings.**

| key | zh | en |
|---|---|---|
| `mcp.title` | MCP | MCP |
| `mcp.empty` | 没有 MCP 服务器 | No MCP servers |
| `mcp.connect` | 连接 | Connect |
| `mcp.disconnect` | 断开 | Disconnect |
| `mcp.status.connected` | 已连接 | Connected |
| `mcp.status.disabled` | 已停用 | Disabled |
| `mcp.status.failed` | 失败 | Failed |
| `mcp.status.needs_auth` | 需要登录 | Needs sign-in |
| `mcp.status.needs_client_registration` | 需要注册 | Needs registration |
| `skill.title` | 技能 | Skills |
| `skill.empty` | 没有技能 | No skills |
| `header.tools` | MCP 与技能 | MCP and skills |

- [ ] **Step 3: Icon.** Add `plug` to `icons.tsx`, a small plug glyph in the same 16px stroke style as the others.

- [ ] **Step 4: Popover.** In the header icon row, when `caps()?.extension === "opencode"`, a quiet `h-7 w-7` button with `plug` and `Tip` / `aria-label` `header.tools`. It toggles a panel anchored under the header (`absolute right-4 top-11 z-30`, same shell as the in-session search panel: `rounded-lg border border-border bg-popover shadow-lg`, max height with scroll, width about `20rem`). Two sections, `text-2xs` labels `mcp.title` and `skill.title`. Opening the panel fetches both lists. A fetch failure uses `setSendErr`.

  Each MCP row: name in `text-sm`, status in `text-2xs text-muted-foreground`. `failed` and `needs_client_registration` also show `error` truncated. `connected` gets a `mcp.disconnect` text button; `disabled` and `failed` get `mcp.connect`. `needs_auth` and `needs_client_registration` get no button. After a successful connect or disconnect, refetch the list. A failure uses `setSendErr`.

  Each skill row is a button: name, and description in `text-2xs text-muted-foreground` when present. Clicking sets the composer draft to `/name ` when the draft is empty, otherwise appends a newline and `/name `, focuses the textarea, and closes the panel. Do not show `content` or `location`.

  Empty lists use `mcp.empty` and `skill.empty`.

- [ ] **Step 5: Root `bun test`, root typecheck, and inside `apps/desktop/ui` both `bun run typecheck` and `bun run build`.** Commit `feat(ui): show MCP status and skills`.

---

## Done when

- An OpenCode session can list MCP servers and skills, connect or disconnect a server, and drop a skill into the composer.
- ACP has no tools button, and the disconnect route returns 400.
- Desktop check (user): the header plug opens the panel; a disabled server can be connected; a skill lands in the input as `/name`.
