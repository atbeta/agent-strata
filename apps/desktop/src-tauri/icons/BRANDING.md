# Agent Strata branding

## Concept

**玉色 / Jade.** Strata Core in cool jade: four subtly faceted, interlocking
strata stacked on one upright dark tile.

- Tile — `#14231E`, a 896-unit squircle (corner radius 224) inset 64 on every
  side of the 1024 canvas, with a `#E3FFF5` hairline at 6% opacity tracing it
  1.5 units inside. The icon carries its own backing, so it stays legible on
  both light and dark surfaces and at 16px.
- Strata — a top face lighter than its left facet, each body one step darker
  than the one above it:

  | body   | top face | left facet |
  | ------ | -------- | ---------- |
  | slab 1 | `#96CEBF` | `#A3D9CA` |
  | slab 2 | `#6BB3A1` | `#75BEAB` |
  | slab 3 | `#388C7B` | `#429786` |
  | base   | `#29675C` | `#307367` |

  The group is scaled 0.94 and nudged up, and the whole stack is drawn twice:
  once as `#091713` at 50% offset 16 units down, for the drop shadow that keeps
  the slabs apart from the tile.

The earlier **Interlock** mark (pearl/ice/brand blue on a transparent field)
is gone. Nothing referenced its monochrome variant, so no single-colour
`strata-mark.svg` is produced any more — tinting a mark this faceted does not
preserve it, and the caption bar uses the full-colour window icon instead.

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
