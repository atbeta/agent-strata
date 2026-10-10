# OpenCode Message Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a message the reader can revert, restore, fork, copy, or edit-and-resend, and a compaction shows up as a divider. Reverted turns go grey and their file changes leave the files list.

**Architecture:** OpenCode keeps reverted messages and points `session.revert.messageID` at the boundary. That becomes `session.updated.revert`, which is `{ turn_id }`, `null` to clear, or absent to leave the previous value alone. The projector greys the matching turn and every turn after it, and drops file edits that belong to those turns. A compaction part becomes one `session.compacted` event. Revert, unrevert, fork, and summarize are command-plane methods; the disk rollback is OpenCode's, and strata only records the boundary. Edit-and-resend is revert to that user message, then the normal prompt.

**Tech Stack:** Bun 1.3, TypeScript, `bun:test`, `@opencode-ai/sdk` 1.18.35, Solid + Tailwind.

## Global Constraints

Every task includes `.superpowers/sdd-messages/constraints.md`.

---

## Facts (SDK 1.18.35; do not re-verify against a model)

1. `client.session.revert({ sessionID, directory, messageID })`, `client.session.unrevert({ sessionID, directory })`, `client.session.fork({ sessionID, directory, messageID })`, `client.session.summarize({ sessionID, directory, providerID, modelID })`. Confirm the HTTP paths in `sdk.gen.js` before locking a fake route; do not change the adapter to fit a guessed path.
2. Session info carries `revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string }`. Clearing the revert removes the field. Our user `turn_id` is that user message id. An assistant message id is `msg_id` on the assistant entry of the same turn.
3. `CompactionPart` is `{ type: "compaction", id, sessionID, messageID, auto: boolean, overflow?: boolean, tail_start_id?: string }`. The mapper currently ignores that part type.
4. `session.updated` means "omitted fields stay as they were" (`packages/schema/src/index.ts`). A title update must not clear a revert, and a revert-only update must still emit.
5. `OPENCODE_MAPPER_VERSION` is `"opencode-5"`. `OPENCODE_REBUILT_TYPES` is the list a rebuild replaces. A new event type has to be on that list or a rebuild leaves the old copy beside the new one.
6. `GET /sessions/:id/capabilities` already returns `prompt`, `abort`, `commands`, `attachments`, `extension`. The session page reads it.

---

## File map

- `packages/schema/src/index.ts` — `revert` on `session.updated`; new `session.compacted`.
- `packages/projector/src/index.ts` — `revert_turn_id`, `Turn.reverted`, `Turn.compaction`, files list skips reverted edits.
- `packages/projector/test/projector.test.ts` — those rules.
- `packages/adapter-opencode/src/index.ts` — map revert and compaction; version `opencode-6`; the four client calls.
- `packages/adapter-opencode/test/opencode.test.ts` — the mapping.
- `packages/service/src/driver.ts`, `opencode-driver.ts`, `index.ts` — capabilities and routes.
- `packages/service/test/service.test.ts` — the routes against `fakeOpencode`.
- `apps/desktop/ui/src/api.ts`, `transcript.tsx`, `session-detail.tsx`, locales — the actions.

---

### Task 1: A revert point and a compaction marker

**Files:** `packages/schema/src/index.ts`, `packages/projector/src/index.ts`, `packages/projector/test/projector.test.ts`. The UI copies of `SessionView` and `Turn` in `apps/desktop/ui/src/api.ts` gain the same fields so later tasks typecheck; add them here.

**Produces:**

```ts
// session.updated data, added field
revert: z.object({ turn_id: z.string().min(1) }).nullable().optional()
// new event
"session.compacted": z.object({
  message_id: z.string().min(1),
  auto: z.boolean().optional(),
})
```

`SessionView.revert_turn_id?: string`. `Turn.reverted?: boolean`. `Turn.compaction?: boolean` (a divider after this turn). Absent `revert` leaves the previous value; `null` clears it. The matched turn is the first whose `turn_id` equals the id, else the first with an assistant `msg_id` equal to it. That turn and every turn after it are `reverted`. `files_changed` omits edits whose `turn_index` is a reverted turn. An edit with `turn_index === -1` stays.

- [ ] **Step 1: Failing projector tests**, using the file's `mk` helper. Cover: a revert on `t1` greys `t1` and `t2` but not a turn before `t1`; a later `session.updated` that only sets `title` keeps the revert; `revert: null` clears it; an assistant `msg_id` match greys that turn; a `file.changed` whose call sits on a reverted turn disappears from `files_changed`, and one on an earlier turn stays; `session.compacted` with that turn's `turn_id` sets `compaction` on it.

- [ ] **Step 2: Run** `bun test packages/projector/test/projector.test.ts` and confirm the failure is the missing field or event.

- [ ] **Step 3: Schema and projector.** Apply the revert only when `e.data.revert !== undefined`. Compute `reverted` and `compaction` after the turns exist, before building `files_changed`. Add the fields to `apps/desktop/ui/src/api.ts` `SessionView` and `Turn`.

- [ ] **Step 4: Root `bun test`, root typecheck, and `bun run typecheck` inside `apps/desktop/ui`.** Commit `feat(schema): record a revert point and a compaction`.

---

### Task 2: The mapper records both

**Files:** `packages/adapter-opencode/src/index.ts`, `packages/adapter-opencode/test/opencode.test.ts`.

**Produces:** `OPENCODE_MAPPER_VERSION === "opencode-6"`. `session.updated` includes `revert: { turn_id: info.revert.messageID }` when the info has a revert, and `revert: null` when this session previously had one and the info no longer does. A session that never had one omits the field. A part `{ type: "compaction", id, messageID, auto }` emits one `session.compacted` `{ message_id, auto }` with id `opencode:${part.id}:compaction`, and a second update of the same part emits nothing. `"session.compacted"` is in `OPENCODE_REBUILT_TYPES`.

- [ ] **Step 1: Failing tests.** One `session.updated` whose `info.revert` is `{ messageID: "u1" }` produces `revert: { turn_id: "u1" }`. A following `session.updated` of the same session with no `revert` produces `revert: null`. A `message.part.updated` compaction part produces one `session.compacted`. Update the version assertion from `opencode-5` to `opencode-6`.

- [ ] **Step 2: Run the adapter tests and confirm the new assertions fail.**

- [ ] **Step 3: Implementation.** Extend `syncMeta`'s info with `revert?: { messageID: string }`. Keep the last emitted revert message id on the session state. Include it in the change check and the hash. When emitting, set `revert` to `{ turn_id }` or `null` as above; do not put `revert: null` on a session that has never had one. In the part switch, before the fall-through, handle `part.type === "compaction"` with a seen-set on the message state so the part emits once. Bump the version and add the event type to `OPENCODE_REBUILT_TYPES`.

- [ ] **Step 4: Root `bun test`, root typecheck.** Commit `feat(adapter-opencode): map revert points and compaction markers`.

---

### Task 3: Revert, restore, fork, and summarize go through the service

**Files:** `packages/service/src/driver.ts`, `opencode-driver.ts`, `packages/adapter-opencode/src/index.ts` (the returned client methods), `packages/service/src/index.ts`, `packages/service/test/service.test.ts`.

**Produces:** `BackendDriver` optional methods `revert(nativeId, messageId, directory?)`, `unrevert(nativeId, directory?)`, `fork(nativeId, messageId, directory?) => Promise<{ casfId: string; nativeId: string }>`, `summarize(nativeId, directory?)`. Capabilities gain `revert?`, `fork?`, `summarize?`. The OpenCode driver sets all three true and forwards to the SDK. Routes, all POST:

- `/sessions/:id/revert` body `{ message_id: string }` — 400 without it, 400 when the capability is absent
- `/sessions/:id/unrevert`
- `/sessions/:id/fork` body `{ message_id: string }` — 200 `{ id: casfId }`
- `/sessions/:id/summarize`

`GET /sessions/:id/capabilities` includes the three booleans. An ACP session gets 400 from each route. Fork's new id is claimed the same way `POST /sessions` claims a created session (`owners.set`, `claims.claim`).

- [ ] **Step 1: Failing service test** with `fakeOpencode`. After connect, post revert, unrevert, fork, and summarize, and assert the paths and JSON bodies the fake saw. Read the four URLs out of `sdk.gen.js` (`session.revert`, `unrevert`, `fork`, `summarize`) and register those pathnames. Fork's route returns `{ id: "ses_fork", directory: "/repo", title: "fork", time: { created: 1, updated: 1 } }` or whatever field the SDK reads as the session id — check the response type and return a body `client.session.fork` accepts. Assert `capabilities` on the connected OpenCode session has `revert`, `fork`, and `summarize` true. The existing ACP test already connects a mock agent; assert its capabilities omit the three and that revert returns 400.

- [ ] **Step 2: Run it and confirm it fails because the routes are missing.**

- [ ] **Step 3: Implementation.** Follow the prompt route's ownership checks (`driverFor`, `nativeId`, `directoryOf`). Summarize forwards `providerID` and `modelID` only when the body includes `model: { providerID, modelID }`. Revert and fork require `message_id`.

- [ ] **Step 4: Root `bun test`, root typecheck.** Commit `feat(service): revert, restore, fork, and summarize a session`.

---

### Task 4: The message actions

**Files:** `apps/desktop/ui/src/api.ts`, `transcript.tsx`, `session-detail.tsx`, `locales/zh/session.ts`, `locales/en/session.ts`.

**Consumes:** `SessionView.revert_turn_id`, `Turn.reverted`, `Turn.compaction`, and the capabilities flags. `sendPrompt` already exists.

- [ ] **Step 1: API.**

```ts
export function revertSession(id: string, messageId: string): Promise<void>
export function unrevertSession(id: string): Promise<void>
export function forkSession(id: string, messageId: string): Promise<string>
export function summarizeSession(id: string): Promise<void>
```

Each POSTs the route from Task 3 and uses `throwOnError`. `forkSession` returns the `id`.

- [ ] **Step 2: Strings.**

| key | zh | en |
|---|---|---|
| `message.copy` | 复制 | Copy |
| `message.copied` | 已复制 | Copied |
| `message.edit` | 编辑 | Edit |
| `message.revert` | 撤回 | Revert |
| `message.fork` | 分叉 | Fork |
| `message.restore` | 恢复 | Restore |
| `message.reverted` | 已撤回 | Reverted |
| `message.summarize` | 压缩 | Summarize |
| `message.compacted` | 对话已压缩 | Conversation compacted |

- [ ] **Step 3: Transcript.** `TurnBlock` gains `reverted` styling: the root element gets `opacity-50` when `turn.reverted`, and a `text-2xs text-muted-foreground` `message.reverted` label above the user bubble. When `turn.compaction`, render after the turn a centered `text-2xs text-muted-foreground` divider using `message.compacted`, with a `border-t border-border` line. The user bubble's wrapper is `group`. On hover (`group-hover`), a row of quiet text buttons (`text-2xs text-muted-foreground hover:text-foreground`) sits under the bubble, right aligned: copy, edit, and — only when the callback was passed — revert and fork. Copy writes the joined text blocks to `navigator.clipboard` and shows `message.copied` for 2 seconds. The buttons call `onCopy`, `onEdit`, `onRevert`, `onFork` passed from `SessionDetail`; copy can live in the block since it needs no service.

- [ ] **Step 4: Session page.** Read `revert`, `fork`, `summarize` off the existing capabilities resource (`caps`). Pass the callbacks only when the flag is true. `onRevert(turnId)` calls `revertSession(props.id, turnId)`. `onFork` calls `forkSession` and sets `location.hash` to the new id. `onEdit(turnId, text)` sets the composer draft to `text`, remembers `turnId` in a signal, and focuses the textarea. `send` — the existing one — when that signal is set, `await revertSession(props.id, turnId)` before `deliver`, then clears the signal. A failure there uses the existing `setSendErr` path and does not send. When `v().revert_turn_id` is set, a bar above the composer shows `message.reverted` and a button `message.restore` that calls `unrevertSession`. In the header's icon row, when `caps()?.summarize`, a quiet button `message.summarize` calls `summarizeSession` and surfaces errors with `setSendErr`.

- [ ] **Step 5: Root `bun test`, root typecheck, and inside `apps/desktop/ui` both `bun run typecheck` and `bun run build`.** Commit `feat(ui): revert, restore, fork, copy, and edit a message`.

---

## Done when

- A revert boundary greys that turn and the ones after it, and their file edits leave `files_changed`; a later title update does not clear it; `revert: null` does.
- A compaction part becomes one divider.
- The four routes forward to OpenCode and are refused for ACP.
- Desktop check (user), in `tauri dev`: revert the last turn, the files roll back and the turn is grey; restore brings both back; fork opens the new session; copy and edit-and-resend work; a compaction shows the divider.
