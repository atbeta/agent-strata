# Embedded OpenCode Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The desktop shell starts `opencode serve` itself, on a free port, with a random password, and restarts it if it dies. A machine with `opencode` on `PATH` needs no environment variables.

**Architecture:** The Tauri shell owns the process. A pure Rust module plans the port, password, arguments, and restart delays, and a supervisor with injected spawn and health functions runs the loop. The shell writes a status file that contains no secret. The service only reads and writes the two JSON files. The settings page chooses embed or external; the choice applies the next time the app starts.

**Tech Stack:** Tauri 2, Rust 2021, Bun 1.3, TypeScript, Solid + Tailwind.

## Global Constraints

- Local dev database `~/.agent-strata/events.db` may be cleared. Do not delete `policy.json`, `connection.json`, or `connections.json`.
- Root and `packages/service/test/` `.tmp-*` files are the user's debug scripts. Do not delete or commit them.
- Do not restart or kill listeners on 7700, 4096, or 5178. Do not run `tauri dev` or `cargo run`. Do not spawn the real `opencode` binary. `cargo test` in `apps/desktop/src-tauri` is allowed. Do not prompt port 4096. Do not run `scripts/probe-*.ts`.
- When the strata port is already listening, the shell must not spawn `opencode` and must not kill any process it did not start.
- The password never appears in the status file, in logs, or in a URL.
- A restart reuses the same port and the same password. The service already has that URL.
- Default mode is embed only when the shell is the process that starts the service. `STRATA_OPENCODE_EMBED=0` forces external. `STRATA_OPENCODE_EMBED=1` forces embed. When the variable is unset, `desktop.json` decides, and a missing file means embed.
- The child working directory is the user home directory, not the repo root.
- The username string is `opencode`.
- Child environment: `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_USERNAME`. Service environment: `STRATA_OPENCODE_URL`, `STRATA_OPENCODE_USERNAME`, `STRATA_OPENCODE_PASSWORD`.
- Health check is `GET /global/health` with HTTP Basic auth. Arguments are `serve --hostname 127.0.0.1 --port {port}`. Do not pass `--mdns`.
- Windows children keep the existing `CREATE_NO_WINDOW` flag (`0x08000000`).
- Service tests pass an explicit directory. They never read or write the user's home.
- Browser verification of the settings page must not save a mode change into the user's real data directory.
- A missing `opencode` binary still lets the strata service start.
- UI copy points at `https://opencode.ai` and does not include an install script.
- UI follows `apps/desktop/DESIGN.md`. Do not edit `DESIGN.md`.
- Commit messages are `type(scope): lower-case sentence`. Commit on `main`.
- Windows PowerShell 5.1: do not chain commands with `&&`. Judge `bun run typecheck` by `$LASTEXITCODE`.

---

## Facts (this machine's `opencode`, do not re-probe with a live server)

1. `opencode serve --help` exposes `--port` (default 0) and `--hostname` (default `127.0.0.1`). It does not expose `--password`.
2. The binary warns `OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` Serve reads that environment variable. The client flag text says the username defaults to `OPENCODE_SERVER_USERNAME` or `opencode`.
3. The client calls `GET /global/health`.
4. `apps/desktop/src-tauri/src/main.rs` already spawns the service, skips the spawn when the strata port is open, and kills children in `Drop`. Embed today is opt-in via `STRATA_OPENCODE_EMBED=1`, always on port 4096, with the repo root as the working directory, and with no password and no restart.
5. The service already forwards `STRATA_OPENCODE_URL`, `STRATA_OPENCODE_USERNAME`, and `STRATA_OPENCODE_PASSWORD` into boot auto-connect (`packages/service/src/index.ts`). The adapter already sends Basic auth.
6. The UI has no Tauri `invoke`. Status reaches the page through the service.

---

## File map

- Create `apps/desktop/src-tauri/src/embed.rs` — plan, status files, supervisor.
- Modify `apps/desktop/src-tauri/src/main.rs` — call the supervisor only when this shell starts the service.
- Modify `packages/service/src/index.ts` — `GET` and `PUT /desktop/opencode`.
- Modify `packages/service/test/service.test.ts` — those routes, using a temp directory.
- Modify `apps/desktop/ui/src/api.ts`, `settings.tsx`, `App.tsx`, and both `locales/*/shell.ts` — the setting and the missing-binary line.

---

### Task 1: Plan the embed without spawning anything

**Files:** Create `apps/desktop/src-tauri/src/embed.rs`. Modify `apps/desktop/src-tauri/src/main.rs` only to add `mod embed;`.

**Produces:**

```rust
pub enum OpencodeMode { Embed, External }
pub enum OpencodeState { Starting, Running, Missing, Restarting, Stopped, External }

pub struct OpencodePlan {
    pub mode: OpencodeMode,
    pub port: u16,
    pub username: String, // always "opencode"
    pub password: String,
    pub url: String,      // http://127.0.0.1:{port}
}

pub fn resolve_mode(env_embed: Option<&str>, file_mode: Option<&str>) -> OpencodeMode
pub fn free_port() -> std::io::Result<u16>
pub fn random_password() -> String
pub fn plan(mode: OpencodeMode) -> std::io::Result<OpencodePlan>
pub fn serve_args(port: u16) -> Vec<String>
pub fn child_env(plan: &OpencodePlan) -> Vec<(String, String)>
pub fn service_env(plan: &OpencodePlan) -> Vec<(String, String)>
pub fn backoff(attempt: u32) -> std::time::Duration
pub fn read_mode(path: &Path) -> OpencodeMode
pub fn write_mode(path: &Path, mode: OpencodeMode) -> std::io::Result<()>
pub fn write_status(path: &Path, mode: OpencodeMode, state: OpencodeState, url: Option<&str>) -> std::io::Result<()>
pub fn read_status(path: &Path) -> Option<OpencodeStatus>
```

`resolve_mode`: `"0"` is external, `"1"` is embed, anything else (including absence) uses the file. File values are the strings `embed` and `external`. Anything else, including a missing file, is embed.

`random_password` is 32 random bytes encoded as URL-safe base64 without padding. `serve_args` is `["serve", "--hostname", "127.0.0.1", "--port", "{port}"]`. `child_env` sets `OPENCODE_SERVER_USERNAME=opencode` and `OPENCODE_SERVER_PASSWORD`. `service_env` sets the three `STRATA_OPENCODE_*` variables. `backoff` is 1s, 2s, 4s, 8s, then 30s for every later attempt. Attempt numbers start at 1.

Status JSON is `{ "mode", "state", "url" }`. `url` is omitted when there is none. The password is not a field. Mode JSON is `{ "opencode": "embed" | "external" }`.

- [ ] **Step 1: Failing `cargo test` cases in `embed.rs`.** Cover `resolve_mode` for unset, `"0"`, `"1"`, `embed`, `external`, and garbage. Cover `serve_args(43123)`, both env lists, `backoff(1)` through `backoff(6)`, a round-trip of mode and status files in a temp directory, and that the status JSON text does not contain the password. `free_port` returns a port that accepts a bind. `random_password` is 43 characters and matches `[A-Za-z0-9_-]+`.

- [ ] **Step 2: Run `cargo test` in `apps/desktop/src-tauri` and confirm the new tests fail to compile.**

- [ ] **Step 3: Implement the functions.** Use `TcpListener::bind("127.0.0.1:0")` for the free port and drop the listener before returning. Use `getrandom` only if it is already a dependency; otherwise `rand` is not available, so read 32 bytes from the OS (`getrandom` crate is not in `Cargo.toml` today — use `std::fs` read of the platform randomness source, or add no new crate and use `Uuid`-free `SystemTime` mixed with a small OS read). Prefer adding nothing. On Windows, read 32 bytes from the system via a `BCryptGenRandom` alternative that needs no crate: `std::collections` cannot. The acceptable approach with no new dependency is `getrandom` only if already present; check `Cargo.lock`. If it is absent, add `getrandom = "0.2"` to `Cargo.toml`. Do not add `tokio` or `reqwest`.

- [ ] **Step 4: `cargo test` passes.** Commit `feat(desktop): plan an embedded opencode server`.

---

### Task 2: Supervise with injected spawn and health

**Files:** `apps/desktop/src-tauri/src/embed.rs`.

**Consumes:** Task 1 types.

**Produces:**

```rust
pub struct Supervisor {
    pub shutdown: Arc<AtomicBool>,
}

pub struct Spawned {
    pub exited: Arc<AtomicBool>,
    pub kill: Box<dyn Fn() + Send>,
}

pub fn supervise<S, H, W>(
    plan: OpencodePlan,
    status_path: &Path,
    spawn: S,
    healthy: H,
    wait: W,
    shutdown: Arc<AtomicBool>,
) where
    S: Fn(&OpencodePlan) -> std::io::Result<Spawned>,
    H: Fn(&OpencodePlan) -> bool,
    W: Fn(Duration),
```

The loop:

1. Write status `starting` with the plan URL.
2. Call `spawn`. On `Err`, write `stopped` and return. A missing binary is not this function's job.
3. Poll `healthy` every time `wait` is asked to sleep 200ms, for up to 8 seconds. Three outcomes: healthy (write `running`), shutdown (kill, write `stopped`, return), or timeout (kill, fall through to restart).
4. While running, `wait` 5 seconds between health checks. Three `healthy == false` results in a row, or `exited == true`, go to restart. Shutdown kills and returns.
5. Restart writes `restarting`, calls `wait(backoff(attempt))`, and spawns the same plan again. Attempt increases. After 8 unsuccessful restarts, write `stopped` and return. A restart that reaches `running` resets the attempt counter to 0.

Tests drive this with no real process and no real sleep. The fake spawn sets `exited` when the test says so. The fake health returns a scripted sequence. The fake wait records the durations and returns immediately. Assert: the same port and password are passed on the second spawn; a shutdown during the first health wait kills once and does not spawn again; eight immediate spawn-exit cycles end in `stopped` and record backoff 1s, 2s, 4s, 8s, 30s.

- [ ] **Step 1: Write the failing tests.**

- [ ] **Step 2: `cargo test` fails.**

- [ ] **Step 3: Implement `supervise`.**

- [ ] **Step 4: `cargo test` passes.** Commit `feat(desktop): restart a dead embedded opencode`.

---

### Task 3: The shell starts it, and only when it owns the service

**Files:** `apps/desktop/src-tauri/src/main.rs`, `apps/desktop/src-tauri/src/embed.rs` if a thin `spawn_opencode` helper belongs next to the supervisor.

**Consumes:** `plan`, `resolve_mode`, `read_mode`, `supervise`, `serve_args`, `child_env`, `service_env`, `write_status`.

Behavior inside `Sidecars::start`, before the service spawn:

1. Data dir stays `~/.agent-strata`. Mode file is `desktop.json`. Status file is `opencode-status.json`.
2. `resolve_mode(env STRATA_OPENCODE_EMBED, read_mode text)`.
3. If the strata port is already open, do not spawn `opencode`, do not write a status file, and do not kill anything. Keep the existing "leaving the existing service in place" log.
4. If the mode is external, write status `external` with no URL, and pass through a pre-set `STRATA_OPENCODE_URL` / username / password the way `main.rs` does today. Do not spawn.
5. If the mode is embed and `which("opencode")` is `None`, write status `missing` with no URL, start the strata service with no `STRATA_OPENCODE_*` values, and do not fail the shell.
6. If the mode is embed and the binary exists, `plan(Embed)`, spawn on a background thread with `supervise`. The spawn closure uses the existing `spawn` helper: binary from `which`, `serve_args`, cwd `home_dir()`, `child_env`, and the same log file. `healthy` is a blocking `GET {url}/global/health` with header `Authorization: Basic base64(opencode:{password})`, timeout about 500ms, success only on HTTP 200. No new HTTP crate: use `std::net::TcpStream` and write the request. `wait` is `std::thread::sleep`, except it returns early when `shutdown` is set.
7. The service this shell spawns receives `service_env` in addition to the existing `STRATA_DB`, `STRATA_PORT`, and `STRATA_POLICY`.
8. `Sidecars` drop sets the shutdown flag, then kills children as it does now. The supervisor must observe the flag and must not spawn again after drop.

Do not change the bundled-sidecar versus `bun` choice. Do not change the "port already open" service branch except to skip the embed.

- [ ] **Step 1: Add the real spawn and the blocking health request behind small functions that the unit tests can call with a closed port.** A test that health against `127.0.0.1:1` returns false is enough. Do not bind 4096, 7700, or 5178.

- [ ] **Step 2: Wire `Sidecars::start`.**

- [ ] **Step 3: `cargo test` passes.** Commit `feat(desktop): start opencode with the shell`.

---

### Task 4: The service exposes the mode and the status

**Files:** `packages/service/src/index.ts`, `packages/service/test/service.test.ts`.

**Produces:** `ServiceOpts.desktopDir?: string`.

- `GET /desktop/opencode` reads `{desktopDir}/opencode-status.json` and `{desktopDir}/desktop.json`. Response:

```ts
{ mode: "embed" | "external"; state: "starting" | "running" | "missing" | "restarting" | "stopped" | "external" | "unmanaged"; url?: string }
```

Missing status file means `state: "unmanaged"` and the mode from `desktop.json` (missing file means `embed`). Malformed JSON is `unmanaged` plus the mode default, not a 500.

- `PUT /desktop/opencode` body `{ "mode": "embed" | "external" }` writes `{desktopDir}/desktop.json` as `{ "opencode": "<mode>" }` and returns `{ "mode": "<mode>", "applied": "next-launch" }`. Any other body is 400. This route does not spawn or kill a process.

When `desktopDir` is omitted, both routes use `join(homedir, ".agent-strata")`. Tests pass a temp directory and never touch the user's home.

- [ ] **Step 1: Failing tests.** GET with no files returns `{ mode: "embed", state: "unmanaged" }`. Write a status file `{ "mode": "embed", "state": "missing" }` and GET it back. PUT `{ "mode": "external" }` then read the file. PUT `{}` is 400.

- [ ] **Step 2: Run the test, confirm it fails.**

- [ ] **Step 3: Implement the routes.** Register them before `extensionRoute`.

- [ ] **Step 4: `bun test` for `packages/service/test/service.test.ts` and the package typecheck.** Commit `feat(service): read and save the opencode launch mode`.

---

### Task 5: Settings and the missing-binary line

**Files:** `apps/desktop/ui/src/api.ts`, `settings.tsx`, `App.tsx`, `locales/zh/shell.ts`, `locales/en/shell.ts`.

**Consumes:** `GET` and `PUT /desktop/opencode`.

Strings, both locales:

| Key | zh | en |
| --- | --- | --- |
| `settings.opencode.title` | OpenCode | OpenCode |
| `settings.opencode.embed` | 内嵌 | Built in |
| `settings.opencode.embedHint` | 打开应用时启动 opencode | Start opencode when the app opens |
| `settings.opencode.external` | 外部 | External |
| `settings.opencode.externalHint` | 连接已经在运行的服务 | Connect to a server that is already running |
| `settings.opencode.apply` | 下次启动应用时生效。 | Takes effect the next time the app starts. |
| `settings.opencode.missing` | 没有找到 opencode。安装后再打开。 | opencode was not found. Install it, then open the app again. |
| `settings.opencode.install` | 安装说明 | Install instructions |
| `sidebar.backend.missing` | 没有找到 opencode | opencode was not found |

The install control is a link to `https://opencode.ai` with `target="_blank"` and `rel="noreferrer"`.

Settings section, under the language section and before the permission section, uses the same radio-card layout as language (`role="radiogroup"`, two buttons). The saved mode comes from GET. Choosing a card calls PUT and, on success, shows `settings.opencode.apply` under the cards. On failure, show the error text in `text-destructive` and leave the previous selection. When `state` is `missing`, show `settings.opencode.missing` and the link. GET failure leaves the cards on embed vs external from a local fallback of embed, and does not show the missing line.

Sidebar: when the connection list is empty and GET `state` is `missing`, the empty line uses `sidebar.backend.missing` and the same install link sits under it. Any other state keeps `sidebar.backend.none`.

- [ ] **Step 1: API functions `readOpencodeLaunch()` and `saveOpencodeMode(mode)`.**

- [ ] **Step 2: Settings section and sidebar line.**

- [ ] **Step 3: `bun run typecheck` in `apps/desktop/ui`.** Open `http://localhost:5178/#/settings` and confirm the two cards render. Do not click them. The running service may not have the route yet; a failed GET must still show the cards and must not show the missing-binary warning.

- [ ] **Step 4: Commit `feat(ui): choose embedded or external opencode`.**

---

## Out of scope

Adding a server from the UI, OAuth, hot-swapping the mode without a restart, bundling the `opencode` binary inside the installer, and killing an `opencode` the shell did not start.

## Self-review

- Spec: free port, random password, home directory, health, backoff restart, kill on exit, install guidance, settings toggle, no env vars required. Each has a task.
- The "port already open" guard is what keeps the user's 4096 and 7700 untouched.
- Restart keeps the port and password, so the service auto-connect URL stays true.
