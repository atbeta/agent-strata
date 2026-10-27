/**
 * A byte count as a person would say it.
 *
 * One decimal below 10 and none above, because "9.4 KB" reads as a measurement
 * while "9 KB" and "9.375 KB" read as a guess and a spew. Whole bytes never
 * take a decimal: "512 B", not "512.0 B".
 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
