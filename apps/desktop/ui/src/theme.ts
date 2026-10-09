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

const WINDOW: Record<"light" | "dark", string> = {
  light: "#f7f7f8",
  dark: "#101013",
};

export function applyTheme(choice: ThemeChoice) {
  const mode = resolvedTheme(choice);
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  if (!inDesktopShell()) return;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow().setBackgroundColor(WINDOW[mode]),
  );
}

export function saveTheme(choice: ThemeChoice) {
  localStorage.setItem(THEME_KEY, choice);
  applyTheme(choice);
}
