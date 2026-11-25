import type { SessionSource } from "./api";
import { t } from "./i18n";

// Theme chart colours, blue/violet/cyan first: green and orange read as
// session state elsewhere in the row, so they only come up for a fourth server.
const PALETTE = ["--chart-1", "--chart-5", "--chart-4", "--chart-2", "--chart-3"];

export function sourceColor(index: number): string {
  return `var(${PALETTE[index % PALETTE.length]})`;
}

export function sourceLabel(source: SessionSource): string {
  const name = source.local ? t("sidebar.source.local") : source.name;
  return source.connected ? name : t("sidebar.source.offline", { name });
}
