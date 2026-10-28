# Agent notes

## Checks
- `bun run typecheck` (root): every package, the desktop UI, and `apps/desktop/ui/bench`.
- `bun run test:ui`: desktop UI unit tests (includes `apps/desktop/ui/bench/metrics.test.ts`).

## Transcript bench (`apps/desktop/ui/bench`)
Replays a reader's journeys (cold open, scroll up, wheel, outline jump, session switches) in Playwright WebKit and Chromium against an isolated service + Vite on random ports (temp HOME and DB, never `~/.agent-strata`).
- `cd apps/desktop/ui && bun run bench` — deterministic synthetic fixtures (1,600-turn `long`, 38 heavy turns, 4 small), 3 reps, flows A/B/C.
- `--engines webkit --reps 5 --flows C`, `--compare bench/results/<baseline>.json`, `--headed`.
- Real store: `--db ~/.agent-strata/events.db --long <id> --heavy <id> --small <id>,<id>,<id>` (copied with `VACUUM INTO`, read-only).
- Exit code 1 means a correctness check failed (wrong landing, stale/blank frames, page errors). Everything else is a quality metric to read against a baseline.
- WebKit is what ships (Tauri/WKWebView on macOS); judge performance changes there first. Measure before and after every transcript performance change, one variable at a time.
- Results and caches are gitignored: `bench/results/`, `bench/.cache/`.
