// Renders the Windows application icon.
//
// Windows draws an .ico tile edge to edge — it adds no padding of its own — so
// an icon that keeps a margin inside its canvas reads smaller than every other
// app in the same taskbar. The artwork is authored on a 1024 canvas with the
// slate plate inset to 64..960 (87.5%), and that inset is the Apple icon grid:
// it belongs to the macOS .icns and nowhere else. Windows gets the same
// artwork scaled by 1024/896 about the canvas centre, so the plate bleeds to
// the edge while the composition inside it stays exactly as designed.
//
// Run with `bun run icons:windows`; the output is committed, so a build never
// has to render an icon.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const ICONS = join(import.meta.dir, "..", "apps", "desktop", "src-tauri", "icons");
const SOURCE = join(ICONS, "icon-source.svg");
const WINDOWS_SOURCE = join(ICONS, "icon-source-windows.svg");
const OUT = join(ICONS, "icon.ico");

// The sizes Windows asks for. 20, 40, 96 and 128 are the ones a 125%, 150% or
// 200% display asks for that the set the Tauri CLI writes does not carry.
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

// 1024/896. The plate is inset 64 on each side of a 1024 canvas, and Windows
// wants it to reach the edge.
const BLEED = "1.1428571428571428";

/**
 * The artwork scaled about the canvas centre so the slate plate bleeds to the
 * edge. Written out as its own file so the Windows icon can be opened and
 * looked at on its own; it is generated rather than drawn, so edit
 * `icon-source.svg` and re-run instead of editing this one.
 */
function windowsArtwork(svg: string): string {
  const defs = svg.indexOf("</defs>");
  const close = svg.lastIndexOf("</svg>");
  if (defs < 0 || close < 0) throw new Error("icon-source.svg: expected </defs> and </svg>");
  const head = svg.slice(0, defs + "</defs>".length);
  const body = svg.slice(defs + "</defs>".length, close);
  const group = `\n  <g transform="translate(512 512) scale(${BLEED}) translate(-512 -512)">`;
  return `${head}${group}${body}\n  </g>\n</svg>\n`;
}

/**
 * How much of the tile the artwork covers, as a side fraction. The plate has
 * to reach every edge, so this is 1 at every size — and it is measured rather
 * than assumed, because "the icon looks small" is exactly the kind of
 * complaint that a wrong assumption survives.
 */
function coverage(svg: string, size: number): number {
  const image = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render();
  const { width, height, pixels } = image;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Alpha alone, not the colour: a dark pixel on a dark taskbar is still
      // part of the icon.
      if (pixels[(y * width + x) * 4 + 3] >= 127) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return 0;
  // `right` is the last covered pixel, so the span counts it.
  return Math.max(right - left + 1, bottom - top + 1) / size;
}

/**
 * An .ico holding one PNG per size. The PNG bytes go in verbatim: Windows has
 * read PNG-compressed entries since Vista, and it is the same form the Tauri
 * CLI writes, so nothing downstream has to learn a new shape.
 */
function packIco(tiles: { size: number; png: Uint8Array }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(tiles.length, 4);

  const entries = Buffer.alloc(16 * tiles.length);
  let offset = header.length + entries.length;
  tiles.forEach((tile, i) => {
    const at = i * 16;
    entries.writeUInt8(tile.size >= 256 ? 0 : tile.size, at); // 0 means 256
    entries.writeUInt8(tile.size >= 256 ? 0 : tile.size, at + 1);
    entries.writeUInt8(0, at + 2); // colour count
    entries.writeUInt8(0, at + 3); // reserved
    entries.writeUInt16LE(0, at + 4); // colour planes, as the Tauri CLI writes it
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(tile.png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += tile.png.length;
  });

  return Buffer.concat([header, entries, ...tiles.map((tile) => Buffer.from(tile.png))]);
}

const artwork = windowsArtwork(await readFile(SOURCE, "utf8"));
await writeFile(WINDOWS_SOURCE, artwork);

const tiles = SIZES.map((size) => ({
  size,
  png: new Resvg(artwork, { fitTo: { mode: "width", value: size } }).render().asPng(),
}));

const report = SIZES.map((size) => {
  const covered = coverage(artwork, size);
  return `${size}px ${(covered * 100).toFixed(1)}%`;
}).join("  ");

// A plate that no longer reaches the edge is the bug this script exists to
// prevent, so it stops the build rather than shipping a smaller icon.
const short = SIZES.filter((size) => coverage(artwork, size) < 0.99);
if (short.length > 0) {
  throw new Error(
    `the Windows plate does not reach the edge at ${short.join(", ")}px; ` +
      "the artwork no longer bleeds and the icon would read small again",
  );
}

await writeFile(OUT, packIco(tiles));

console.log(`icons:windows  wrote ${OUT}`);
console.log(`icons:windows  wrote ${WINDOWS_SOURCE}`);
console.log(`icons:windows  coverage  ${report}`);
