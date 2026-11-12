# Agent notes

## Checks
- `bun run typecheck` (root): every package, the desktop UI, and `apps/desktop/ui/bench`.
- `bun run lint` (root): oxlint over the same trees and `scripts`. Warnings fail the run.
- `bun run audit` (root): `bun audit` for the single workspace install (`apps/desktop/ui` is a workspace member; the root lockfile covers it); critical/high advisories fail unless a dated exception with a reason is listed in `scripts/audit.ts`.
- `bun test packages`: all package tests.
- `bun run test:ui`: desktop UI tests — `bun test` for pure logic (includes `apps/desktop/ui/bench/metrics.test.ts`), then `vitest run` for component mounts.
  - DOM tests: `bun:test` has no DOM. `src/dom-env.ts` sets up jsdom — it must be the test file's FIRST import (`dompurify` binds `window` at module load). Not a global preload: `typeof document === "undefined"` guards elsewhere must keep their branch. happy-dom is not a substitute — DOMPurify silently stops sanitising under it.
  - Component tests: `bun test` cannot compile Solid JSX (the tsconfig keeps `"jsx": "preserve"`, bun has no solid transform), so `*.vtest.tsx` files mount components via vitest + vite-plugin-solid + jsdom (`vitest.config.ts`). The `.vtest.` suffix keeps them out of `bun test`'s `.test.` glob. Mount a component there when a bug could only surface at render time.
- `cargo test --locked` in `apps/desktop/src-tauri`: Tauri shell tests. Push and pull request run these; a release runs the check job only, so a shell-test failure does not skip the installers.

## Package boundaries
- Import workspace packages by name (`@agent-strata/*`), never by path. A specifier containing `packages/` fails `no-restricted-imports`; a relative hop into another package's directory fails `scripts/check-boundaries.ts` (runs inside `bun run lint`).
- Each package's `package.json` `exports` map is the whole reachable surface. To expose a module outside `src/index.ts`, add a subpath there (see `@agent-strata/service`'s `./prompt-parts`); deep imports not listed fail resolution.
- `@agent-strata/*` imports must be declared in the importer's `package.json`; the boundary check verifies both the declaration and the exports-map entry.

## Transcript bench (`apps/desktop/ui/bench`)
Replays a reader's journeys (cold open, scroll up, wheel, outline jump, session switches) in Playwright WebKit and Chromium against an isolated service + Vite on random ports (temp HOME and DB, never `~/.agent-strata`).
- `cd apps/desktop/ui && bun run bench` — deterministic synthetic fixtures (1,600-turn `long`, 38 heavy turns, 4 small, 30-turn `giant` with two 200-message turns), 3 reps, flows A/B/C.
- `--flows D` — running long session: latest-turn assistant partials every 50ms while following the tail and scrolling old content; continuous steps end with the gesture, not quiet settle.
- `--flows E` — hundred-message turns: scroll into one from below, jump straight onto another, revisit the first (markdown-cache territory). Real stores need `--giant <id> --giant-turns <turnId>,<turnId>`.
- `--flows F` — entrance correctness: a turn arrives live (must play rise-in), grows past a segment boundary (continuation rows must not), then scrolls away and back (remount replay is informational).
- `--flows S` — a ~9KB markdown reply (prose, lists, code, tables) streams into the followed tail at 64 chars / 50ms, then finishes: what markdown parsing costs per frame.
- `--engines webkit --reps 5 --flows C`, `--compare bench/results/<baseline>.json`, `--headed`, `--dev` (Vite dev server instead of the default production build; dev-mode Solid and HMR wrappers distort costs).
- `bun run bench/profile.ts [--flows A,B]`: Chromium JS CPU profile per step (self/inclusive top functions + .cpuprofile files) to find what to change; judge the change with the bench in WebKit.
- Real store: `--db ~/.agent-strata/events.db --long <id> --heavy <id> --small <id>,<id>,<id>` (copied with `VACUUM INTO`, read-only).
- Exit code 1 means a correctness check failed (wrong landing, stale/blank frames, page errors). Everything else is a quality metric to read against a baseline.
- WebKit is what ships (Tauri/WKWebView on macOS); judge performance changes there first. Measure before and after every transcript performance change, one variable at a time.
- Chromium dies on the long session's cold open — the 1,600-turn view is ~13MB of JSON that lands as one ~800k-pixel tree, and the renderer goes with it (`Target page, context or browser has been closed`). It happens on an unmodified checkout too, and it hits the first Chromium flow of a run, so a Chromium failure is a machine, not a change: judge in WebKit and say so rather than chasing it.
- A cold open that never gets its full view leaves the tail preview standing, and the outline rail never appears — the jump step then waits 30s for a locator that will not come. That is what an aborted Chromium flow looks like from the outside.
- Results and caches are gitignored: `bench/results/`, `bench/.cache/`.
