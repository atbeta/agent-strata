# agent-strata

Cross-backend agent session/event layer: a canonical event format (CASF v0), an append-only SQLite event store, a pure projector, and a policy engine. All modules are independently testable with no network or LLM access. `packages/` holds the core libraries; `apps/` will hold future UIs (desktop/web).

## Packages

| Package | Purpose |
| --- | --- |
| `@agent-strata/schema` | CASF v0 event schemas (zod), `parseEvent`/`makeEvent`, `redact` |
| `@agent-strata/store` | Append-only `bun:sqlite` event store with FTS5 search and subscriptions |
| `@agent-strata/projector` | Pure projections from events to `SessionView` + cross-session `aggregate` |
| `@agent-strata/policy` | Permission policy engine (rules, glob/regex conditions, shell segmentation) |
| `@agent-strata/adapter-acp` | ACP (ndjson subprocess) adapter: `AcpRecorder` + `connectAcpAgent` |
| `@agent-strata/adapter-opencode` | opencode v1 event-stream adapter: `OpencodeMapper` + `connectOpencode` |

`connectOpencode` resolves only after the event stream is attached (first `server.connected` event, bounded by `connectTimeoutMs`, default 10s). `onEvent(evt)` is called after each raw event is ingested, for observing lifecycle events like idle.

v0 adapter-opencode limitations: no SSE reconnect yet; a lazily started session keeps its placeholder `session.started` (workspace "unknown") if the real `session.created` arrives later; only the v1 `/event` stream is consumed.

## Security model

The policy engine performs advisory static analysis of commands — it is not a sandbox. Constructs it cannot analyze safely are downgraded to `ask`; real enforcement requires a sandboxed execution layer (future work).

## Run

```sh
bun install
bun test          # all package tests
bun run typecheck # tsc --noEmit per package
```
