# Agent Strata branding

## Concept

**重叠 / Overlap.** Two satin frames on a slate tile, overlapping so the shared
square glows green.

- Tile — a 896-unit squircle (corner radius 208) inset 64 on every side of the
  1024 canvas, carrying its own diagonal slate gradient `#39414C` → `#151920`
  with a soft top sheen. The icon carries its own backing, so it stays legible on
  both light and dark surfaces and at 16px.
- Frames — two 176-unit squares at 50% offsets along the diagonal, drawn as
  rounded-square outlines with `fill-rule="evenodd"`: a back frame in translucent
  white at 34%/14%, a front frame in near-solid white `#FFFFFF` → `#CFD7E0` with a
  drop shadow so it sits above rather than beside.
- Overlap — the 176-unit square they share, filled with a jade gradient
  `#9DF1CB` → `#3CB584`, lifted further by a top shine and backed by a soft
  radial glow at 42%.

### Why these numbers

An icon that looks fine at 512px can be mush at 24px, and the taskbar is where
this one has to survive. The earlier **Jade strata** mark was four faceted slabs
stacked on a tile; BRANDING.md at that revision recorded what had to be raised
for it to read at taskbar size — facet steps to ≥ 0.11, no 6%-opacity hairline,
a halved shadow. Two of those findings carry over and are worth keeping:

- **A 6%-opacity hairline is noise.** Invisible as detail, but at small sizes it
  adds a stray light edge that reads as a rendering artefact. The rim here is a
  3-unit `url(#rim)` gradient peaking at 30% — present at 128px, gone by 32px,
  which is the right way round for a rim.
- **A large drop shadow doubles every edge at 16px.** The frame carries
  `dy="14" stdDeviation="16"` at 45% opacity. That is enough to separate the front
  frame from the back one and not enough to read as blur.

What changed is the silhouette, not the palette. Four slabs at a taskbar size
were four thin parallelograms whose internal edges fell below what a pixel can
carry. Two overlapping squares plus one lit square is three shapes with one
strong relationship between them, and the relationship — that they *share*
something — is the thing that survives reduction. Verified at 32px: both frames
and the green overlap are individually readable, and the overlap still reads as
an overlap rather than as two adjacent squares.

The earlier **Interlock** mark (pearl/ice/brand blue on a transparent field) and
the **Jade strata** mark are both gone, and so is any single-colour
`strata-mark.svg` — nothing referenced it, and tinting a mark this faceted does
not preserve it. The caption bar uses the full-colour window icon instead.

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
