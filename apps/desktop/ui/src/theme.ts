import { inDesktopShell } from "./shell";

/**
 * Two independent choices make the window's colours:
 *
 * - the color scheme says how much light the window has (dark, light, or the
 *   OS's answer), and
 * - the theme says which palette paints it.
 *
 * They are separate on purpose. A theme is a palette with a dark and a light
 * rendering — Catppuccin's Mocha and Latte, Dracula and Alucard — so switching
 * the scheme does not throw the reader's theme away, and switching the theme
 * does not change whether the window is dark.
 */
export type ColorScheme = "dark" | "light" | "system";
export type ResolvedScheme = "dark" | "light";

export type ThemeId =
  | "default"
  | "catppuccin"
  | "dracula"
  | "gruvbox"
  | "one"
  | "solarized";

/** Three marks that identify a palette in a picker: page, surface, accent. */
export type ThemeSwatch = {
  background: string;
  surface: string;
  accent: string;
};

export type Theme = {
  id: ThemeId;
  /** A product name, not copy: it is the same in every locale. */
  name: string;
  swatch: Record<ResolvedScheme, ThemeSwatch>;
};

/**
 * Every theme has both renderings, so the scheme never falls back to another
 * theme. The swatch values are also the native window backdrop; theme.test.ts
 * checks them against the matching blocks in theme.css.
 */
export const THEMES: readonly Theme[] = [
  {
    id: "default",
    name: "Strata",
    swatch: {
      dark: { background: "#101012", surface: "#161618", accent: "#6189e5" },
      light: { background: "#fcfcfd", surface: "#ffffff", accent: "#2257d3" },
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    swatch: {
      dark: { background: "#1e1e2e", surface: "#181825", accent: "#89b4fa" },
      light: { background: "#eff1f5", surface: "#ffffff", accent: "#1e66f5" },
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    swatch: {
      dark: { background: "#282a36", surface: "#21222c", accent: "#bd93f9" },
      light: { background: "#fffbeb", surface: "#ffffff", accent: "#644ac9" },
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    swatch: {
      dark: { background: "#282828", surface: "#32302f", accent: "#83a598" },
      light: { background: "#fbf1c7", surface: "#fff9e0", accent: "#076678" },
    },
  },
  {
    id: "one",
    name: "One",
    swatch: {
      dark: { background: "#282c34", surface: "#21252b", accent: "#61afef" },
      light: { background: "#fafafa", surface: "#ffffff", accent: "#2f66e0" },
    },
  },
  {
    id: "solarized",
    name: "Solarized",
    swatch: {
      dark: { background: "#002b36", surface: "#073642", accent: "#48a0de" },
      light: { background: "#fdf6e3", surface: "#eee8d5", accent: "#1b6c9e" },
    },
  },
];

export const DEFAULT_THEME: ThemeId = "default";

export const SCHEME_KEY = "strata.scheme";
/**
 * Before themes existed this key held dark/light/system. Reading it as a
 * fallback keeps the reader's answer across the upgrade instead of resetting
 * them to dark.
 */
export const LEGACY_SCHEME_KEY = "strata.theme";
export const THEME_KEY = "strata.palette";

export type Appearance = {
  scheme: ColorScheme;
  theme: ThemeId;
};

function isScheme(value: unknown): value is ColorScheme {
  return value === "dark" || value === "light" || value === "system";
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEMES.some((theme) => theme.id === value);
}

export function readScheme(): ColorScheme {
  try {
    const stored =
      localStorage.getItem(SCHEME_KEY) ?? localStorage.getItem(LEGACY_SCHEME_KEY);
    if (isScheme(stored)) return stored;
  } catch {
    // private mode can reject storage; stay on the dark default
  }
  return "dark";
}

export function readTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (isThemeId(stored)) return stored;
  } catch {
    // private mode can reject storage; stay on the default palette
  }
  return DEFAULT_THEME;
}

export function readAppearance(): Appearance {
  return { scheme: readScheme(), theme: readTheme() };
}

export function themeMeta(id: ThemeId): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]!;
}

export function resolvedScheme(choice: ColorScheme): ResolvedScheme {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyAppearance(appearance: Appearance) {
  const scheme = resolvedScheme(appearance.scheme);
  const theme = themeMeta(appearance.theme);
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
  // xterm bakes its colours into the canvas, like mermaid bakes them into an
  // SVG, so it needs to be told when the tokens behind it changed.
  window.dispatchEvent(new Event("strata-appearance"));
  if (!inDesktopShell()) return;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow().setBackgroundColor(theme.swatch[scheme].background),
  );
}

export function saveAppearance(appearance: Appearance) {
  localStorage.setItem(SCHEME_KEY, appearance.scheme);
  localStorage.setItem(THEME_KEY, appearance.theme);
  applyAppearance(appearance);
}
