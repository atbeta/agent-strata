# Webhook 触发会话：首版实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 外部系统（代码仓、CI、IM 机器人……任何能发 HTTP 的工具）往一个固定地址 POST 一段 JSON，strata 就在一个指定工作区里新建一个会话，并把一条固定指令发过去。

**Architecture:** 一方内置插件 `packages/plugin-webhook` 负责全部业务：鉴权、去重、匹配、落库、后台派发。core 只做一处改动——让 `POST /plugins/webhook/in/<endpoint_id>` 这一条路径**跳过桌面全局 token**，其余一切照旧（管理接口仍然要 token）。凭据由插件自己验，core 不知道也不需要知道。

**Tech Stack:** Bun 1.3、TypeScript、bun:sqlite 之外的纯 JSON 文件（与 `plugin-schedule` 一致）、SolidJS 1.x（设置页一节）、`bun:test`。

## Global Constraints

- 检查：`bun run typecheck`、`bun run lint`（警告即失败）、`bun test packages`、`bun run test:ui`；最后 `bun run sidecar` 确认插件被打进 sidecar。
- core 的改动必须**只有一处语义**：某条路径不再需要桌面 token。其他路由的行为一个字节都不许变。
- 入站的信任模型：路径上的 `endpoint_id` 是公开标识（128 位随机，不是秘密）；秘密在 header 里。**绝不能把凭据放进 URL**——URL 会进代理日志、进 Referer、进浏览历史。
- service 继续只监听 `127.0.0.1`。公网可达这件事由用户的隧道/反代负责，不由本应用负责。
- 首版不做的事一律写进 §11，别在实现中顺手加。

---

## 1. 首版的样子

一次投递只做这几件事：

```text
外部工具 POST /plugins/webhook/in/wh_xxxx
  -> core：这条路径免 token（其余路由不变）
  -> 插件：读 body（数着字节）-> 验签 -> 认事件 id -> 看事件名对不对
  -> 插件：落库（先落库再回包）-> 回 202
  -> 后台：挑一个能 prompt 的连接 -> 新建会话 -> 立刻记住 session_id -> 发 prompt -> 记 accepted
```

一个端点长这样：

```jsonc
{
  "id": "wh_9f3c…",              // 出现在 URL 里，不是秘密
  "name": "gitlab-mr-comment",
  "enabled": true,
  "directory": "/Users/me/work/repo",   // 必须是已知工作区
  "agent": "opencode",            // 可选：空 = 任意能 prompt 的连接
  "auth": { "mode": "hmac", "header": "X-Signature-256" },
  "match": { "path": "object_kind", "equals": "note" },  // 可选
  "instruction": "看看这条评论，必要时改代码。",             // 必填
  "dedupe": true
}
```

## 2. 端点模型

### 2.1 鉴权（两种，别的以后再说）

| `auth.mode` | 校验什么 | 谁用 |
| --- | --- | --- |
| `hmac` | 请求头里的签名 = HMAC-SHA256(secret, 原文)，hex 小写；允许 `sha256=` 前缀。原文默认是 body；若请求带了时间戳头（默认 `X-Webhook-Timestamp`，unix 秒），原文是 `timestamp.body`，且时间戳必须落在 ±5 分钟内 | GitHub（`X-Hub-Signature-256`）、任何支持自定义签名的工具 |
| `secret` | 请求头的值 = 密钥，常量时间比较。头名可配（默认 `X-Webhook-Token`）；头名是 `authorization` 时自动剥掉 `Bearer ` | GitLab（`X-Gitlab-Token`）、自研脚本 |

- `hmac` 要原文密钥，**存原文**；`secret` 只存 SHA-256，比较时对收到的值取哈希再比。两者都只在创建/轮换时显示一次，管理接口永远不返回。
- 验签失败一律 **401**，不区分原因（不知道 secret 就不该知道差在哪）。
- `hmac` 模式下的时间戳窗口是防重放的；没有时间戳头就是纯 body 签名，此时靠去重兜底。

### 2.2 去重

- 事件 id 取请求头里第一个存在的：`Idempotency-Key` → `X-GitHub-Delivery` → `X-Request-Id`。
- 一个都没有：`dedupe: false` 的端点每次都算新事件；`dedupe: true` 的端点此时**不建会话**，直接 202 忽略（没有稳定 id 就无法保证不重复，宁可不触发）。
- 判重依据是 `UNIQUE(endpoint_id, event_id)`。重复请求返回原来那条 delivery，body 里带 `"duplicate": true`，**不再建会话**。

### 2.3 匹配（一条）

`match` 是可选的，形状只有一种：从 body 的 JSON 里按点分路径取一个值（`object_kind`、`event_name` 这种），和 `equals` 比。

- 不配置 = 全触发。
- 不相等 = 记为 `ignored`，**仍然回 202**。调用方把非 2xx 当投递失败，GitLab 连拒几次就会自动停用这个 hook。
- body 不是 JSON 对象（数组、标量）= 视作没有可匹配的值。

### 2.4 prompt（没有模板）

发给会话的文本固定三段：

```text
[webhook:<name> delivery:<delivery_id>]      ← 第一行固定，用户改不掉

<instruction>                                 ← 用户在端点里写的一段话，必填

<payload>                                     ← 原始 body 的 JSON 文本，超过 16KB 截断
```

- 第一行既是来源说明（和 schedule 插件的 `[scheduled: …]` 同一惯例），也是崩溃恢复时的对账依据（§4.3）。
- 没有 `{{…}}` 模板、没有变量、没有多种 content-type 解析：body 一律按 JSON 收，收不了就 415。

## 3. core 改动（一处）

### 3.1 豁免名单放在 host 侧

豁免名单**不进 `plugin-sdk` 的 manifest**。`RegisteredPlugin` 是 service 内部的类型（`packages/service/src/plugins/host.ts:57`），第三方插件够不着它；将来做第三方插件（M4）时，公网入口是另一套机制。

`packages/service/src/plugins/host.ts`：

```ts
export interface PluginIngress {
  method: string;
  path: RegExp;
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  create: () => StrataPlugin;
  /** A path this plugin answers without the desktop token. */
  ingress?: PluginIngress;
}
```

`PluginHost.register()`（`host.ts:136`）把 `entry.ingress` 收进 `this.registered`，并加一个查询口：

```ts
/** The ingress that owns this path and method, if one does. */
ingressFor(pathname: string, method: string): PluginIngress | undefined {
  for (const entry of this.registered.values()) {
    const ingress = entry.ingress;
    if (!ingress) continue;
    if (ingress.method !== method) continue;
    if (ingress.path.test(pathname)) return ingress;
  }
  return undefined;
}
```

### 3.2 鉴权判断

`packages/service/src/index.ts`（现在 1029-1039 行那一段）改成：

```ts
const url = new URL(req.url);
const ingress = plugins.ingressFor(url.pathname, req.method);
if (ingress) {
  // A webhook caller is not a browser page: only the Host matters here.
  // The credential the plugin checks is the real gate.
  if (!isLoopbackHost(req.headers.get("host"))) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: allow });
  }
} else if (refused(req)) {
  return Response.json({ error: "forbidden" }, { status: 403, headers: allow });
}
```

然后 token 判断里加一个分支：

```ts
const authorized =
  ingress !== undefined ||
  tokenOk(req, apiToken) ||
  (browserless && queryTokenOk(url, apiToken)) ||
  ticketAuthorized;
```

要点：

- **豁免是路径作用域的，不是插件作用域的。** 所以 `/plugins/webhook/endpoints` 这些管理接口**自动**仍然要桌面 token，插件侧一行都不用写。
- **`refused()` 对入口放宽 Origin 判断**：`packages/service/src/shell-origin.ts:29` 的 `fromAnotherSite` 见到任何 `Origin` 头就拒绝，而 CI、curl 之外的不少工具会带 `Origin`。入口不是浏览器面，凭据才是闸门，所以入口只查 Host 是否 loopback。其余路由的 `refused()` 一个字不改。
- **body 上限不进 core。** core 的全局上限仍是 80MB（`index.ts:76`）。256KB 由插件自己数：读 body 时边读边计数，超了回 413。这样 core 不需要缓冲再重建 `Request`（Fetch 的 body 只能读一次，插件还要拿原文验签）。
- **插件停用 → 404**：插件没在 running 状态时 `host.route()` 返回 undefined，路由层回 404（`plugins/routes.ts:291`）。这是"跳过 token"而不是"core 代答"的另一个好处。

### 3.3 一处要改的既有测试

`packages/service/test/plugins.test.ts:761` 断言全新安装的内置插件恰为：

```ts
expect(listing.plugins.map((p) => p.id).sort()).toEqual(["background", "dev", "schedule", "sessions"]);
```

加进 `"webhook"`。

## 4. 插件 `packages/plugin-webhook`

### 4.1 文件

```text
src/index.ts      manifest、生命周期、入口路由、管理路由
src/auth.ts       §2.1 的两种验签（纯函数）
src/store.ts      endpoints.json / deliveries.json，0600，临时文件 + rename
src/worker.ts     派发、重试、启动恢复
test/auth.test.ts
test/store.test.ts
test/worker.test.ts
```

`package.json` 照 `packages/plugin-schedule/package.json` 写：name `@agent-strata/plugin-webhook`，依赖 `@agent-strata/plugin-sdk` 和 `@agent-strata/projector`（用它的 `SessionView` 类型）。

manifest：

```ts
export const manifest: PluginManifest = {
  id: "webhook",
  name: "Webhooks",
  version: "1.0.0",
  description: "Let an outside system start a session by posting to a webhook URL.",
  entry: { kind: "builtin" },
  provides: [],
  permissions: {},
};
```

`provides: []` 是合法的：schema 只要求 `provides` 和 tools/resources/panel 三个 section 对得上（`packages/plugin-sdk/src/index.ts:249-251`），这个插件三样都没有，它靠私有路由说话。

### 4.2 存储

两个 JSON 文件，都放在插件自己的 dataDir 下（`<dataDir>/plugins/webhook/`），0600，写法照 `packages/plugin-schedule/src/schedules-file.ts`（临时文件 + rename，损坏的文件改名留档而不是丢掉）。

```jsonc
// endpoints.json
{
  "endpoints": [
    {
      "id": "wh_9f3c…",
      "name": "gitlab-mr-comment",
      "enabled": true,
      "directory": "/Users/me/work/repo",
      "agent": "opencode",
      "auth": { "mode": "hmac", "header": "X-Signature-256" },
      "match": { "path": "object_kind", "equals": "note" },
      "instruction": "看看这条评论，必要时改代码。",
      "dedupe": true,
      "secret": "原文密钥（仅 hmac 模式）",
      "secret_sha256": "摘要（仅 secret 模式）",
      "created_at": "…",
      "updated_at": "…"
    }
  ]
}

// deliveries.json
{
  "deliveries": [
    {
      "id": "dlv_…",
      "endpoint_id": "wh_9f3c…",
      "event_id": "abc123",
      "status": "accepted",       // ignored | queued | dispatching | retrying | accepted | failed
      "session_id": "…",
      "prompt": "…",
      "attempts": 1,
      "next_attempt_at": null,
      "error": null,
      "created_at": "…",
      "updated_at": "…"
    }
  ]
}
```

- delivery 保留 14 天：启动时剪一次，之后每小时剪一次。
- 原始 body 不存（只存渲染好的 prompt）；日志只记 endpoint id、delivery id、event id，不记密钥、不记 body。

### 4.3 状态与派发

```text
ignored
queued -> dispatching -> accepted          accepted = 后端收下了 prompt，不代表 agent 跑完了
                  -> retrying -> dispatching …
                  -> failed
```

- **先落库再回 202**；派发全在后台。
- 派发顺序：`create` → **立刻**把 `session_id` 写回 delivery → `prompt` → 记 `accepted`。
- **可重试**：`no backend connected`、`no such connection`、超时、5xx。退避 5 秒起，最长 5 分钟，最多 8 次。service 启动时后端的自动连接和插件启动是并行的，所以重启后第一批派发必然先撞上这类错。
- **不可重试**：工作区不在已知列表里（端点配错了）、指令为空。直接记 `failed`。
- **启动时恢复**（三个分支，够了）：
  1. `queued` / `retrying`：从头派发。
  2. `dispatching` 且没有 `session_id`：从头派发。
  3. `dispatching` 且有 `session_id`：用 `sessions.view(session_id)` 找带 `[webhook:<name> delivery:<id>]` 开头的 user turn。找到了 → 记 `accepted`；没找到 → **只补发 prompt，不新建会话**。
- 语义是"至少一次"。剩下那个窗口（后端已经收下 prompt、事件还没落进 store 就崩了）会补发一次 prompt——所以 marker 行必须留在 prompt 第一行，它是唯一的线索。
- 并发：全局同时最多派发 2 条。端点限流默认 30 次/分钟，超了回 **429** 并带 `Retry-After`。

### 4.4 目标连接

连接 id 会变（内嵌 opencode 换端口后 id 就变了），所以端点只存 `agent` 和 `directory`，派发时从 `sessionControl.connections()` 里挑：

- `canPrompt` 为真；
- 端点配了 `agent` 就必须同 kind；
- `directory` 必须出现在 `workspaces()`（service 里的 `knownDirs`）里，否则不可重试地失败。

### 4.5 注入面

插件定义自己的窄接口（照 `packages/plugin-schedule/src/index.ts:35` 的 `ScheduleHost`）：

```ts
export interface WebhookHost {
  control: {
    connections(): { id: string; agent: string; canPrompt: boolean }[];
    create(opts: { connectionId: string; title?: string; directory?: string }): Promise<{ sessionId: string }>;
    prompt(sessionId: string, text: string): Promise<void>;
  };
  view(sessionId: string): SessionView;
  workspaces: () => Promise<Map<string, { directory: string; name?: string }>>;
}
```

`BuiltinOptions`（`packages/service/src/plugins/builtin.ts:33`）多一个字段：

```ts
  /** The directories a session may live in; read on demand, never snapshotted. */
  workspaces: () => Promise<Map<string, { directory: string; name?: string }>>;
```

`packages/service/src/index.ts:265` 那里接上 `workspaces: () => knownDirs()`。**必须是懒的**：连接会来会去，工作区集合随时变，boot 时拍一张快照就是错的。

`PluginContext` 一个字都不扩大——插件拿不到会话，能力全靠工厂注入。

## 5. 接口

### 5.1 入口（免桌面 token）

```http
POST /plugins/webhook/in/wh_9f3c…
Content-Type: application/json
```

| 结果 | 状态码 | body |
| --- | --- | --- |
| 已受理 | 202 | `{ "delivery_id": "dlv_…", "status": "queued", "duplicate": false }` |
| 被匹配规则挡掉 | 202 | `{ "delivery_id": "dlv_…", "status": "ignored" }` |
| 重复 | 202 | 原来那条 delivery 的内容，加 `"duplicate": true` |
| 验签失败 | 401 | `{ "error": "unauthorized" }` |
| 端点不存在或停用 | 404 | |
| body 不是 JSON | 415 | |
| 超过 256KB | 413 | |
| 限流 | 429 | 带 `Retry-After` |

`Content-Type` 必须是 `application/json`：这不是挑剔，是一个跨站防护——表单和 `text/plain` 是"简单请求"，浏览器不预检就能发；JSON 不是，于是浏览器发起的跨站请求会被 CORS 预检挡住。GitHub 的 hook 要在设置里选 JSON（默认是 form）。

### 5.2 管理接口（要桌面 token）

```text
GET    /plugins/webhook/endpoints
POST   /plugins/webhook/endpoints                 创建，返回 { id, url, secret? }（secret 只这一次）
PUT    /plugins/webhook/endpoints/:id             改配置、启停
DELETE /plugins/webhook/endpoints/:id
GET    /plugins/webhook/deliveries?endpoint_id=&status=&limit=
POST   /plugins/webhook/deliveries/:id/retry      只重试 failed 的记录
```

这些路径不匹配 §3.1 的豁免正则，所以 core 的 token 检查照常生效——插件侧不用做任何鉴权。

## 6. UI

设置页新增一节"Webhook"。按 `apps/desktop/ui/src/settings-sections.ts:7-9` 的约定是三处：`settings-sections.ts` 加一项、`settings.tsx` 加一个面板、两种语言各加一条文案。

- 新增 `apps/desktop/ui/src/webhook-settings.tsx`（照 `plugin-settings.tsx` / `skill-settings.tsx` 的写法）。
- 一节的内容：
  - 端点列表：名称、启停、工作区、最近一次投递状态和错误；
  - 创建/编辑表单：名称、工作区（从 `GET /workspaces` 选）、agent（可空）、鉴权方式 + 密钥、匹配条件（可空）、指令文本、去重开关；
  - 入口 URL（`http://127.0.0.1:<port>/plugins/webhook/in/<id>`）给一个复制按钮，外部域名由用户自己填；
  - 投递记录：时间、状态、session（能点进会话）、失败可重试。
- 密钥只在创建和轮换时显示一次。
- 插件自己的名字也要本地化：`apps/desktop/ui/src/plugin-display.ts` 的 `NAME_KEYS` / `DESCRIPTION_KEYS` 各加一条 `webhook`，两个 locale 文件各加两行文案。
- 图标用已有的 `link`（`apps/desktop/ui/src/icons.tsx:8`），不新画。

## 7. 部署（写进设置页的帮助文本和 README）

- 反向代理或隧道**只转发 `/plugins/webhook/in/`**，别把 `/sessions`、`/stream` 或整个 `/plugins/` 露出去，并把 Host 改写成 `127.0.0.1:7700`。
  - nginx：`proxy_set_header Host 127.0.0.1:7700;`
  - cloudflared：`originRequest.httpHostHeader`
- 只有桌面应用在运行时才收得到。调用方不重试的话，应用关着的那段时间事件就丢了。
- 自建 GitLab 默认拒绝往内网地址发 webhook，要么走公网/内网代理地址，要么让管理员打开 *Allow requests to the local network from webhooks and integrations*。
- 端点密钥等同于"在这台机器上、按你自己的权限配置开一个 agent 会话"的能力，像密码一样保管。
- GitHub 的 hook 默认发 form body，要在 hook 设置里选 `application/json`。

## 8. 相对上一版的取舍

上一版把鉴权做成五种、过滤做成三算子 × 三来源的矩阵、prompt 做成模板语言，还带一套四分支的 marker 对账和 9 个管理接口。首版砍掉这些，理由是它们没有一个是"能跑起来"的前提：

| 砍掉 | 换成 |
| --- | --- |
| 5 种鉴权 | 2 种（HMAC-SHA256、明文 secret 头） |
| 过滤 DSL | 1 条"路径 + 相等" |
| 模板语言 | 用户写一段指令 + 整个 payload |
| 4 分支 marker 对账 | 3 分支（§4.3），拿不准就只补发 prompt |
| 9 个管理接口 | 6 个 |
| 独立的预览/实时渲染界面 | 先不做 |

留到后面（谁先要谁做）：Standard Webhooks 规范模式、URL 里的 token（给只能填 URL 的工具）、按平台写适配器、结果回发、轮询式触发（出站 API 轮询，零 core 改动）、第三方插件。

## 9. 实施步骤

每个 Task 结束后跑 `bun run typecheck` 和 `bun run lint`。改 UI 的 Task 另跑 `bun run test:ui`。最后 `bun run sidecar`。

- [ ] **Task 1：core 的入口豁免**（§3）
  文件：`packages/service/src/plugins/host.ts`、`packages/service/src/index.ts`、`packages/service/test/plugins.test.ts`、`packages/service/test/plugin-ingress.test.ts`（新建）。

  测试（`packages/service/test/plugin-ingress.test.ts`）：
  - 免 token 的 `POST /plugins/webhook/in/wh_x` 能到达插件（用一个注册了 ingress 的假插件断言它收到了请求）；
  - 免 token 的 `GET /plugins/webhook/in/wh_x`（方法不对）仍是 401；
  - 多一段路径、`%2F`、路径不在正则内，仍是 401；
  - `Host` 不是 loopback，仍是 403；带 `Origin` 头的入口**不是** 403；
  - `/plugins/webhook/endpoints` 不带 token 仍是 401；
  - `/sessions` 等其他路由行为不变；
  - 插件停用时入口回 404；
  - `plugins.test.ts:761` 的内置列表断言更新。

  命令：`bun test packages/service`

- [ ] **Task 2：包骨架与存储**
  文件：`packages/plugin-webhook/{package.json,tsconfig.json}`、`src/store.ts`、`src/index.ts`（manifest + 空插件）、`packages/service/src/plugins/builtin.ts`、`packages/service/src/index.ts`（注入 `workspaces`）、`packages/service/test/plugins.test.ts`。

  测试：
  - 同一个 `event_id` 并发插入只有一条成功，另一条读到已有记录；
  - 端点查询永远不返回 `secret` / `secret_sha256`；
  - 写文件是 0600，损坏的 JSON 改名留档而不是抛异常；
  - 过期 delivery 被剪掉。

  命令：`bun test packages/plugin-webhook packages/service`

- [ ] **Task 3：入口处理**（`src/auth.ts`，纯函数）
  测试：
  - `hmac`：hex、带 `sha256=` 前缀、带时间戳头、时间戳超窗（±5 分钟外）、错签名；
  - `secret`：相等、不等、`Authorization: Bearer` 形式；
  - body 超过 256KB 回 413（用 `Content-Length` 和 chunked 两种）；
  - 事件 id 的取值顺序；
  - 匹配命中/不命中；
  - prompt 三段拼接正确，第一行改不掉。

  命令：`bun test packages/plugin-webhook`

- [ ] **Task 4：worker**（注入假的 `sessionControl`）
  测试：
  - 同一个 event id 并发 20 次，只建一次会话、只发一次 prompt；
  - `no backend connected` 会重试，连接出现后成功；
  - 工作区不在已知列表里 → 直接 failed；
  - §4.3 的三个恢复分支各一个用例；
  - 全局并发上限和端点限流生效。

  命令：`bun test packages/plugin-webhook`

- [ ] **Task 5：入口与管理路由**（§5）
  文件：`packages/plugin-webhook/src/index.ts`。

  命令：`bun test packages/plugin-webhook packages/service`

- [ ] **Task 6：端到端**（`packages/service/test/webhook-e2e.test.ts`）
  - 起 service（内存 DB）接一个假 backend；
  - 创建端点 → 外部 POST 收到 202 → 出现新会话 → store 里有带标记的 user turn；
  - 再用 `secret` 模式模拟一次 GitLab 的 Note Hook：带 `X-Gitlab-Token` 和 `Idempotency-Key`，重复 POST 同一个 key 只建一个会话。

  命令：`bun test packages/service`

- [ ] **Task 7：设置页**（§6）
  文件：`apps/desktop/ui/src/settings-sections.ts`、`settings.tsx`、`webhook-settings.tsx`（新建）、`plugin-display.ts`、`locales/zh/shell.ts`、`locales/en/shell.ts`。

  测试（`apps/desktop/ui/src/webhook-settings.vtest.tsx`）：创建端点后列表里多一条、密钥只显示一次、投递记录能跳到会话。

  命令：`bun run test:ui`

## 10. 验收

- 带正确凭据、不带桌面 token，能触发并新建会话；凭据错回 401。
- 管理接口不带桌面 token 回 401；其他路由的鉴权行为不变。
- 同一个 `Idempotency-Key` 并发 20 次，只建一个会话。
- 事件名对不上的请求回 202、状态 `ignored`、不建会话。
- 重启后 `queued` 和 `retrying` 的记录继续派发；建会话之后、发 prompt 之前崩溃，不会重复建会话。
- 真实 HTTP 全链路：外部请求 → 202 → 新会话 → store 里有 user turn。
