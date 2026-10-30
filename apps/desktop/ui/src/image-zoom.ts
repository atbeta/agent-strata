/** The largest scale that keeps the whole picture inside the frame. */
export function fitScale(nw: number, nh: number, fw: number, fh: number): number {
  if (!(nw > 0) || !(nh > 0) || !(fw > 0) || !(fh > 0)) return 1;
  return Math.min(1, (fw * 0.94) / nw, (fh * 0.9) / nh);
}

export function zoomBounds(fit: number): { min: number; max: number } {
  // Below half of fit the picture only shrinks toward a stamp; past 16x of
  // natural size a pixel is a mosaic tile. A small picture's own 1:1 already
  // sits inside both ends.
  return { min: Math.max(0.05, fit * 0.5), max: 16 };
}

/**
 * Keep the frame point under `anchor` fixed across a zoom: the picture must
 * not slide out from under the cursor it is being zoomed around.
 */
export function zoomAt(
  from: number,
  to: number,
  pos: { x: number; y: number },
  anchor: { x: number; y: number },
): { x: number; y: number } {
  const k = to / from;
  return {
    x: anchor.x - (anchor.x - pos.x) * k,
    y: anchor.y - (anchor.y - pos.y) * k,
  };
}
