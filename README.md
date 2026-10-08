# agent-core

Cross-backend agent session/event layer: a canonical event format (CASF v0), an append-only SQLite event store, a pure projector, and a policy engine. All modules are independently testable with no network or LLM access.

## Packages

| Package | Purpose |
| --- | --- |
| `@agent-core/schema` | CASF v0 event schemas (zod), `parseEvent`/`makeEvent`, `redact` |
| `@agent-core/store` | Append-only `bun:sqlite` event store with FTS5 search and subscriptions |
| `@agent-core/projector` | Pure projections from events to `SessionView` + cross-session `aggregate` |
| `@agent-core/policy` | Permission policy engine (rules, glob/regex conditions, shell segmentation) |

## Security model

The policy engine performs advisory static analysis of commands — it is not a sandbox. Constructs it cannot analyze safely are downgraded to `ask`; real enforcement requires a sandboxed execution layer (future work).

## Run

```sh
bun install
bun test          # all package tests
bun run typecheck # tsc --noEmit per package
```
