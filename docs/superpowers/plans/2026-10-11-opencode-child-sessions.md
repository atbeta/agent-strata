# OpenCode Child Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task tool in a parent session opens its child session, the child page can go back to the parent, and child sessions survive a sync instead of being dropped.

**Architecture:** The session record gains an optional `child_session_id` on `tool.call` and `tool.result`. The OpenCode mapper reads it from a task tool's `state.metadata.sessionId` and the mapper version moves to `opencode-5`, so stored sessions rebuild. Listing stays `roots: true` (the 80 cap is roots, not children). Each listed root then loads `session.children`, and those are indexed and imported the same way as roots. The sidebar already hides rows with `parent`. The transcript card and the session header are the only new UI.

**Tech Stack:** Bun 1.3, TypeScript, `bun:test`, `@opencode-ai/sdk` 1.18.35, Solid + Tailwind.

## Global Constraints

Every task includes `.superpowers/sdd-children/constraints.md`.

---

## Facts (do not re-verify against a model)

1. SDK `session.children({ sessionID, directory })` is `GET /session/{sessionID}/children`. `session.list` takes `roots: true` to omit children. Both are already how this repo calls the SDK.
2. A child session's `parentID` is the parent session id. The mapper already writes `parent_session_id: "opencode:" + parentID` on `session.updated`. `GET /sessions` already exposes that as `parent`. `App.tsx` `library()` already drops rows with `parent`.
3. Live `session.created` / `session.updated` for a child is not filtered. The drops are only in `listSessions` (`.filter((s) => !s.parentID)`), `indexSessions` (`if (info.parentID) continue`), and `refreshSessions` (same continue, and `roots: true`).
4. A task tool part carries `state.metadata.sessionId` (the child session's native id, shaped like `ses_…`). `tool.call` is emitted once, when the part leaves `pending`, so the id has to be copied again onto `tool.result` if it arrives only at completion.
5. `OPENCODE_MAPPER_VERSION` is `"opencode-4"`. One test locks that string. Bumping it makes the next sync rebuild stored sessions.
6. Opening a session is `location.hash = "/session/" + encodeURIComponent(casfId)`. `SessionDetail` is mounted as `<SessionDetail id={id} />` from `App.tsx`.

---

## File map

- `packages/schema/src/index.ts` — optional `child_session_id` on `tool.call` and `tool.result`.
- `packages/projector/src/index.ts` — `ToolCallView.child_session_id`.
- `packages/projector/test/projector.test.ts` — the field survives the projection.
- `packages/adapter-opencode/src/index.ts` — read `metadata.sessionId`; stop dropping children; version `opencode-5`.
- `packages/adapter-opencode/test/opencode.test.ts` — task part and version.
- `packages/service/test/service.test.ts` — a child listed under its parent after connect.
- `apps/desktop/ui/src/api.ts` — `ToolCallView.child_session_id`.
- `apps/desktop/ui/src/transcript.tsx`, `transcript-format.ts`, `session-detail.tsx`, `App.tsx`, locales — the card and the breadcrumb.

---

### Task 1: The record can name a child session

**Files:** `packages/schema/src/index.ts`, `packages/projector/src/index.ts`, `packages/projector/test/projector.test.ts`.

**Produces:** `tool.call` and `tool.result` data accept optional `child_session_id: string`. `ToolCallView.child_session_id?: string`. A result that carries it sets the field on the call that the earlier `tool.call` created.

- [ ] **Step 1: Failing test** in `projector.test.ts`. Use the same `makeEvent` / `projectSession` helpers the file already uses. Two events, one session: a `tool.call` for `call_id: "c1"` with no child id, then a `tool.result` `{ call_id: "c1", status: "ok", child_session_id: "opencode:ses_kid" }`. Assert the projected call's `child_session_id` is `"opencode:ses_kid"`. A second case: the id on the `tool.call` itself is kept when the result omits it.

- [ ] **Step 2: Run** `bun test packages/projector/test/projector.test.ts` and confirm it fails because the field is stripped or rejected by the schema.

- [ ] **Step 3: Schema.** Add to both objects:

```ts
child_session_id: z.string().min(1).optional(),
```

- [ ] **Step 4: Projector.** On the `tool.call` branch, set `child_session_id: e.data.child_session_id`. On the `tool.result` branch, when `e.data.child_session_id` is set, assign it onto `call`.

- [ ] **Step 5: Root `bun test`, root typecheck.** Commit `feat(schema): name a task tool's child session`.

---

### Task 2: The OpenCode mapper copies the task's child id

**Files:** `packages/adapter-opencode/src/index.ts`, `packages/adapter-opencode/test/opencode.test.ts`.

**Produces:** `OPENCODE_MAPPER_VERSION === "opencode-5"`. For a part with `tool: "task"` and `state.metadata.sessionId` a non-empty string, both the `tool.call` and the `tool.result` carry `child_session_id: "opencode:" + sessionId`. Any other tool omits the field. An id that already starts with `opencode:` is not prefixed twice.

- [ ] **Step 1: Failing test.** Follow an existing tool-part fixture in `opencode.test.ts` (a `message.part.updated` whose part `type` is `"tool"`). One task part that goes `running` then `completed`, with `metadata: { sessionId: "ses_kid" }` on both states. Assert both events have `child_session_id: "opencode:ses_kid"`. A bash part with the same metadata has no `child_session_id`. Update the version test from `"opencode-4"` to `"opencode-5"` in the same edit, so it fails until the constant moves.

- [ ] **Step 2: Run the adapter tests and confirm the task assertion fails.**

- [ ] **Step 3: Implementation.** Next to `fileChangeOf`:

```ts
function taskChild(tool: string, metadata: Record<string, unknown> | undefined): string | undefined {
  if (tool !== "task" || !metadata) return undefined;
  const id = metadata.sessionId;
  if (typeof id !== "string" || !id) return undefined;
  return id.startsWith("opencode:") ? id : `opencode:${id}`;
}
```

In `toolEvents`, add `child_session_id: taskChild(part.tool, st.metadata)` to both the call and the result objects. Omit the key when it is undefined (spread a conditional). Set `OPENCODE_MAPPER_VERSION` to `"opencode-5"`.

- [ ] **Step 4: Root `bun test`, root typecheck.** Commit `feat(adapter-opencode): record the child session a task tool opened`.

---

### Task 3: Sync keeps child sessions

**Files:** `packages/adapter-opencode/src/index.ts` (`listSessions`, `indexSessions`, `refreshSessions`), `packages/service/test/service.test.ts`.

**Produces:** `indexSessions` and `refreshSessions` still list roots with `roots: true` and `limit: 80`. For each root they also call `client.session.children({ sessionID, directory })` and ingest every descendant the same way as a root, including ones with `parentID`. A seen-set stops a cycle. `listSessions` no longer filters `parentID` out. A children request that throws is logged and skipped, same as a failed session list.

- [ ] **Step 1: Failing service test.** `fakeOpencode` matches on pathname. `GET /session` returns one root. `GET /session/root/children` returns one child. Deeper children routes return `[]`.

```ts
test("a child session is kept under its parent", async () => {
  const root = { id: "root", title: "Parent", directory: "/repo", time: { created: 1, updated: 1 } };
  const kid = { id: "kid", parentID: "root", title: "Child", directory: "/repo", time: { created: 2, updated: 2 } };
  const oc = fakeOpencode({
    "/session": () => Response.json([root]),
    "/session/root/children": () => Response.json([kid]),
    "/session/kid/children": () => Response.json([]),
  });
  const svc = startService({ db: ":memory:", port: 0 });
  const base = `http://127.0.0.1:${svc.port}`;
  const connected = await fetch(`${base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
  });
  expect(connected.status).toBe(200);
  const list = (await fetch(`${base}/sessions`).then((r) => r.json())) as {
    sessions: { summary: { session_id: string }; parent?: string; title?: string }[];
  };
  const child = list.sessions.find((s) => s.summary.session_id === "opencode:kid");
  expect(child?.parent).toBe("opencode:root");
  expect(child?.title).toBe("Child");
  oc.stop();
  svc.stop();
});
```

`connect` awaits `indexSessions` before it returns, so the child is visible without waiting for the background sync. If a run shows the children request under a different path in `oc.seen`, match that path and record it. Do not weaken the assertion.

- [ ] **Step 2: Run it and confirm the child is absent.**

- [ ] **Step 3: Implementation.** Remove `if (info.parentID) continue` in both loops and the `.filter((s) => !s.parentID)` in `listSessions`. Add one helper inside `connectOpencode`, used by both `indexSessions` and `refreshSessions`:

```ts
const walkChildren = async (
  sessionID: string,
  directory: string | undefined,
  visit: (info: { id: string; parentID?: string; directory: string }) => Promise<void>,
) => {
  const pending = [sessionID];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    let kids;
    try {
      kids = await client.session.children({ sessionID: id, directory });
    } catch (err) {
      console.error(`opencode children failed for ${id}:`, err);
      continue;
    }
    for (const info of kids.data ?? []) {
      if (!info?.id) continue;
      await visit(info);
      pending.push(info.id);
    }
  }
};
```

`visit` for index is the existing `ingestor.handle(session.updated)` plus `ids.push`. `visit` for refresh is the existing per-session body (guard, handle, import). The root loop stays as it is, then calls `walkChildren` for that root. Do not switch the root list to `roots: false`.

- [ ] **Step 4: Root `bun test`, root typecheck.** Commit `feat(adapter-opencode): keep child sessions when syncing`.

---

### Task 4: Open a child from the task card, and go back

**Files:** `apps/desktop/ui/src/api.ts`, `transcript-format.ts`, `transcript.tsx`, `session-detail.tsx`, `App.tsx`, `locales/zh/reading.ts`, `locales/en/reading.ts`, `locales/zh/session.ts`, `locales/en/session.ts`.

**Consumes:** `ToolCallView.child_session_id`, `SessionRow.parent` / `title` / `status` / `busy`, `SessionView.parent_session_id`.

- [ ] **Step 1: Strings.**

| key | zh | en | file |
|---|---|---|---|
| `tool.verb.task` | 子会话 | Subagent | reading |
| `session.child.open` | 打开子会话 | Open child session | session |
| `session.child.back` | 返回上级会话 | Back to parent | session |

- [ ] **Step 2: `api.ts` `ToolCallView`** gains `child_session_id?: string`.

- [ ] **Step 3: Headline.** In `transcript-format.ts`, a tool named `task` (case-insensitive) is its own kind `"task"`. `toolHeadline` uses `tool.verb.task` and, in order, `description`, `subagent_type`, `agent` from the input, else the tool name. Add a case to the existing headline test if that file has one; otherwise a small test next to the other `toolHeadline` tests.

- [ ] **Step 4: Card.** `TurnBlock` gains optional `childOf?: (id: string) => { title: string; status: string; busy?: boolean } | undefined` and `onOpenChild?: (id: string) => void`, passed through to `ToolCallCard`. When `call.child_session_id` is set, the card header keeps toggling the body, and a separate button (stop the click from toggling) calls `onOpenChild`. Its label is `t("session.child.open")`. The title becomes the child row's title when `childOf` returns one, otherwise the headline title. Next to the existing status text, when the row is `busy`, keep the pending pulse; when the row's `status` is `error`, use the destructive color already used for a denied call.

- [ ] **Step 5: Breadcrumb.** `SessionDetail` props become `{ id: string; sessions: { summary: { session_id: string }; title?: string; parent?: string; status: string; busy?: boolean }[] }`. `App.tsx` passes `settled(data)?.sessions ?? []`. When `v().parent_session_id` is set, the header shows, before the `h1`, a button with that parent's title (or `t("session.child.back")` when the row is missing) and `onClick` sets `location.hash` to `/session/${encodeURIComponent(parentId)}`. The button uses the same quiet text button style as the compare view's back button (`text-sm text-muted-foreground hover:text-foreground`). Pass `childOf` and `onOpenChild` into `TurnBlock`. `onOpenChild` is the same hash write.

- [ ] **Step 6: Root `bun test`, root typecheck, and inside `apps/desktop/ui` both `bun run typecheck` and `bun run build`.** Commit `feat(ui): open a task tool's child session and return to the parent`.

---

## Done when

- A task part with `metadata.sessionId` projects to a tool call whose `child_session_id` is `opencode:` plus that id.
- After connect, a child returned by `/session/:id/children` is in `GET /sessions` with `parent` set, and the sidebar filter still hides it.
- Desktop check (user), in `tauri dev`: run a prompt that calls a subagent; the task card shows the child and opens it; the child header goes back to the parent; the child is not a row of its own in the sidebar.
