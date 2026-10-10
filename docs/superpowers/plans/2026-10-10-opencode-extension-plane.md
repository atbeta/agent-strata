# OpenCode 扩展平面骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面端可以通过 strata 读取 OpenCode 的实时工作区状态（文件、命令、VCS、LSP/MCP 状态等），这些数据不进事件库；第一个可见用途是会话标题栏显示 git 分支。

**Architecture:** 这是路线图"两个平面"里的扩展平面（[`2026-10-10-opencode-first-class-roadmap.md`](./2026-10-10-opencode-first-class-roadmap.md) 第 2 项）。`BackendDriver` 增加可选的 `extension`，opencode 驱动用连接自己的 baseUrl、Basic 鉴权和工作目录实现一个只读、白名单内的 GET 透传；service 暴露两个入口：按连接的 `GET /connections/:id/opencode/<path>`（目录取查询参数，缺省为连接目录）和按会话的 `GET /sessions/:id/opencode/<path>`（目录由服务端取会话的工作区，UI 不需要知道连接 id 和目录）。这些读能碰到本机文件，所以扩展路由只对桌面壳的来源开放 CORS，并拒绝非回环地址的 Host（防 DNS 重绑定）。UI 通过 404 判断扩展是否可用，`/connections` 另外带 `capabilities.extension`。

**Tech Stack:** Bun 1.3、TypeScript、`Bun.serve`、Solid（桌面 UI）。

## Global Constraints

- 运行环境是 Windows PowerShell 5.1：**不要用 `&&` 串联命令**，逐条执行；判断 `bun run typecheck` 成败看 `$LASTEXITCODE`（它会把 `$ tsc ...` 打到 stderr，PowerShell 显示成红字 NativeCommandError，这不是失败）。
- 每个任务结束必须：`bun test` 全绿（3 个 e2e 用例 skip 是正常的）、`bun run typecheck` 后 `$LASTEXITCODE` 为 0；改了 UI 的任务额外在 `apps/desktop/ui` 目录里跑 `bun run typecheck`（`bun --cwd ... run` 在 Bun 1.3.14 下只打印用法、不跑 tsc）。
- 代码注释只写代码本身表达不了的约束，用英文，风格对齐现有代码；不要写"这里改了什么/为什么这么改"之类面向评审的注释。
- 提交信息沿用仓库风格：`type(scope): lower-case sentence`，英文。
- 扩展平面读到的任何东西都**不写入事件库**、不进 `/stream`。
- 扩展透传**只放行 GET**，只放行白名单里的路径；本计划不加任何写操作。
- UI 只做 Task 3 列出的改动（标题栏分支、图标、两条文案），其他视觉不动，不改 `apps/desktop/DESIGN.md`。
- 本地开发数据库 `~/.agent-strata/events.db` 可以随意清空；`policy.json`、`connection.json`/`connections.json` 不要删。
- 根目录和 `packages/service/test/` 下的 `.tmp-*` 文件是用户的调试产物，不要删除、不要提交。
- OpenCode 服务 `opencode serve` 运行在 `http://127.0.0.1:4096`，strata 服务在 `http://127.0.0.1:7700`，Task 4 会用到。
- 某一步的预期结果和实际不符、且原因不在本任务范围内时，**停下来报告**，不要去改计划外的代码。

## 规划时已核实的事实（执行者不需要再验证）

1. OpenCode 1.18.32 的 OpenAPI 里，白名单路径全部是 GET，参数都有 `directory`、`workspace`：`/find/file`（`query*`、`dirs`、`type`、`limit`）、`/find`（`pattern*`）、`/find/symbol`（`query*`）、`/file`（`path*`）、`/file/content`（`path*`）、`/file/status`、`/command`、`/agent`、`/skill`、`/vcs`、`/vcs/diff`（`mode*`、`context`）、`/lsp`、`/mcp`、`/formatter`、`/path`。`/mcp` 另有 POST、`/config` 有 GET 和 PATCH，都**不**放行。
2. SDK（`@opencode-ai/sdk` 1.18.35 `dist/v2/client.js`）对 GET 请求把目录放在查询参数 `directory`，对其他方法用请求头 `x-opencode-directory`。本计划只发 GET，所以用查询参数。
3. 实测返回：`/command` 是 `[{ name, description?, source?: "command"|"mcp"|"skill", agent?, model?, template, subtask?, hints: string[] }]`（含内置的 `init`）；`/find/file?query=driver&limit=5` 是相对路径字符串数组；`/vcs` 是 `{ branch, default_branch }`，不是 git 仓库时两个字段都是 `null`；`/path` 是 `{ home, state, config, worktree, directory }`。
4. opencode 驱动的连接 id 形如 `opencode:http://127.0.0.1:4096`，放进 URL 路径时要 `encodeURIComponent`；`url.pathname` 里 `%2F` 保持编码，所以 `[^/]+` 能取到整个 id。
5. `connectOpencode` 连上的条件是事件流的第一条事件：先试 `/global/event`（最多 3 秒），不行再试 `/event`。连上后 service 会调 `indexSessions`（`GET /session`）和后台 `sync`（`GET /project`、`GET /session`）。
6. `startService({ db: ":memory:" })` 不读也不写 `connections.json`。
7. 桌面壳的来源：打包后是 `http://tauri.localhost`（Windows）/ `tauri://localhost`（macOS），`tauri dev` 下页面来自 `http://localhost:5178`（`apps/desktop/src-tauri/tauri.conf.json` 的 `devUrl`），这三种情况 UI 都直接请求 `http://127.0.0.1:7700`。浏览器里跑的开发版走 Vite 代理 `/api`，是同源请求。
8. `App.tsx` 在连接和断开后派发 `window` 事件 `strata-connections`；`session-detail.tsx` 已经监听它（`onConns`）。
9. 在 Bun 里 `import("./apps/desktop/ui/src/api.ts")` 可以正常加载（`i18n.ts` 读 `localStorage` 时有 try/catch），所以 UI 的单测可以从 `./api` 导入运行时函数。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `packages/service/src/driver.ts` | 增加 `BackendExtension` 接口和 `BackendDriver.extension?` |
| `packages/service/src/opencode-extension.ts`（新建） | 白名单 `OPENCODE_EXTENSION_PATHS` 与 `opencodeExtension(...)`：拼 URL、带鉴权、决定目录 |
| `packages/service/src/opencode-driver.ts` | 给驱动挂上 `extension` |
| `packages/service/src/extension-route.ts`（新建） | 两个扩展入口的路由函数、来源与 Host 检查 |
| `packages/service/src/index.ts` | 接上路由；`/connections` 带 `capabilities.extension` |
| `packages/service/test/opencode-extension.test.ts`（新建） | `opencodeExtension` 单测（假的上游） |
| `packages/service/test/fake-opencode.ts`（新建） | 刚好够驱动连上的假 `opencode serve` |
| `packages/service/test/extension.test.ts`（新建） | 经过 service 的集成测试 |
| `apps/desktop/ui/src/api.ts` | `Connection.capabilities.extension`、`VcsInfo`、`opencodePath`、`readOpencode`、`readVcs` |
| `apps/desktop/ui/src/api.test.ts`（新建） | `opencodePath` 单测 |
| `apps/desktop/ui/src/icons.tsx` | 新图标 `branch` |
| `apps/desktop/ui/src/session-detail.tsx` | 标题栏显示分支 |
| `apps/desktop/ui/src/locales/{zh,en}/session.ts` | `header.branch.tip` |
| `scripts/probe-extension.ts`（新建） | 对运行中的 strata 做端到端检查 |
| `README.md` | 扩展平面一句话说明 |

---

### Task 1: 扩展接口与 OpenCode 实现

**Files:**
- Modify: `packages/service/src/driver.ts`
- Create: `packages/service/src/opencode-extension.ts`
- Modify: `packages/service/src/opencode-driver.ts`
- Test: `packages/service/test/opencode-extension.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces（`driver.ts`）：
  ```ts
  export interface BackendExtension {
    kind: "opencode";
    paths: ReadonlySet<string>;
    get(path: string, query: URLSearchParams, directory?: string): Promise<Response>;
  }
  // BackendDriver 增加：extension?: BackendExtension;
  ```
- Produces（`opencode-extension.ts`）：`export const OPENCODE_EXTENSION_PATHS: ReadonlySet<string>`；`export function opencodeExtension(opts: { baseUrl: string; directory?: string; username?: string; password?: string; fetch?: typeof fetch }): BackendExtension`。`get` 对白名单外的路径直接返回 404、不发请求；总是删掉调用方查询里的 `directory`，改用 `directory ?? opts.directory`（都没有就不带）。

- [ ] **Step 1: 写失败测试**

创建 `packages/service/test/opencode-extension.test.ts`：

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { OPENCODE_EXTENSION_PATHS, opencodeExtension } from "../src/opencode-extension";

describe("opencode extension", () => {
  const seen: { path: string; query: string; auth: string | null }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, query: url.search, auth: req.headers.get("authorization") });
      if (url.pathname === "/find/file" && !url.searchParams.get("query"))
        return Response.json({ error: "query required" }, { status: 400 });
      return Response.json({ path: url.pathname, directory: url.searchParams.get("directory") });
    },
  });
  afterAll(() => upstream.stop(true));
  const baseUrl = `http://127.0.0.1:${upstream.port}`;

  test("a read goes to the same path with the caller's query and strata's directory", async () => {
    const ext = opencodeExtension({ baseUrl, directory: "/conn" });
    const res = await ext.get(
      "/find/file",
      new URLSearchParams({ query: "driver", limit: "5", directory: "/elsewhere" }),
      "/repo",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/find/file", directory: "/repo" });
    const q = new URLSearchParams(seen.at(-1)!.query);
    expect(q.get("query")).toBe("driver");
    expect(q.get("limit")).toBe("5");
    expect(q.getAll("directory")).toEqual(["/repo"]);
  });

  test("without a session directory the connection's own is used, and none at all is fine", async () => {
    await opencodeExtension({ baseUrl, directory: "/conn" }).get("/vcs", new URLSearchParams());
    expect(new URLSearchParams(seen.at(-1)!.query).get("directory")).toBe("/conn");
    await opencodeExtension({ baseUrl: `${baseUrl}/` }).get("/vcs", new URLSearchParams({ directory: "/sneaky" }));
    expect(seen.at(-1)).toMatchObject({ path: "/vcs", query: "" });
  });

  test("the server's basic auth pair rides along", async () => {
    await opencodeExtension({ baseUrl, username: "opencode", password: "pw" }).get("/path", new URLSearchParams());
    expect(seen.at(-1)!.auth).toBe(`Basic ${btoa("opencode:pw")}`);
    await opencodeExtension({ baseUrl }).get("/path", new URLSearchParams());
    expect(seen.at(-1)!.auth).toBeNull();
  });

  test("the server's own error status comes back as is", async () => {
    const res = await opencodeExtension({ baseUrl }).get("/find/file", new URLSearchParams());
    expect(res.status).toBe(400);
  });

  test("a path off the list never leaves strata", async () => {
    const before = seen.length;
    const res = await opencodeExtension({ baseUrl }).get("/config", new URLSearchParams());
    expect(res.status).toBe(404);
    expect(seen.length).toBe(before);
    expect(OPENCODE_EXTENSION_PATHS.has("/config")).toBe(false);
    expect(OPENCODE_EXTENSION_PATHS.has("/command")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test packages/service/test/opencode-extension.test.ts`
Expected: FAIL（`Cannot find module '../src/opencode-extension'`）。

- [ ] **Step 3: 在 `driver.ts` 加接口**

`packages/service/src/driver.ts`，在 `export interface SyncGuard { ... }` 之前插入：

```ts
/**
 * Live state a backend holds outside any session's record: files, commands,
 * VCS. Read through on demand and never written to the log.
 */
export interface BackendExtension {
  kind: "opencode";
  /** the backend API paths a client may read */
  paths: ReadonlySet<string>;
  get(path: string, query: URLSearchParams, directory?: string): Promise<Response>;
}
```

在 `BackendDriver` 接口里，`capabilities: BackendCapabilities;` 之后加一行：

```ts
  /** absent for a backend with nothing beyond the command plane */
  extension?: BackendExtension;
```

- [ ] **Step 4: 新建 `opencode-extension.ts`**

创建 `packages/service/src/opencode-extension.ts`：

```ts
import type { BackendExtension } from "./driver";

/** Read-only OpenCode endpoints the desktop may reach through strata. */
export const OPENCODE_EXTENSION_PATHS: ReadonlySet<string> = new Set([
  "/find/file",
  "/find",
  "/find/symbol",
  "/file",
  "/file/content",
  "/file/status",
  "/command",
  "/agent",
  "/skill",
  "/vcs",
  "/vcs/diff",
  "/lsp",
  "/mcp",
  "/formatter",
  "/path",
]);

const TIMEOUT_MS = 15_000;

export function opencodeExtension(opts: {
  baseUrl: string;
  directory?: string;
  username?: string;
  password?: string;
  fetch?: typeof fetch;
}): BackendExtension {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> =
    opts.username !== undefined || opts.password !== undefined
      ? { authorization: `Basic ${btoa(`${opts.username ?? ""}:${opts.password ?? ""}`)}` }
      : {};
  const doFetch = opts.fetch ?? fetch;
  return {
    kind: "opencode",
    paths: OPENCODE_EXTENSION_PATHS,
    get(path, query, directory) {
      if (!OPENCODE_EXTENSION_PATHS.has(path)) return Promise.resolve(new Response(null, { status: 404 }));
      const q = new URLSearchParams(query);
      // The directory is strata's to choose (the session's, else the
      // connection's), never the caller's.
      q.delete("directory");
      const dir = directory ?? opts.directory;
      if (dir) q.set("directory", dir);
      const qs = q.toString();
      return doFetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    },
  };
}
```

- [ ] **Step 5: 运行，确认通过**

Run: `bun test packages/service/test/opencode-extension.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 6: 驱动挂上扩展**

`packages/service/src/opencode-driver.ts`：在 `import type { BackendDriver } from "./driver";` 之后加：

```ts
import { opencodeExtension } from "./opencode-extension";
```

在返回对象里，`capabilities: { ... },` 之后加：

```ts
    extension: opencodeExtension({
      baseUrl: opts.baseUrl,
      directory: opts.directory,
      username: opts.username,
      password: opts.password,
    }),
```

- [ ] **Step 7: 全量验证**

Run: `bun test`
Expected: 全绿。

Run: `bun run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

- [ ] **Step 8: Commit**

```powershell
git add packages/service/src/driver.ts packages/service/src/opencode-extension.ts packages/service/src/opencode-driver.ts packages/service/test/opencode-extension.test.ts
git commit -m "feat(service): give the opencode driver a read-only extension for live workspace state"
```

---

### Task 2: service 的两个扩展入口

**Files:**
- Create: `packages/service/src/extension-route.ts`
- Modify: `packages/service/src/index.ts`（import 区；`/connections` 路由，约第 604 行；`const discMatch` 之前，约第 703 行）
- Create: `packages/service/test/fake-opencode.ts`
- Test: `packages/service/test/extension.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `BackendExtension`、`BackendDriver.extension`。
- Produces（`extension-route.ts`）：
  - `export function isLoopbackHost(host: string | null): boolean`
  - `export function shellCors(origin: string | null): Record<string, string>`（来源是桌面壳时返回 `{ "access-control-allow-origin": origin, vary: "origin" }`，否则 `{}`）
  - `export async function extensionRoute(req: Request, url: URL, resolve: { connection(id: string): BackendDriver | undefined; session(casfId: string): { driver: BackendDriver; directory?: string } | undefined }): Promise<Response | undefined>`：路径不是 `/(connections|sessions)/:id/<kind>/<path>` 时返回 `undefined`；非 GET 返回 405；Host 不是回环地址返回 403；找不到驱动、驱动没有该 `kind` 的扩展、路径不在白名单时返回 404；上游异常返回 502；否则透传上游的状态码、正文和 `content-type`。
- Produces（HTTP）：
  - `GET /connections/:id/opencode/<path>[?...]`：目录取查询参数 `directory`，缺省为连接目录。
  - `GET /sessions/:id/opencode/<path>[?...]`：目录取会话工作区，查询里的 `directory` 被忽略；会话不属于一个已连接的 OpenCode 时 404。
  - `GET /connections` 每项的 `capabilities` 多一个 `extension: "opencode"`（没有扩展的连接不带这个字段）。

- [ ] **Step 1: 写假的 opencode serve**

创建 `packages/service/test/fake-opencode.ts`：

```ts
/** Just enough of `opencode serve` for a driver to connect, plus whatever a test adds. */
export function fakeOpencode(routes: Record<string, (url: URL) => Response> = {}) {
  const seen: { path: string; query: URLSearchParams }[] = [];
  const stream = (frame: unknown) =>
    new Response(
      new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, query: url.searchParams });
      if (url.pathname === "/global/event")
        return stream({ directory: "/repo", payload: { type: "server.connected", properties: {} } });
      if (url.pathname === "/event") return stream({ type: "server.connected", properties: {} });
      const route = routes[url.pathname];
      if (route) return route(url);
      if (url.pathname === "/session" || url.pathname === "/project") return Response.json([]);
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}
```

- [ ] **Step 2: 写失败的集成测试**

创建 `packages/service/test/extension.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { isLoopbackHost, shellCors } from "../src/extension-route";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";

describe("the opencode extension through strata", () => {
  const upstream = fakeOpencode({
    "/command": () => Response.json([{ name: "init", template: "x", hints: [] }]),
    "/find/file": (url) =>
      url.searchParams.get("query")
        ? Response.json([`${url.searchParams.get("directory")}/a.ts`])
        : Response.json({ error: "query required" }, { status: 400 }),
    "/vcs": (url) => Response.json({ branch: "main", directory: url.searchParams.get("directory") }),
    "/config": () => Response.json({ secret: true }),
  });
  let svc: ReturnType<typeof startService>;
  let base = "";
  let connId = "";
  beforeAll(async () => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: upstream.baseUrl, directory: "/conn" }),
    });
    connId = ((await res.json()) as { id: string }).id;
  });
  afterAll(() => {
    svc.stop();
    upstream.stop();
  });
  const conn = (p: string) => `${base}/connections/${encodeURIComponent(connId)}/opencode${p}`;
  const hits = (path: string) => upstream.seen.filter((s) => s.path === path).length;

  test("the connection lists the extension it carries", async () => {
    const { connections } = (await fetch(`${base}/connections`).then((r) => r.json())) as {
      connections: { capabilities: { extension?: string } }[];
    };
    expect(connections[0]!.capabilities.extension).toBe("opencode");
  });

  test("a connection read passes through with the asked directory, else the connection's", async () => {
    expect(await fetch(conn("/command")).then((r) => r.json())).toEqual([{ name: "init", template: "x", hints: [] }]);
    expect(await fetch(conn("/vcs?directory=%2Frepo%2Fb")).then((r) => r.json())).toEqual({
      branch: "main",
      directory: "/repo/b",
    });
    expect(((await fetch(conn("/vcs")).then((r) => r.json())) as { directory: string }).directory).toBe("/conn");
  });

  test("the server's own error comes back with its status", async () => {
    expect((await fetch(conn("/find/file"))).status).toBe(400);
  });

  test("a session read uses the session's workspace, not the caller's", async () => {
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_x",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "x", workspace: "/repo/x" },
      } as EventInput),
    ]);
    const res = await fetch(
      `${base}/sessions/${encodeURIComponent("opencode:ses_x")}/opencode/find/file?query=a&directory=%2Fother`,
    );
    expect(await res.json()).toEqual(["/repo/x/a.ts"]);
  });

  test("anything off the list, any other method, another backend's session, or an unknown connection goes nowhere", async () => {
    const commands = hits("/command");
    expect((await fetch(conn("/config"))).status).toBe(404);
    expect((await fetch(conn("/command"), { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/sessions/${encodeURIComponent("acp:mock:1")}/opencode/command`)).status).toBe(404);
    expect(
      (await fetch(`${base}/connections/${encodeURIComponent("opencode:http://nowhere")}/opencode/command`)).status,
    ).toBe(404);
    expect(hits("/config")).toBe(0);
    expect(hits("/command")).toBe(commands);
  });

  test("only the desktop shell may read a response from another origin", async () => {
    const from = (origin: string) => fetch(conn("/command"), { headers: { origin } });
    expect((await from("http://tauri.localhost")).headers.get("access-control-allow-origin")).toBe(
      "http://tauri.localhost",
    );
    expect((await from("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    expect(shellCors("tauri://localhost")).toEqual({ "access-control-allow-origin": "tauri://localhost", vary: "origin" });
    expect(shellCors("http://localhost:5178")["access-control-allow-origin"]).toBe("http://localhost:5178");
    expect(shellCors(null)).toEqual({});
  });

  test("a request that names any host but this machine's loopback is refused", () => {
    expect(isLoopbackHost("127.0.0.1:7700")).toBe(true);
    expect(isLoopbackHost("localhost:5178")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("evil.example")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });
});
```

- [ ] **Step 3: 运行，确认失败**

Run: `bun test packages/service/test/extension.test.ts`
Expected: FAIL（`Cannot find module '../src/extension-route'`）。

- [ ] **Step 4: 新建路由函数**

创建 `packages/service/src/extension-route.ts`：

```ts
import type { BackendDriver } from "./driver";

// Extension reads reach files and config on this machine. Unlike the rest of
// the service they are not readable from any page the user happens to visit:
// only the desktop shell's origins get CORS. The last two are `tauri dev`,
// whose page comes from the Vite port in apps/desktop/src-tauri/tauri.conf.json.
const SHELL_ORIGINS: ReadonlySet<string> = new Set([
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
  "http://localhost:5178",
  "http://127.0.0.1:5178",
]);

/** A Host naming anything else is a DNS-rebound page, not this machine's shell. */
export function isLoopbackHost(host: string | null): boolean {
  return host !== null && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
}

export function shellCors(origin: string | null): Record<string, string> {
  return origin !== null && SHELL_ORIGINS.has(origin)
    ? { "access-control-allow-origin": origin, vary: "origin" }
    : {};
}

/** GET /connections/:id/<kind>/<path> and /sessions/:id/<kind>/<path>; undefined for anything else. */
export async function extensionRoute(
  req: Request,
  url: URL,
  resolve: {
    connection(id: string): BackendDriver | undefined;
    session(casfId: string): { driver: BackendDriver; directory?: string } | undefined;
  },
): Promise<Response | undefined> {
  const m = url.pathname.match(/^\/(connections|sessions)\/([^/]+)\/([a-z]+)(\/.+)$/);
  if (!m) return undefined;
  const headers = shellCors(req.headers.get("origin"));
  const fail = (status: number, error: string) => Response.json({ error }, { status, headers });
  if (req.method !== "GET") return fail(405, "method not allowed");
  if (!isLoopbackHost(req.headers.get("host"))) return fail(403, "forbidden");
  const id = decodeURIComponent(m[2]!);
  const kind = m[3]!;
  const path = m[4]!;
  let driver: BackendDriver | undefined;
  let directory: string | undefined;
  if (m[1] === "sessions") {
    const owned = resolve.session(id);
    driver = owned?.driver;
    directory = owned?.directory;
  } else {
    driver = resolve.connection(id);
    directory = url.searchParams.get("directory") ?? undefined;
  }
  const ext = driver?.extension;
  if (!ext || ext.kind !== kind || !ext.paths.has(path)) return fail(404, "not found");
  try {
    const res = await ext.get(path, url.searchParams, directory);
    return new Response(res.body, {
      status: res.status,
      headers: { ...headers, "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (e) {
    return fail(502, String(e));
  }
}
```

- [ ] **Step 5: 接进 service**

`packages/service/src/index.ts`：

(a) 在 `import { agentNameOf, connectionMemory, endpointOf, type ConnectBody } from "./connections";` 之后加：

```ts
import { extensionRoute } from "./extension-route";
```

(b) `/connections` 路由里，把

```ts
            capabilities: c.capabilities,
```

改为

```ts
            capabilities: { ...c.capabilities, extension: c.extension?.kind },
```

(c) 在 `const discMatch = path.match(/^\/connections\/([^/]+)$/);` 这一行之前插入：

```ts
      const extension = await extensionRoute(req, url, {
        connection: (id) => conns.get(id),
        session: (casfId) => {
          const driver = driverFor(casfId);
          // driverFor falls back to the only connection; the session must be one of its own
          if (!driver?.nativeId(casfId)) return undefined;
          return { driver, directory: directoryOf(casfId) };
        },
      });
      if (extension) return extension;
```

- [ ] **Step 6: 运行，确认通过**

Run: `bun test packages/service/test/extension.test.ts`
Expected: PASS（7 个用例）。

如果 `beforeAll` 里的连接失败，是因为驱动连上时请求了假服务没有的端点：在 `fake-opencode.ts` 的默认分支里给那个路径补一个最小的合法返回（比如空数组），并在报告里写明是哪个路径。

- [ ] **Step 7: 全量验证**

Run: `bun test`
Expected: 全绿。

Run: `bun run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

- [ ] **Step 8: Commit**

```powershell
git add packages/service/src/extension-route.ts packages/service/src/index.ts packages/service/test/fake-opencode.ts packages/service/test/extension.test.ts
git commit -m "feat(service): read through to an allow-listed set of opencode endpoints per connection and per session"
```

---

### Task 3: UI 读扩展，标题栏显示分支

**Files:**
- Modify: `apps/desktop/ui/src/api.ts`
- Create: `apps/desktop/ui/src/api.test.ts`
- Modify: `apps/desktop/ui/src/icons.tsx`
- Modify: `apps/desktop/ui/src/session-detail.tsx`
- Modify: `apps/desktop/ui/src/locales/zh/session.ts`
- Modify: `apps/desktop/ui/src/locales/en/session.ts`

**Interfaces:**
- Consumes: Task 2 的 `GET /sessions/:id/opencode/<path>`（扩展不可用时 404）和 `/connections` 的 `capabilities.extension`。
- Produces（`api.ts`）：
  - `Connection.capabilities.extension?: "opencode"`
  - `export interface VcsInfo { branch?: string | null; default_branch?: string | null }`
  - `export function opencodePath(sessionId: string, path: string, query?: Record<string, string | number>): string`
  - `export async function readOpencode<T>(sessionId: string, path: string, query?: Record<string, string | number>): Promise<T | undefined>`（404 时返回 `undefined`，其他错误抛出）
  - `export function readVcs(sessionId: string): Promise<VcsInfo | undefined>`
- Produces（`icons.tsx`）：图标名 `"branch"`。

- [ ] **Step 1: 写失败测试**

创建 `apps/desktop/ui/src/api.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { opencodePath } from "./api";

describe("a read of a session's opencode backend", () => {
  test("names the session and the path", () => {
    expect(opencodePath("opencode:ses_1", "/vcs")).toBe("/sessions/opencode%3Ases_1/opencode/vcs");
  });

  test("carries its query", () => {
    expect(opencodePath("opencode:ses_1", "/find/file", { query: "a b", limit: 5 })).toBe(
      "/sessions/opencode%3Ases_1/opencode/find/file?query=a+b&limit=5",
    );
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `bun test apps/desktop/ui/src/api.test.ts`
Expected: FAIL（`opencodePath` 未导出）。

- [ ] **Step 3: 实现 api 函数**

`apps/desktop/ui/src/api.ts`：

(a) `Connection` 接口的 `capabilities` 里，`manage?: boolean;` 之后加：

```ts
    /** live workspace state this backend can be read for; absent for a backend with none */
    extension?: "opencode";
```

(b) 在 `export interface OptionsResponse {` 之前插入：

```ts
export interface VcsInfo {
  /** null outside a git repository */
  branch?: string | null;
  default_branch?: string | null;
}
```

(c) 在 `export async function readViewTail(` 之前插入：

```ts
/** A read of the session's OpenCode backend beyond its record: files, commands, VCS. */
export function opencodePath(sessionId: string, path: string, query?: Record<string, string | number>): string {
  const q = query ? new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : "";
  return `/sessions/${encodeURIComponent(sessionId)}/opencode${path}${q ? `?${q}` : ""}`;
}

/** Undefined when the session's backend has no OpenCode extension: another backend, or not connected. */
export async function readOpencode<T>(
  sessionId: string,
  path: string,
  query?: Record<string, string | number>,
): Promise<T | undefined> {
  const res = await fetch(api(opencodePath(sessionId, path, query)));
  if (res.status === 404) return undefined;
  await throwOnError(res);
  return (await res.json()) as T;
}

export function readVcs(sessionId: string): Promise<VcsInfo | undefined> {
  return readOpencode<VcsInfo>(sessionId, "/vcs");
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `bun test apps/desktop/ui/src/api.test.ts`
Expected: PASS。

- [ ] **Step 5: 加 `branch` 图标**

`apps/desktop/ui/src/icons.tsx`：`type Name` 联合类型末尾把

```ts
  | "wrench";
```

改为

```ts
  | "wrench"
  | "branch";
```

在 `if (props.name === "wrench")` 那个分支之后、最后的默认 `return (` 之前插入：

```tsx
  if (props.name === "branch")
    return (
      <Glyph class={props.class}>
        <circle cx="5" cy="3.8" r="1.4" />
        <circle cx="5" cy="12.2" r="1.4" />
        <circle cx="11" cy="5.8" r="1.4" />
        <path d="M5 5.2v5.6" />
        <path d="M11 7.2c0 2.4-2.2 3-6 3.6" />
      </Glyph>
    );
```

- [ ] **Step 6: 加文案**

`apps/desktop/ui/src/locales/zh/session.ts`，在 `"header.export": "导出会话记录",` 之后加：

```ts
  "header.branch.tip": "当前 Git 分支",
```

`apps/desktop/ui/src/locales/en/session.ts`，在 `"header.export": "Export transcript",` 之后加：

```ts
  "header.branch.tip": "Current Git branch",
```

- [ ] **Step 7: 会话页读分支并显示**

`apps/desktop/ui/src/session-detail.tsx`：

(a) `from "./api"` 的 import 列表里加 `readVcs,`（按现有字母顺序放）。

(b) 在 `const [maxSeq, { refetch: refetchSeq }] = createResource(() => props.id, readHead);` 之后插入：

```ts
  // Live machine state, not part of the record: it shows only while the
  // session's OpenCode backend is connected, and follows a checkout made
  // outside strata once the window comes back.
  const [vcs, { refetch: refetchVcs }] = createResource(
    () => props.id,
    (id) => readVcs(id).catch(() => undefined),
  );
```

(c) 在 `onMount` 里把

```ts
    const onConns = () => refetchOptions();
    window.addEventListener("strata-connections", onConns);
```

改为

```ts
    const onConns = () => {
      refetchOptions();
      refetchVcs();
    };
    window.addEventListener("strata-connections", onConns);
    const onFocus = () => refetchVcs();
    window.addEventListener("focus", onFocus);
```

并在同一个 `onMount` 的 `onCleanup` 里，`window.removeEventListener("strata-connections", onConns);` 之后加：

```ts
      window.removeEventListener("focus", onFocus);
```

(d) 标题栏里，在显示工作区名的那个 `<Show when={realWorkspace(v().workspace)}> ... </Show>` 结束之后、同一个 `<div class="flex min-w-0 flex-1 items-baseline gap-2">` 结束之前插入：

```tsx
                  <Show when={settled(vcs)?.branch}>
                    {(branch) => (
                      <Tip label={t("header.branch.tip")}>
                        <span class="flex max-w-32 shrink-0 items-center gap-1 font-mono text-2xs text-muted-foreground">
                          <Icon name="branch" class="h-3 w-3 shrink-0" />
                          <span class="truncate">{branch()}</span>
                        </span>
                      </Tip>
                    )}
                  </Show>
```

- [ ] **Step 8: 全量验证**

Run: `bun test`
Expected: 全绿。

Run: `bun run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

在 `apps/desktop/ui` 目录里 Run: `bun run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

- [ ] **Step 9: Commit**

```powershell
git add apps/desktop/ui/src/api.ts apps/desktop/ui/src/api.test.ts apps/desktop/ui/src/icons.tsx apps/desktop/ui/src/session-detail.tsx apps/desktop/ui/src/locales/zh/session.ts apps/desktop/ui/src/locales/en/session.ts
git commit -m "feat(desktop-ui): show the git branch of a session's opencode workspace"
```

---

### Task 4: 端到端探针与 README

**Files:**
- Create: `scripts/probe-extension.ts`
- Modify: `README.md`（`## Data model` 列表、`## Security model` 段落）

**Interfaces:**
- Consumes: Task 1–3 的全部行为；运行中的 `opencode serve`（4096）和用当前代码启动的 strata 服务（7700）。
- Produces: `bun run scripts/probe-extension.ts`，通过时退出码为 0，并打印 JSON 报告。

- [ ] **Step 1: 写探针脚本**

创建 `scripts/probe-extension.ts`：

```ts
// Reads through strata's OpenCode extension plane the way the desktop does:
// the connection says it carries the extension, one of its sessions can list
// commands, find a file and name its branch, the connection can be read
// directly, and a path off the allow-list is refused. Nothing is written.
//
//   bun run scripts/probe-extension.ts
//
// STRATA_URL (default http://127.0.0.1:7700), PROBE_DIR (default the current
// directory: a session in it is preferred).

const ST = process.env.STRATA_URL ?? "http://127.0.0.1:7700";
const dir = (process.env.PROBE_DIR ?? process.cwd()).toLowerCase();
const get = (p: string) => fetch(`${ST}${p}`);

const { connections } = (await get("/connections").then((r) => r.json())) as {
  connections: { id: string; capabilities: { extension?: string } }[];
};
const conn = connections.find((c) => c.capabilities.extension === "opencode");
const { sessions } = (await get("/sessions?backend=opencode&limit=200").then((r) => r.json())) as {
  sessions: { summary: { session_id: string }; workspace?: string }[];
};
const real = sessions.filter((s) => s.workspace && s.workspace !== "unknown" && s.workspace !== "no workspace");
const session = real.find((s) => s.workspace!.toLowerCase() === dir) ?? real[0];
const at = (p: string) => `/sessions/${encodeURIComponent(session!.summary.session_id)}/opencode${p}`;

const commands = session ? ((await get(at("/command")).then((r) => r.json())) as { name: string }[]) : [];
const files = session ? ((await get(at("/find/file?query=package.json&limit=5")).then((r) => r.json())) as unknown) : null;
const vcs = session ? ((await get(at("/vcs")).then((r) => r.json())) as { branch?: string | null }) : {};
const offList = session ? (await get(at("/config"))).status : 0;
const viaConnection = conn ? (await get(`/connections/${encodeURIComponent(conn.id)}/opencode/path`)).status : 0;

const report = {
  connection: conn?.id ?? null,
  session: session?.summary.session_id ?? null,
  workspace: session?.workspace ?? null,
  commands: commands.map((c) => c.name),
  files,
  branch: vcs.branch ?? null,
  off_list_status: offList,
  connection_read_status: viaConnection,
};
console.log(JSON.stringify(report, null, 2));
const ok =
  conn !== undefined &&
  session !== undefined &&
  commands.some((c) => c.name === "init") &&
  Array.isArray(files) &&
  offList === 404 &&
  viaConnection === 200;
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: 用当前代码重启 strata 服务**

先结束占用 7700 端口的旧服务进程：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 7700 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

再在单独的终端里启动：

```powershell
$env:STRATA_DB="$HOME\.agent-strata\events.db"; $env:STRATA_PORT="7700"; bun run packages/service/src/index.ts
```

Expected: 打印 `agent-strata service listening on http://127.0.0.1:7700`，几秒内出现 `auto-connected backend opencode:http://127.0.0.1:4096`。

- [ ] **Step 3: 跑探针**

Run: `bun run scripts/probe-extension.ts`，然后 `$LASTEXITCODE`
Expected: `0`；`commands` 包含 `init`，`files` 是数组（工作区是本仓库时包含 `package.json`），`branch` 是本仓库所在分支（`main`），`off_list_status` 为 `404`，`connection_read_status` 为 `200`。

- [ ] **Step 4: 更新 README**

`README.md` 的 `## Data model` 列表里，在 `- **Streaming snapshots are never stored.** ...` 这一条之后加：

```
- **Live workspace state is not part of the record.** `GET /sessions/:id/opencode/<path>` and `GET /connections/:id/opencode/<path>` read through to an allow-listed set of OpenCode endpoints (files, find, commands, agents, skills, VCS, LSP/MCP/formatter status, paths); the session form uses the session's workspace as the directory. Nothing read this way is stored.
```

`## Security model` 段落末尾加一句：

```
Extension reads (`/…/opencode/<path>`) reach files on this machine, so they are GET-only, allow-listed, refused for a Host other than the loopback address, and readable cross-origin only by the desktop shell.
```

- [ ] **Step 5: 全量验证**

Run: `bun test`
Expected: 全绿。

Run: `bun run typecheck`，然后 `$LASTEXITCODE`
Expected: `0`。

- [ ] **Step 6: Commit**

```powershell
git add scripts/probe-extension.ts README.md
git commit -m "test(scripts): probe the opencode extension plane through a running strata"
```

- [ ] **Step 7: 请用户在桌面壳里确认**

请用户运行 `bun x tauri dev --config apps/desktop/src-tauri/tauri.conf.json`（7700 上的服务已经是新代码），然后确认：

1. 打开一个工作区在 git 仓库里的 OpenCode 会话，标题栏工作区名后面出现分支名（带分支图标，悬停提示"当前 Git 分支"）。
2. 在侧栏菜单里断开 OpenCode 连接，分支名消失；重新连接后再出现。
3. 在终端里切换该仓库的分支，再切回窗口，分支名跟着更新。

---

## 自查

- 路线图第 2 项的三点：`BackendDriver.extension`（Task 1）、`/connections/:id/opencode/*` 白名单透传与 ACP 404（Task 2）、UI 的按会话 client 与 `capabilities.extension`（Task 2、3）都有对应任务。路线图验收里"在 UI 里列出命令、搜索文件"的界面属于第 3 项输入框（`/` 菜单与 `@` 补全），本计划由 Task 4 的探针验证同一条读路径，UI 用标题栏分支验证"连接时出现、断开时消失"。
- 白名单在 `opencodeExtension.get` 和路由各检查一次：路由检查保证白名单外的请求不进驱动，`get` 的检查保证别的调用方也绕不过去。
- 类型和名字前后一致：`BackendExtension { kind, paths, get }`、`OPENCODE_EXTENSION_PATHS`、`opencodeExtension`、`extensionRoute`、`isLoopbackHost`、`shellCors`、`opencodePath`、`readOpencode`、`readVcs`、`VcsInfo`、`header.branch.tip`、图标 `branch`。
