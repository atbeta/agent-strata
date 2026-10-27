# White-label builds

This repository is meant to be forked and rebranded. The point of the mechanism
below is that a fork adds **one file** and changes **nothing else**, so every
upstream commit keeps applying without a conflict.

## What a brand is

| Field | Decides | Where it lands |
|---|---|---|
| `productName` | What the app is called | Installer name, window title, About panel, page title |
| `identifier` | The bundle id | What a machine uses to hold this build beside another |
| `dataDir` | Where state lives | `~/<dataDir>/` — database, token, pid table, logs |
| `sourceUrl` | Where questions go | The About panel's link |
| `sourceLabel` | How that link reads | The About panel's label |
| `icons` (optional) | The bundled marks | Overrides `bundle.icon` |

`sourceUrl` is a plain link, not a build input, so a fork points it at its own
repository — an internal Git host included: `https://git.example.internal/ai/agent`.
The panel hands it to the system browser; only `http`, `https` and `mailto` are
ever opened (`external-link.ts`), so an internal HTTPS URL works unchanged. An
`ssh://` or `git@` address does not: it is not a web page, and clicking it would
do nothing. Link the web view of the repository, not its clone URL.

The upstream build is `Agent Strata` / `me.pbeta.agent-strata` / `.agent-strata`.
Those are the defaults in `tauri.conf.json`, `src-tauri/src/brand.rs`, and
`apps/desktop/ui/src/app-name.ts`, and a checkout that never sets a brand uses
them unchanged.

## Making a fork

One file, once:

```bash
bun run brand --scaffold    # writes scripts/brand.local.ts
```

Edit its `PRESETS`, then build with the preset selected:

```bash
STRATA_BRAND=company bun run brand
```

`scripts/brand.local.ts` is in `.gitignore` on purpose: this repository must
stay free of any one company's name, or every upstream change to the build would
conflict with it.

## What `bun run brand` writes

Nothing when the brand is the upstream one — the committed defaults already say
it, and a file restating them would only give a reviewer something to diff.

For a custom brand it writes two files, both git-ignored:

- `src-tauri/brand.overlay.json` — merged into the Tauri config by
  `tauri build --config`. This is what renames the installer, the bundle id and
  the window title.
- `src-tauri/brand.generated.rs` — the constants Rust reads. `build.rs` notices
  the file and sets `strata_brand_generated`, so a build without it falls back
  to the literals in `brand.rs`.

The page is handled by Vite: `vite.config.ts` resolves the same brand and
injects it as `__BRAND__`, which `app-name.ts` reads.

One resolution, three consumers. That is why the window title and the About panel
cannot disagree.

## Where a fork sets the variables

Local builds:

```bash
STRATA_BRAND=company bun run brand
bun run tauri build
```

CI, as repository variables so a fork's release workflow needs no edit:

| Repository variable | Value |
|---|---|
| `STRATA_BRAND` | the preset name, e.g. `company` |
| `STRATA_BRAND_SOURCE_URL` | e.g. `https://git.example.internal/ai/agent` |
| `STRATA_BRAND_SOURCE_LABEL` | e.g. `AI platform / agent` |
| or `STRATA_BRAND_NAME` | e.g. `Example Agent` |
| `STRATA_BRAND_IDENTIFIER` | e.g. `com.example.agent` |
| `STRATA_BRAND_DATA_DIR` | e.g. `.example-agent` |

A preset is applied first and the individual variables after it, so a fork can
take a company identity and override one field without restating the rest.

The release workflow reads the name back for the release title and passes
`--config` only when an overlay exists — `--config` on a missing file is an
error, and the upstream build has no overlay.

## Why a fork wants a different `dataDir`

Two builds on one machine share `~/.agent-strata` otherwise: one database, one
API token, one pid table. The second build to start would adopt the first's
sessions, and its token would stop working the moment the other one rotated it.
A distinct folder is the whole isolation.

## Keeping up with upstream

```bash
git remote add upstream https://github.com/atbeta/agent-strata
git fetch upstream
git merge upstream/main
```

The merge should be clean. Everything a fork needs is either git-ignored
(`scripts/brand.local.ts`, the two generated files) or comes from the
environment. If a conflict does appear in a file that mentions the product name,
that is a bug in this mechanism, not in the fork — the name is not supposed to be
written down anywhere a fork has to edit.

## Icons

The upstream marks are committed under `src-tauri/icons/`. A white-label build
points `icons` at its own set instead of overwriting them, so upstream's icon
commits keep applying:

```ts
company: {
  // ...
  icons: [
    "icons/company/32x32.png",
    "icons/company/128x128.png",
    "icons/company/128x128@2x.png",
    "icons/company/icon.icns",
    "icons/company/icon.ico",
  ],
}
```

Generate a set with `bunx @tauri-apps/cli icon path/to/mark.png` and move the
output under `src-tauri/icons/company/`.

## What is deliberately *not* branded

- **Log prefixes** (`agent-strata: …` in `service.log`). Diagnostics, not
  product surface; changing them would touch fifteen call sites that upstream
  keeps editing.
- **Cargo crate names** and workspace package names. They are internal
  identifiers, and renaming them would conflict on every upstream change to
  those files.
- **The sidecar binary name** (`strata-service`). It sits next to the executable
  and nothing user-facing reads it.
