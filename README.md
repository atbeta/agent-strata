# agent-strata

Cross-backend agent session layer: one canonical event format (CASF v0) that OpenCode (HTTP/SSE) and any ACP agent (stdio) map into, an event store, a pure projector, and a policy engine. The desktop app is a reader over that layer, not a client for one backend. All modules are independently testable with no network or LLM access. `packages/` holds the core libraries; `apps/` holds the UIs.

## Data model

- **The store is a rebuildable cache for imported sessions.** Events an adapter can reproduce from the backend's own record (session metadata, turns, tool calls and results, file changes) are replaced wholesale when that adapter's mapping version changes (`OPENCODE_MAPPER_VERSION`), or on `POST /sessions/:id/rebuild`.
- **Facts only strata saw are kept across rebuilds**: permission requests and decisions, questions and answers, status changes.
- **Streaming snapshots are never stored.** A message still being written lives in the service's memory and reaches readers over `/stream`; the completed message is what the log keeps.
- **Adapters own their backends' quirks.** Diffs, tool names and argument shapes are mapped in the adapter; the projector reads only CASF.
- `bun run scripts/check-store.ts` reports whether a store holds these invariants.

## Packages

| Package | Purpose |
| --- | --- |
| `@agent-strata/schema` | CASF v0 event schemas (zod), `parseEvent`/`makeEvent`, `redact` |
| `@agent-strata/store` | Append-only `bun:sqlite` event store with FTS5 search and subscriptions |
| `@agent-strata/projector` | Pure projections from events to `SessionView` + cross-session `aggregate` |
| `@agent-strata/policy` | Permission policy engine (rules, glob/regex conditions, shell segmentation) |
| `@agent-strata/adapter-acp` | ACP (ndjson subprocess) adapter: `AcpRecorder` + `connectAcpAgent` |
| `@agent-strata/core` | Event-log consumers: `exportEvents` (CASF JSONL + redaction), `compareSessions` (per-turn two-agent diff) |
| `@agent-strata/adapter-opencode` | opencode v1 event-stream adapter: `OpencodeMapper` + `connectOpencode` |
| `@agent-strata/service` | Local HTTP/SSE service over the layer: sessions/views/events query, compare, CASF export, live `/stream`, `/connect` for OpenCode (`baseUrl`) and ACP agents (`backend: "acp"`, `command`, `args`) — the desktop UI's backend |

## Apps

`apps/desktop` — Tauri shell (v2 scaffold): spawns the strata service as a sidecar (and optionally an embedded `opencode serve` when `STRATA_OPENCODE_EMBED=1`), renders `ui/` (Vite + Solid): live fleet dashboard with FTS search, session detail timeline + replay scrubber, compare view, and a policy editor backed by `GET/PUT/DELETE /policy` + `POST /policy/test`. See [Desktop app](#desktop-app) for the sidecar build step the shell requires.

`connectOpencode` resolves only after the event stream is attached (first `server.connected` event, bounded by `connectTimeoutMs`, default 10s). `onEvent(evt)` is called after each raw event is ingested, for observing lifecycle events like idle.

v0 adapter-opencode limitations: only the v1 `/event` stream is consumed. A message that arrives before `session.created` still records a placeholder `session.started`; the later `session.created` publishes `session.updated` with the real directory, title, and parent. The SDK's SSE client retries dropped connections internally (exponential backoff); `stop()` aborts the in-flight fetch.

## Connecting an ACP agent

Any agent that speaks ACP over stdio can be a backend:

```sh
curl -X POST http://127.0.0.1:7700/connect -H 'content-type: application/json' \
  -d '{"backend":"acp","command":"opencode","args":["acp"],"cwd":"/path/to/project"}'
```

v0 ACP limitations: sessions live as long as the agent process (no `session/load`), so a session from an earlier run is read-only; there are no model or agent pickers; replies appear when each step finishes rather than streaming.

## Security model

The policy engine performs advisory static analysis of commands — it is not a sandbox. Constructs it cannot analyze safely are downgraded to `ask`; real enforcement requires a sandboxed execution layer (future work).

## Run

```sh
bun install
bun test          # all package tests
bun run typecheck # tsc --noEmit per package

# strata service (local API for UIs)
# STRATA_POLICY persists the live permission policy (default ~/.agent-strata/policy.json)
# STRATA_OPENCODE_URL auto-connects a backend on boot, retrying until it is up
#   (the Tauri shell sets this to its spawned `opencode serve` in embed mode);
#   otherwise attach later via POST /connect or the fleet "backends" panel
STRATA_DB=~/.agent-strata/events.db STRATA_PORT=7700 bun run packages/service/src/index.ts

# desktop UI dev (proxies /api -> service) — in its own terminal
bun --cwd apps/desktop/ui run dev
```

On Windows, `STRATA_DB=~/.agent-strata/events.db` is POSIX syntax and `cmd.exe`
will not understand it. Use the platform's own syntax, or just run the service
with its defaults:

```powershell
$env:STRATA_DB="$HOME\.agent-strata\events.db"; $env:STRATA_PORT=7700
bun run packages/service/src/index.ts
```

## Desktop app

The Tauri shell spawns the service as a **sidecar**, so the binary has to exist
before `tauri dev` or `tauri build` is useful — otherwise the window opens and
then the app dies trying to spawn a file that was never compiled. Build it once
per checkout (and again after touching `packages/service`):

```sh
bun run sidecar        # compiles packages/service into src-tauri/binaries/
bun run sidecar:force  # rebuild even if the binary looks current
```

Then run the shell from the repo root:

```sh
bun run sidecar
bun --cwd apps/desktop/ui run dev     # optional: only for UI-only iteration in a browser
bun x tauri dev --config apps/desktop/src-tauri/tauri.conf.json
```

`tauri.conf.json` already starts the Vite dev server itself
(`beforeDevCommand`), so the second command is only needed if you want the UI in
a plain browser tab. Linux additionally needs the system `webkit2gtk` packages.

## Releasing

Pushing a `v*` tag is the release. GitHub Actions builds the Windows NSIS
installer and attaches it to that tag's GitHub release. The tag has to name the
version in `apps/desktop/src-tauri/tauri.conf.json` (`v0.1.0` for `0.1.0`).
Nothing else runs this build. Other platforms are not built yet.

```sh
git tag v0.1.0
git push origin v0.1.0
```
