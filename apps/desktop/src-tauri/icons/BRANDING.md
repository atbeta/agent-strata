# Agent Strata branding

## Concept

**玉色 / Jade.** Strata Core in cool jade: four subtly faceted, interlocking
strata stacked on one upright dark tile.

- Tile — `#17332C`, an 896-unit squircle (corner radius 224) inset 64 on every
  side of the 1024 canvas. The icon carries its own backing, so it stays legible
  on both light and dark surfaces and at 16px.
- Strata — a top face lighter than its left facet, each body one step darker
  than the one above it:

  | body   | top face | left facet | facet − top |
  | ------ | -------- | ---------- | ----------- |
  | slab 1 | `#8FC9B8` | `#C4E9DE` | 0.242 |
  | slab 2 | `#5FAE99` | `#94D2C0` | 0.212 |
  | slab 3 | `#2E7D6C` | `#5EAB98` | 0.174 |
  | base   | `#12463B` | `#2F7C6C` | 0.113 |

  The group is scaled 1.02, and the stack is drawn twice: once as `#091713` at
  32% offset 12 units down, for the drop shadow that keeps the slabs apart from
  the tile.

### Why these numbers

An icon that looks fine at 512px can be mush at 24px, and the taskbar is where
this one has to survive. Three things were doing the damage in the first jade
version:

- **The facet contrast was sub-threshold.** Each left facet sat only 0.03–0.07
  of relative luminance above its own body. At 24px that gap is below what a
  pixel can carry, so all four slabs flattened into one silhouette. Every
  facet step is now ≥ 0.11, and the steps between neighbouring bodies are
  0.115–0.187, so the stack still reads as a stack at taskbar size.
- **A 6%-opacity hairline.** The `#E3FFF5` outline around the tile was pure
  noise: invisible as detail, but at small sizes it added a stray light edge
  that read as a rendering artefact. Removed.
- **A 50% drop shadow at 16px offset.** It doubled every edge and was most of
  the "soft, blurry" quality. Halved and pulled in.

The tile was also lifted from `#14231E` to `#17332C`. Against a dark taskbar the
original was effectively black; a little more green lets the tile read as a
tile instead of a hole.

The earlier **Interlock** mark (pearl/ice/brand blue on a transparent field)
is gone, and so is any single-colour `strata-mark.svg` — nothing referenced it,
and tinting a mark this faceted does not preserve it. The caption bar uses the
full-colour window icon instead.

## Sources

- `icon-source.svg` — the artwork itself, viewBox 1024×1024.
- `icon-source.png` — a 1024px rasterisation of the same, regenerated alongside
  the bundled sizes.

## Regenerating

The bundled icons were produced with the cross-platform Tauri CLI, which works
from a clean checkout on any OS:

```sh
bunx @tauri-apps/cli icon apps/desktop/src-tauri/icons/icon-source.svg -v
```

That writes `icon-source.png`, `32x32.png`, `128x128.png`, `128x128@2x.png`,
`icon.icns`, `icon.ico`, and the platform logo set. After it, copy the source to
the UI and re-rasterise the favicon:

```sh
cp apps/desktop/src-tauri/icons/icon-source.svg apps/desktop/ui/public/favicon.svg
```

`scripts/generate-icons.sh` does the same job from local `rsvg-convert`, `magick`
and `iconutil` only — macOS and Linux, no network. It is not runnable on
Windows.

Whichever path runs, the five files named in `tauri.conf.json` → `bundle.icon`
must exist afterwards.

### Changing the icon while `tauri dev` is running

`tauri-cli` watches the icons directory and relaunches on every change, but the
relaunch is not a rebuild. `tauri-build` declares `rerun-if-changed` for
`tauri.conf.json` only, never for the icon files, so cargo reports `Finished in
0.2s`, relinks nothing, and hands back the same binary with the old resource
still inside it.

Nudge the file it does watch, then let tauri-cli rebuild:

```sh
touch src-tauri/tauri.conf.json
```

Check `target/debug/agent-strata-desktop.exe`'s mtime afterwards — if it did not
move, the build script was skipped and `cargo clean -p agent-strata-desktop`
is the next step.

## Updating the installed app

The bundle icons are embedded into `Agent Strata.app` at build time
(`src-tauri/tauri.conf.json` → `bundle.icon`). An already-installed copy keeps
its old icon — including the icon the shell serves to the window caption bar,
which comes from `apps/desktop/ui/public/favicon.svg`. Updating either means
rebuilding and reinstalling the app; replacing files inside
`/Applications/Agent Strata.app` by hand is not supported.
