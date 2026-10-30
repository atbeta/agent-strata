# Agent notes

## Checks
- `bun run typecheck` (root): every package, the desktop UI, and `apps/desktop/ui/bench`.
- `bun test packages`: all package tests.
- `bun run test:ui`: desktop UI unit tests (includes `apps/desktop/ui/bench/metrics.test.ts`).
- `cargo test --locked` in `apps/desktop/src-tauri`: Tauri shell tests.
- CI also runs a WebKit production smoke: `cd apps/desktop/ui && bun run bench --engines webkit --reps 1 --flows A`. Releases call the same reusable CI workflow.

## Transcript bench (`apps/desktop/ui/bench`)
Replays a reader's journeys (cold open, scroll up, wheel, outline jump, session switches) in Playwright WebKit and Chromium against an isolated service + Vite on random ports (temp HOME and DB, never `~/.agent-strata`).
- `cd apps/desktop/ui && bun run bench` — deterministic synthetic fixtures (1,600-turn `long`, 38 heavy turns, 4 small), 3 reps, flows A/B/C.
- `--engines webkit --reps 5 --flows C`, `--compare bench/results/<baseline>.json`, `--headed`, `--dev` (Vite dev server instead of the default production build; dev-mode Solid and HMR wrappers distort costs).
- `bun run bench/profile.ts [--flows A,B]`: Chromium JS CPU profile per step (self/inclusive top functions + .cpuprofile files) to find what to change; judge the change with the bench in WebKit.
- Real store: `--db ~/.agent-strata/events.db --long <id> --heavy <id> --small <id>,<id>,<id>` (copied with `VACUUM INTO`, read-only).
- Exit code 1 means a correctness check failed (wrong landing, stale/blank frames, page errors). Everything else is a quality metric to read against a baseline.
- WebKit is what ships (Tauri/WKWebView on macOS); judge performance changes there first. Measure before and after every transcript performance change, one variable at a time.
- Results and caches are gitignored: `bench/results/`, `bench/.cache/`.
