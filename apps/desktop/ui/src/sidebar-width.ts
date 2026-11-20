export const SIDEBAR_WIDTH_KEY = "strata.sidebar-width";

export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 520;
export const SIDEBAR_WIDTH_DEFAULT = 300;
export const SIDEBAR_WIDTH_CEILING = 0.5;

export function sidebarWidthLimit(available: number): number {
  return Math.min(
    SIDEBAR_WIDTH_MAX,
    Math.max(SIDEBAR_WIDTH_MIN, Math.round(available * SIDEBAR_WIDTH_CEILING)),
  );
}

export function clampSidebarWidth(px: number, available: number): number {
  const high = sidebarWidthLimit(available);
  if (!Number.isFinite(px)) return Math.min(SIDEBAR_WIDTH_DEFAULT, high);
  return Math.min(high, Math.max(SIDEBAR_WIDTH_MIN, Math.round(px)));
}

export function readSidebarWidth(
  viewport: number,
  storage: Pick<Storage, "getItem"> = localStorage,
): number {
  try {
    const raw = storage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw !== null) return clampSidebarWidth(Number(raw), viewport);
  } catch {
    // Storage can be unavailable; the default still gives a usable sidebar.
  }
  return clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT, viewport);
}

export function writeSidebarWidth(
  px: number,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px)));
  } catch {
    // The current window still resizes when the choice cannot be remembered.
  }
}
