import { inDesktopShell } from "./shell";

export type ThemeChoice = "dark" | "light" | "system";

export const THEME_KEY = "strata.theme";

export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // private mode can reject storage; stay on the dark default
  }
  return "dark";
}

export function resolvedTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * Native window backdrop. It has to match `--background` in theme.css pixel
 * for pixel: it is what shows through while the webview resizes or has not
 * painted yet. The inline script in index.html and the Tauri config carry the
 * same pair, and theme.test.ts keeps all three honest.
 */
export const WINDOW_COLORS: Record<"light" | "dark", string> = {
  light: "#fcfcfd",
  dark: "#101012",
};

export function applyTheme(choice: ThemeChoice) {
  const mode = resolvedTheme(choice);
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  if (!inDesktopShell()) return;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow().setBackgroundColor(WINDOW_COLORS[mode]),
  );
}

export function saveTheme(choice: ThemeChoice) {
  localStorage.setItem(THEME_KEY, choice);
  applyTheme(choice);
}
