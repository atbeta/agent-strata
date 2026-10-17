#!/usr/bin/env bash
# Regenerate every bundled icon from the source SVG:
#   apps/desktop/src-tauri/icons/icon-source.svg  (Jade icon)
# Requires local tools only: rsvg-convert, magick, iconutil. No network.
# macOS/Linux only — on Windows use `bunx @tauri-apps/cli icon`, see BRANDING.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICONS="$ROOT/apps/desktop/src-tauri/icons"
PUBLIC="$ROOT/apps/desktop/ui/public"

for tool in rsvg-convert magick iconutil; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "generate-icons: missing required tool: $tool" >&2
    exit 1
  }
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/strata-icons.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

render() { # render <size> <out>
  rsvg-convert -w "$1" -h "$1" "$ICONS/icon-source.svg" -o "$2"
}

# Full-size source PNG.
render 1024 "$ICONS/icon-source.png"

# Bundled PNGs named in tauri.conf.json.
render 32  "$ICONS/32x32.png"
render 128 "$ICONS/128x128.png"
render 256 "$ICONS/128x128@2x.png"

# ICNS via iconset (includes 1024 as 512x512@2x).
ICONSET="$SCRATCH/icon.iconset"
mkdir -p "$ICONSET"
render 16   "$ICONSET/icon_16x16.png"
render 32   "$ICONSET/icon_16x16@2x.png"
render 32   "$ICONSET/icon_32x32.png"
render 64   "$ICONSET/icon_32x32@2x.png"
render 128  "$ICONSET/icon_128x128.png"
render 256  "$ICONSET/icon_128x128@2x.png"
render 256  "$ICONSET/icon_256x256.png"
render 512  "$ICONSET/icon_256x256@2x.png"
render 512  "$ICONSET/icon_512x512.png"
render 1024 "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$ICONS/icon.icns"

# ICO, multi-size.
render 256 "$SCRATCH/icon-256.png"
magick "$SCRATCH/icon-256.png" -define icon:auto-resize=16,24,32,48,64,128,256 "$ICONS/icon.ico"

# Public UI assets.
cp "$ICONS/icon-source.svg" "$PUBLIC/favicon.svg"
render 32 "$PUBLIC/favicon.png"

echo "generate-icons: wrote bundled icons to $ICONS and public assets to $PUBLIC"
