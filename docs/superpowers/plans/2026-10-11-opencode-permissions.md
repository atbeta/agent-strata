# OpenCode Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A permission ask can be answered once, always, or deny; the card shows the command, the diff, or the URL instead of raw JSON; a session waiting on the user is marked in the sidebar and counted in the window title.

**Architecture:** Strata's policy still decides before the user is asked, and that path is unchanged (`reply: "once"` or `"reject"`). A user's "always" is OpenCode's own memory: the adapter forwards `reply: "always"` and OpenCode stops asking for those patterns until it restarts. The card's layout is a pure function of `{ tool, input }` (the input the adapter already stores: metadata spread in, and `command` set for shell tools). `needs_input` on `GET /sessions` is true only while a live pending ask or question exists in the service, which is the same set the cards answer.

**Tech Stack:** Bun 1.3, TypeScript, `bun:test`, `@opencode-ai/sdk` 1.18.35 (v2 client), Solid + Tailwind, Tauri v2.

## Global Constraints

Every task includes `.superpowers/sdd-permissions/constraints.md`.

---

## Facts (from the SDK 1.18.35 and OpenCode's own permission prompt; do not re-verify against a model)

1. `client.permission.reply({ requestID, reply, message })` accepts `reply: "once" | "always" | "reject"`. `POST /permission/:requestID/reply`.
2. `permission.asked` properties: `{ id, sessionID, permission, patterns, metadata, always, tool?: { messageID, callID } }`. The adapter already spreads `metadata` into the ask's `input` and, for `bash` / `pwsh` / `powershell` / `cmd`, sets `input.command` to `patterns.join("\n")`.
3. OpenCode's prompt reads an edit from `metadata.filepath` and `metadata.diff`, a shell command from the tool input's `command`, and webfetch from the tool input's `url`. "Always" approves the request's `always` patterns until the OpenCode process restarts. Strata does not store that rule.
4. `permission.replied` is already mapped to `permission.resolved` with `scope: "always"` when `reply === "always"`. The ingestor also emits that event itself under the same id, so the store keeps one row.
5. The session page loads cards from `GET /permissions` and `GET /questions`, filtered by `session_id`. The sidebar refetches `GET /sessions` on every non-snapshot stream event, so a new `needs_input` flag shows up without a new subscription.
6. A session waiting on permission is often still `busy`. The waiting marker has to be visible at the same time as the busy dot.

---

## File map

- `packages/adapter-opencode/src/index.ts` — `reply` takes `"always"`; the user-allow branch forwards it.
- `packages/adapter-opencode/test/opencode.test.ts` — the new reply cases.
- `apps/desktop/ui/src/permission-card.ts` — `permissionView`, `windowTitle`.
- `apps/desktop/ui/src/permission-card.test.ts` — those two.
- `packages/service/src/index.ts` — `needs_input` on each `GET /sessions` row.
- `packages/service/test/fake-opencode.ts` — `push(frame)` so a test can emit after connect.
- `packages/service/test/service.test.ts` — a pending ask sets the flag and an always-reply is what OpenCode receives.
- `apps/desktop/ui/src/api.ts` — `SessionRow.needs_input`.
- `apps/desktop/ui/src/session-detail.tsx` — the card body and the three buttons.
- `apps/desktop/ui/src/App.tsx` — sidebar marker and window title.
- `apps/desktop/ui/src/locales/{zh,en}/session.ts` and `shell.ts` — the new strings.

---

### Task 1: Forward an "always" allow to OpenCode

**Files:** `packages/adapter-opencode/src/index.ts`, `packages/adapter-opencode/test/opencode.test.ts`.

**Produces:** `createIngestor`'s `reply` is `(requestID: string, reply: "once" | "always" | "reject", message?: string) => Promise<unknown>`. A user allow with `scope: "always"` calls it with `"always"` and emits `permission.resolved` `{ decision: "allow", by: "user", scope: "always" }`. `scope: "once"` and an omitted scope still reply `"once"`. Policy allow/deny is untouched.

- [ ] **Step 1: Failing tests** in the `createIngestor seam` describe, next to the policy test. `asked`, `sessionCreated`, `sid` are already in that file.

```ts
test("a user's always allow is replied always", async () => {
  const replies: { requestID: string; reply: string }[] = [];
  const store = openStore(":memory:");
  const ing = createIngestor({
    mapper: new OpencodeMapper(),
    sink: store,
    onAsk: async () => ({ decision: "allow", scope: "always" }),
    reply: async (requestID, reply) => {
      replies.push({ requestID, reply });
    },
  });
  ing.handle(sessionCreated());
  ing.handle(asked("bash", ["ls"], "permA"));
  await Bun.sleep(20);
  expect(replies).toEqual([{ requestID: "permA", reply: "always" }]);
  const resolved = store.read({ session_id: `opencode:${sid}` }).find((e) => e.type === "permission.resolved");
  expect(resolved?.data).toMatchObject({ decision: "allow", by: "user", scope: "always" });
  store.close();
});

test("a user's once allow, and a deny, are not replied always", async () => {
  const replies: string[] = [];
  const once = createIngestor({
    mapper: new OpencodeMapper(),
    sink: { append() {} },
    onAsk: async () => ({ decision: "allow" }),
    reply: async (_id, reply) => {
      replies.push(reply);
    },
  });
  once.handle(sessionCreated());
  once.handle(asked("bash", ["ls"], "permOnce"));
  const deny = createIngestor({
    mapper: new OpencodeMapper(),
    sink: { append() {} },
    onAsk: async () => ({ decision: "deny", scope: "always" }),
    reply: async (_id, reply) => {
      replies.push(reply);
    },
  });
  deny.handle(sessionCreated());
  deny.handle(asked("bash", ["rm x"], "permDeny"));
  await Bun.sleep(20);
  expect(replies).toEqual(["once", "reject"]);
});
```

- [ ] **Step 2: Run** `bun test packages/adapter-opencode/test/opencode.test.ts` and confirm the first test fails because the reply is `"once"`.

- [ ] **Step 3: Implementation.** Widen the `reply` parameter union to `"once" | "always" | "reject"`. In `handlePermission`, the user-allow branch becomes:

```ts
    if (ans.decision === "allow") {
      const scope = ans.scope === "always" ? "always" : "once";
      await opts.reply(p.id, scope);
      emitResolved(p.sessionID, {
        request_id: p.id, decision: "allow", by: "user", scope,
      });
      return;
    }
```

The `connectOpencode` callback already passes `r` through to `client.permission.reply`, so it needs no change. Do not change the policy branch.

- [ ] **Step 4: Root `bun test`, root `bun run typecheck`.** Commit `fix(adapter-opencode): forward an always permission reply`.

---

### Task 2: What a permission card shows

**Files:** `apps/desktop/ui/src/permission-card.ts` (new), `permission-card.test.ts` (new).

**Produces:**

```ts
export type PermissionView =
  | { kind: "command"; command: string }
  | { kind: "diff"; path?: string; patch: string }
  | { kind: "url"; url: string }
  | { kind: "json" };

export function permissionView(ask: { tool: string; input: Record<string, unknown> }): PermissionView;
export function windowTitle(waiting: number): string;
```

- [ ] **Step 1: Failing tests.**

```ts
import { describe, expect, test } from "bun:test";
import { permissionView, windowTitle } from "./permission-card";

const PATCH = "@@ -1 +1 @@\n-a\n+b\n";

describe("permission card body", () => {
  test("a shell tool shows the command", () => {
    expect(permissionView({ tool: "bash", input: { command: "ls -la", patterns: ["ls"] } })).toEqual({
      kind: "command",
      command: "ls -la",
    });
    expect(permissionView({ tool: "pwsh", input: { patterns: ["Get-ChildItem"] } })).toEqual({
      kind: "command",
      command: "Get-ChildItem",
    });
  });

  test("an edit or write shows its diff and path", () => {
    expect(permissionView({ tool: "edit", input: { filepath: "src/a.ts", diff: PATCH } })).toEqual({
      kind: "diff",
      path: "src/a.ts",
      patch: PATCH,
    });
    expect(
      permissionView({ tool: "write", input: { filePath: "b.ts", filediff: { patch: PATCH } } }).kind,
    ).toBe("diff");
  });

  test("webfetch shows the url, from the field or from the patterns", () => {
    expect(permissionView({ tool: "webfetch", input: { url: "https://x.test" } })).toEqual({
      kind: "url",
      url: "https://x.test",
    });
    expect(permissionView({ tool: "webfetch", input: { patterns: ["https://x.test/*"] } })).toEqual({
      kind: "url",
      url: "https://x.test/*",
    });
  });

  test("anything else stays raw json", () => {
    expect(permissionView({ tool: "edit", input: { filepath: "a.ts" } })).toEqual({ kind: "json" });
    expect(permissionView({ tool: "task", input: { description: "look" } })).toEqual({ kind: "json" });
  });
});

describe("window title", () => {
  test("counts only when someone is waiting", () => {
    expect(windowTitle(0)).toBe("Agent Strata");
    expect(windowTitle(2)).toBe("(2) Agent Strata");
  });
});
```

- [ ] **Step 2: Run** `bun test apps/desktop/ui/src/permission-card.test.ts` and confirm it fails on the missing module.

- [ ] **Step 3: Implementation.**

```ts
const SHELL = new Set(["bash", "pwsh", "powershell", "cmd"]);

export type PermissionView =
  | { kind: "command"; command: string }
  | { kind: "diff"; path?: string; patch: string }
  | { kind: "url"; url: string }
  | { kind: "json" };

function patterns(input: Record<string, unknown>): string {
  if (!Array.isArray(input.patterns)) return "";
  return input.patterns.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
}

function patchOf(input: Record<string, unknown>): string | undefined {
  if (typeof input.diff === "string" && input.diff) return input.diff;
  const filediff = input.filediff;
  if (!filediff || typeof filediff !== "object") return undefined;
  const patch = (filediff as { patch?: unknown }).patch;
  return typeof patch === "string" && patch ? patch : undefined;
}

/** The one thing the card should show. Anything unrecognised stays a JSON dump. */
export function permissionView(ask: { tool: string; input: Record<string, unknown> }): PermissionView {
  const input = ask.input ?? {};
  if (SHELL.has(ask.tool)) {
    const command = typeof input.command === "string" && input.command ? input.command : patterns(input);
    if (command) return { kind: "command", command };
  }
  if (ask.tool === "edit" || ask.tool === "write") {
    const patch = patchOf(input);
    if (patch) {
      const path =
        typeof input.filepath === "string" ? input.filepath : typeof input.filePath === "string" ? input.filePath : undefined;
      return { kind: "diff", path, patch };
    }
  }
  if (ask.tool === "webfetch") {
    const url = typeof input.url === "string" && input.url ? input.url : patterns(input);
    if (url) return { kind: "url", url };
  }
  return { kind: "json" };
}

/** `waiting` is how many sessions currently need the user. */
export function windowTitle(waiting: number): string {
  return waiting > 0 ? `(${waiting}) Agent Strata` : "Agent Strata";
}
```

- [ ] **Step 4: Root `bun test`, root typecheck, and `bun run typecheck` inside `apps/desktop/ui`.** Commit `feat(ui): choose what a permission card shows`.

---

### Task 3: Sessions say when they are waiting

**Files:** `packages/service/test/fake-opencode.ts`, `packages/service/src/index.ts`, `packages/service/test/service.test.ts`.

**Produces:** every object in `GET /sessions`'s `sessions` has `needs_input: boolean`, true while that session has a row in the in-memory pending asks or pending questions. `fakeOpencode()` returns `push(frame)` which enqueues one SSE frame on every open `/global/event` and `/event` stream.

- [ ] **Step 1: Extend the fake.** Replace the one-shot `stream` helper so the first frame is still sent immediately and later frames can be pushed. Keep the existing `routes` override and the default `/session` and `/project` responses.

```ts
  const enc = new TextEncoder();
  const listeners = new Set<(frame: unknown) => void>();
  const stream = (first: unknown) =>
    new Response(
      new ReadableStream({
        start(ctrl) {
          const send = (frame: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
          send(first);
          listeners.add(send);
        },
        cancel() {
          // a stopped driver drops its stream; nothing else holds the sender
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
```

`/global/event` returns `stream({ directory: "/repo", payload: { type: "server.connected", properties: {} } })`. `/event` returns `stream({ type: "server.connected", properties: {} })`. Add to the returned object:

```ts
push(frame: unknown) {
  for (const send of listeners) send(frame);
},
```

The `cancel` above cannot remove `send` because `start` does not return it. Keep a small wrapper so `cancel` deletes the same function `push` calls. Do not leave a listener that enqueues on a closed controller.

- [ ] **Step 2: Failing test** in `service.test.ts`. `startService` is the harness already used there.

```ts
test("a session waiting on the user is marked, and always is what OpenCode is told", async () => {
  const oc = fakeOpencode({
    "/permission/perm1/reply": async (_url, req) => {
      await req.json();
      return Response.json(true);
    },
  });
  const svc = startService({ db: ":memory:", port: 0 });
  const base = `http://127.0.0.1:${svc.port}`;
  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await post("/connect", { baseUrl: oc.baseUrl, directory: "/repo" });

  const before = await fetch(`${base}/sessions`).then((r) => r.json());
  expect(before.sessions.every((s: { needs_input?: boolean }) => s.needs_input === false)).toBe(true);

  oc.push({
    directory: "/repo",
    payload: {
      type: "permission.asked",
      properties: {
        id: "perm1", sessionID: "ses_wait", permission: "bash",
        patterns: ["ls"], metadata: {}, always: ["ls"],
      },
    },
  });
  let marked = false;
  for (let i = 0; i < 20 && !marked; i++) {
    await Bun.sleep(50);
    const list = (await fetch(`${base}/sessions`).then((r) => r.json())) as {
      sessions: { summary: { session_id: string }; needs_input?: boolean }[];
    };
    marked = list.sessions.some((s) => s.summary.session_id === "opencode:ses_wait" && s.needs_input === true);
  }
  expect(marked).toBe(true);

  expect((await post("/permissions/perm1/respond", { decision: "allow", scope: "always" })).status).toBe(200);
  const reply = oc.seen.find((s) => s.path === "/permission/perm1/reply");
  expect(JSON.parse(reply!.body).reply).toBe("always");

  const after = (await fetch(`${base}/sessions`).then((r) => r.json())) as {
    sessions: { summary: { session_id: string }; needs_input?: boolean }[];
  };
  expect(after.sessions.find((s) => s.summary.session_id === "opencode:ses_wait")?.needs_input).toBe(false);
  oc.stop();
  svc.stop();
});
```

Confirm the route the SDK actually posts before locking the path. It is `/permission/{requestID}/reply` in `@opencode-ai/sdk` 1.18.35 `sdk.gen.d.ts`. If a run shows a different path in `oc.seen`, match that path and say so in the report; do not change the adapter.

- [ ] **Step 3: Run the test and confirm it fails because `needs_input` is missing (or the reply body is not `"always"`, which Task 1 already fixed).**

- [ ] **Step 4: Implementation.** In the `GET /sessions` handler, the row object gains:

```ts
needs_input:
  [...pendingAsks.values()].some((p) => p.session_id === summary.session_id) ||
  [...pendingQuestions.values()].some((p) => p.session_id === summary.session_id),
```

Build the two id sets once per request rather than scanning both maps per session.

- [ ] **Step 5: Root `bun test`, root typecheck.** Commit `feat(service): mark sessions that are waiting on the user`.

---

### Task 4: The card, the sidebar marker, the window title

**Files:** `api.ts`, `session-detail.tsx`, `App.tsx`, `locales/zh/session.ts`, `locales/en/session.ts`, `locales/zh/shell.ts`, `locales/en/shell.ts`.

**Consumes:** `permissionView` and `windowTitle` from `./permission-card`; `DiffBlock` from `./diff`; `JsonView` from `./json-view`; `respondPermission(id, decision, scope?)` already in `api.ts`; `SessionRow`.

- [ ] **Step 1: Strings.**

| key | zh | en | file |
|---|---|---|---|
| `permission.once` | 仅此一次 | Once | session |
| `permission.always` | 始终允许 | Always | session |
| `sidebar.session.needsInput` | 待处理 | Needs you | shell |

`permission.allow` stays; the once button uses `permission.once` instead. `permission.deny` stays.

- [ ] **Step 2: `SessionRow`** gains `needs_input?: boolean`.

- [ ] **Step 3: The card.** Replace the `<pre>{JSON.stringify(p.input)}</pre>` block and the two buttons. `respond` takes an optional scope:

```ts
  const respond = async (requestId: string, decision: "allow" | "deny", scope?: "once" | "always") => {
    await respondPermission(requestId, decision, scope);
    refetchAsks();
  };
```

Inside the existing card shell (`rounded-xl border border-event-permission/40 …`), keep the tool name. Under it, switch on `permissionView(p)`:

- `command`: `<pre class="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md bg-background/50 p-2 font-mono text-2xs">` with the command.
- `diff`: the path, when present, as `font-mono text-2xs text-muted-foreground`, then `<div class="mt-2 max-h-48 overflow-auto rounded-md bg-background/50"><DiffBlock patch={view.patch} /></div>`.
- `url`: the url in the same mono pre as the command.
- `json`: `<JsonView value={p.input} />` inside the same max-h-24 scroller. Check `JsonView`'s prop name in `json-view.tsx` and use it.

Buttons, in this order, right aligned as today: once (`permission.once`, the existing allow classes, `respond(id, "allow", "once")`), always (`permission.always`, `rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-foreground hover:bg-secondary/80`, `respond(id, "allow", "always")`), deny (unchanged classes, `respond(id, "deny")`).

- [ ] **Step 4: Sidebar.** `SessionListItem` gains `needsInput: boolean`. The busy dot stays. Before the title, when `needsInput`:

```tsx
<span class="shrink-0 rounded bg-event-permission/15 px-1 text-2xs font-medium text-event-permission">
  {t("sidebar.session.needsInput")}
</span>
```

Pass `needsInput={s.needs_input === true}` from the row. A waiting session that is also busy shows both.

- [ ] **Step 5: Window title.** In `App`, a `createEffect` over the session resource:

```ts
const waiting = () =>
  (settled(data)?.sessions ?? []).filter((s) => s.needs_input && !s.archived && !s.deleted).length;
createEffect(() => {
  const title = windowTitle(waiting());
  document.title = title;
  if (!inDesktopShell()) return;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title));
});
```

- [ ] **Step 6: Root `bun test`, root typecheck, and inside `apps/desktop/ui` both `bun run typecheck` and `bun run build`.** Commit `feat(ui): answer a permission once or always, and show who is waiting`.

---

## Done when

- Root `bun test` is green and both typechecks pass.
- A bash ask rendered by `permissionView` is the command; an edit with `diff` is a diff; a webfetch is the URL.
- `POST /permissions/:id/respond` with `{ decision: "allow", scope: "always" }` is forwarded as `reply: "always"`.
- `GET /sessions` reports `needs_input` for a session with a live pending ask or question, and not after it is answered.
- Desktop check (user), in `tauri dev`, in an OpenCode session whose policy asks for bash:
  1. a bash call shows the command, with 仅此一次 / 始终允许 / 拒绝;
  2. the sidebar row shows 待处理 while the card is up, and the window title is `(1) Agent Strata`;
  3. 始终允许 — a later call of the same shape is not asked again;
  4. an edit ask shows a diff; anything else still shows JSON.

No probe script in this plan. Do not spend a model call to prove step 3; that check is the user's.
