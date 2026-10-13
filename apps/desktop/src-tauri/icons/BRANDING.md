# Agent Strata branding

## Concept

**咬合 / Interlock.** Three strata — pearl, ice, and brand blue
(`#F2F6FF/#D0DFF5`, `#A9D3FF/#73A7F3`, `#598CF0/#2B5FC4`) — interlock inside
one upright rounded square. Two stepped negative seams keep each layer
distinct within a single silhouette; the seams and the area outside the
shape are fully transparent, so the form itself is the whole icon with no
backing tile. The shape's 544-unit body is scaled 896/544 to occupy the
standard 896px macOS icon footprint on a 1024 canvas (corner radius 112 →
~184).

## Sources

- `icon-source.svg` — full color icon, viewBox 1024×1024, transparent
  margins and seams.
- `strata-mark.svg` — monochrome (white) mark with identical silhouette and
  seams, viewBox `64 64 896 896` cropped to the glyph. The caption uses the
  full-colour window icon (`favicon.svg`) rather than tinting this one.

## Regenerating

```sh
scripts/generate-icons.sh
```

Uses local `rsvg-convert`, `magick`, and `iconutil` only. It rewrites
`icon-source.png`, `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`
(includes a 1024 retina representation), `icon.ico` (16–256), and the public
UI assets `apps/desktop/ui/public/{favicon.svg,favicon.png,brand/strata-mark.svg}`.

## Updating the installed app

The bundle icons are embedded into `Agent Strata.app` at build time
(`src-tauri/tauri.conf.json` → `bundle.icon`). An already-installed copy
keeps its old icon; updating it requires rebuilding and reinstalling the
app — replacing files inside `/Applications/Agent Strata.app` by hand is not
supported.
