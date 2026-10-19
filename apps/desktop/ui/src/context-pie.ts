/**
 * The path of one pie sector: a filled wedge that starts at 12 o'clock and
 * runs clockwise for `percent` of the circle, centred on (cx, cy). The
 * context gauge is drawn this way rather than as a stroked arc because at a
 * few percent a stub of arc reads as a loading spinner, not a measure.
 * Coordinates are rounded to two decimals so the string is stable enough to
 * assert on in a test.
 */
export function pieSectorPath(percent: number, r: number, cx = 8, cy = 8): string {
  const angle = (Math.min(100, Math.max(0, percent)) / 100) * Math.PI * 2;
  const f = (n: number) => Number(n.toFixed(2));
  const x = f(cx + r * Math.sin(angle));
  const y = f(cy - r * Math.cos(angle));
  const large = percent > 50 ? 1 : 0;
  return `M ${f(cx)} ${f(cy)} L ${f(cx)} ${f(cy - r)} A ${f(r)} ${f(r)} 0 ${large} 1 ${x} ${y} Z`;
}
