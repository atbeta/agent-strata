# agent-strata

Cross-backend agent session layer: one canonical event format (CASF v0) that OpenCode (HTTP/SSE) and any ACP agent (stdio) map into, an event store, a pure projector, and a policy engine. The desktop app is a reader over that layer, not a client for one backend. All modules are independently testable with no network or LLM access. `packages/` holds the core libraries; `apps/` holds the UIs.

## Data model

- **The store is a rebuildable cache for imported sessions.** Events an adapter can reproduce from the backend's own record (session metadata, turns, tool calls and results, file changes) are replaced wholesale when that adapter's mapping version changes (`OPENCODE_MAPPER_VERSION`), or on `POST /sessions/:id/rebuild`.
- **Facts only strata saw are kept across rebuilds**: permission requests and decisions, questions and answers, status changes.
- **Streaming snapshots are never stored.** A message still being written lives in the service's memory and reaches readers over `/stream`; the completed message is what the log keeps.
- **Live workspace state is not part of the record.** `GET /sessions/:id/opencode/<path>` and `GET /connections/:id/opencode/<path>` read through to an allow-listed set of OpenCode endpoints (files, find, commands, agents, skills, VCS, LSP/MCP/formatter status, paths); the session form uses the session's workspace as the directory. Nothing read this way is stored.
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
| `@agent-strata/service` | Local HTTP/SSE service over the layer: sessions/views/events query, compare, CASF export, a one-way handoff (`POST /sessions/:id/handoff`) that opens the briefing as a new session on another connected backend, live `/stream`, `/connect` for OpenCode (`baseUrl`) and ACP agents (`backend: "acp"`, `command`, `args`) — the desktop UI's backend |

## Apps

`apps/desktop` — Tauri shell (v2 scaffold): spawns the strata service as a sidecar (and optionally an embedded `opencode serve` when `STRATA_OPENCODE_EMBED=1`), renders `ui/` (Vite + Solid): live fleet dashboard with FTS search, session detail timeline + replay scrubber, compare view, and a policy editor backed by `GET/PUT/DELETE /policy` + `POST /policy/test`. In an OpenCode session the composer completes workspace files with `@`, runs the backend's commands and the app's own session commands (`/compact`, `/undo`, `/share`, …) with `/`, takes pasted, dropped or picked images and PDFs (up to 5 MB each, 10 per prompt), and Tab switches the primary agent; ACP sessions send text. `bun run scripts/probe-composer.ts` sends the same parts through a running strata and OpenCode. See [Desktop app](#desktop-app) for the sidecar build step the shell requires.

`connectOpencode` resolves only after the event stream is attached (first `server.connected` event, bounded by `connectTimeoutMs`, default 10s). `onEvent(evt)` is called after each raw event is ingested, for observing lifecycle events like idle.

v0 adapter-opencode limitations: only the v1 `/event` stream is consumed. Text and reasoning arrive as `message.part.delta`; readers get a snapshot of the message at most every 50ms, and the last one is sent even when the deltas stop. `bun run scripts/probe-stream.ts` checks this end to end against a running OpenCode and strata. A message that arrives before `session.created` still records a placeholder `session.started`; the later `session.created` publishes `session.updated` with the real directory, title, and parent. The SDK's SSE client retries dropped connections internally (exponential backoff); `stop()` aborts the in-flight fetch.

## Connecting an ACP agent

Any agent that speaks ACP over stdio can be a backend:

```sh
curl -X POST http://127.0.0.1:7700/connect -H 'content-type: application/json' \
  -d '{"backend":"acp","command":"opencode","args":["acp"],"cwd":"/path/to/project"}'
```

v0 ACP limitations: sessions live as long as the agent process (no `session/load`), so a session from an earlier run is read-only; there are no model or agent pickers; replies appear when each step finishes rather than streaming.

## Security model

The policy engine performs advisory static analysis of commands — it is not a sandbox. Constructs it cannot analyze safely are downgraded to `ask`; real enforcement requires a sandboxed execution layer (future work). The HTTP API listens on the loopback address only and refuses any request whose Host is not `127.0.0.1`/`localhost` (a DNS-rebound page) or that another site's page made the browser send; only the desktop shell's origins can read its responses cross-origin. Extension reads (`/…/opencode/<path>`) reach files on this machine, so on top of that they are GET-only and allow-listed.

### Auto-accept, per session

The shield in a session's header puts **that one session** on auto (`GET/PUT/DELETE /sessions/:id/policy`, body `{ "mode": "auto" | "inherit" }`). It is not persisted and does not survive a service restart — it is a stance about a conversation in progress, so a session nobody switched back on should not come back unattended.

What it changes is the **fallback only**. `autoAccept` derives from the live policy rather than replacing it, so:

- a rule you wrote saying `deny` still denies, and one saying `ask` still asks — softening the default is declining to be a gate, not overriding your own rules;
- a `default` of `deny` is left alone; inverting a deny-by-default posture is a decision you did not make;
- edits to the shared policy keep reaching a session that is already on auto;
- the engine's floor is untouched, and no policy document can turn it off: a shell construct the engine cannot analyse, or one that writes through a redirect, is still asked about.

Answering a permission card with **always** is a different thing and stays what it was: OpenCode's own memory of one `permission + pattern` for that session. It is narrower than the switch and survives a restart.

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
bun x @tauri-apps/cli@latest dev --config apps/desktop/src-tauri/tauri.conf.json
```

(`bun x tauri` resolves a different package and fails; `cargo tauri dev
--config apps/desktop/src-tauri/tauri.conf.json` works too when tauri-cli is
installed through cargo.)

`tauri.conf.json` already starts the Vite dev server itself
(`beforeDevCommand`), so the second command is only needed if you want the UI in
a plain browser tab. Linux additionally needs the system `webkit2gtk` packages.

## OpenCode runtime

The app does not bundle an `opencode` binary. In embed mode it resolves one in this order: the path saved in `~/.agent-strata/desktop.json` (`opencodeBin`, set from Settings), `STRATA_OPENCODE_BIN`, `PATH`, then the official installer (`~/.opencode/bin`), Homebrew and bun directories. Windows also looks for `.exe`, `.cmd`, `.bat` and `.ps1`, and runs command shims through `cmd /C` or PowerShell. The shell records the source, path, version and last check in `opencode-runtime.json`; `GET /desktop/opencode` returns that beside the process state, which is what the settings page shows. `opencode.pid` names the embedded server it started, so the next launch can reap an orphan before choosing a port instead of opening a second server. Changing the path takes effect on the next launch — the running server keeps the binary it started with. `cargo test` in `apps/desktop/src-tauri` covers discovery and version reading.

## Data maintenance

The log has two kinds of rows, and they are not interchangeable. **Rebuildable** rows — session metadata, turns, tool calls and results, file changes, compaction — can be re-read from the backend and rebuilt. **Local-only** rows — permission requests and decisions, questions and answers, status changes, goals, plans — exist only because strata saw them; no import can recreate them. `EVENT_DATA_CLASS` in `@agent-strata/schema` is the single classification every consumer uses.

Settings → Maintenance shows the database file and content sizes split by that classification, checks integrity, optimizes the WAL and FTS index, vacuums on request, writes `VACUUM INTO` backups under `<db dir>/backups`, and lists hand-made `.bak` snapshots separately for cleanup. Cleaning the rebuildable cache (previewed, optionally only archived sessions older than N days) never touches the local-only rows; a session the backend still has may be imported again on the next sync. Archived sessions live in a folded section at the bottom of the sidebar, not in Maintenance: restoring or deleting one is a session action. Deleting an archived session removes the backend copy when a connected backend can manage it and always purges the local record; `DELETE /sessions/:id?local=1` is the explicit local-only path, and `GET /sessions/:id/data` says how many local-only facts would be lost. Paging `GET /sessions?limit=…` reports `more` so the sidebar can offer the next page instead of silently cutting the list at 200.

## Releasing

Pushing a `v*` tag is the release. GitHub Actions builds the Windows NSIS
installer, the macOS dmg, and the Linux AppImage, and attaches them to that
tag's GitHub release. The tag has to name the version in
`apps/desktop/src-tauri/tauri.conf.json` (`v0.1.0` for `0.1.0`). Nothing else
runs this build. The macOS and Linux artifacts are unsigned.

```sh
git tag v0.1.0
git push origin v0.1.0
```
