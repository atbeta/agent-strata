import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyAppearance,
  DEFAULT_THEME,
  readAppearance,
  readScheme,
  readTheme,
  resolvedScheme,
  saveAppearance,
  SCHEME_KEY,
  THEMES,
  THEME_KEY,
  themeMeta,
  type ResolvedScheme,
  type ThemeId,
} from "./theme";

const read = (...parts: string[]) => readFileSync(join(import.meta.dir, ...parts), "utf8");

const globals = globalThis as unknown as Record<string, unknown>;
const originals = {
  document: globals.document,
  localStorage: globals.localStorage,
  window: globals.window,
};

afterEach(() => {
  globals.document = originals.document;
  globals.localStorage = originals.localStorage;
  globals.window = originals.window;
});

function install(options: {
  scheme?: string;
  legacyScheme?: string;
  theme?: string;
  light?: boolean;
  denied?: boolean;
} = {}) {
  const root = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
  };
  const store = new Map<string, string>();
  if (options.scheme !== undefined) store.set(SCHEME_KEY, options.scheme);
  if (options.legacyScheme !== undefined) store.set("strata.theme", options.legacyScheme);
  if (options.theme !== undefined) store.set(THEME_KEY, options.theme);
  const localStorage = {
    getItem(key: string) {
      if (options.denied) throw new Error("storage denied");
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
  const events: string[] = [];
  globals.document = { documentElement: root };
  globals.localStorage = localStorage;
  globals.window = {
    matchMedia: () => ({ matches: options.light === true }),
    dispatchEvent: (event: Event) => {
      events.push(event.type);
      return true;
    },
  };
  return { root, store, events };
}

describe("color scheme", () => {
  test("dark is the default, including when storage is unavailable", () => {
    install();
    expect(readScheme()).toBe("dark");
    install({ denied: true });
    expect(readScheme()).toBe("dark");
  });

  test("only dark, light and system are accepted", () => {
    install({ scheme: "light" });
    expect(readScheme()).toBe("light");
    install({ scheme: "system" });
    expect(readScheme()).toBe("system");
    install({ scheme: "solarized" });
    expect(readScheme()).toBe("dark");
  });

  test("the old theme key still supplies the scheme after an upgrade", () => {
    install({ legacyScheme: "light" });
    expect(readScheme()).toBe("light");
    // The new key wins once it exists.
    install({ scheme: "dark", legacyScheme: "light" });
    expect(readScheme()).toBe("dark");
  });

  test("system follows the OS, explicit choices do not", () => {
    install({ light: true });
    expect(resolvedScheme("system")).toBe("light");
    expect(resolvedScheme("dark")).toBe("dark");
    install({ light: false });
    expect(resolvedScheme("system")).toBe("dark");
    expect(resolvedScheme("light")).toBe("light");
  });
});

describe("theme palette", () => {
  test("the default palette is used when nothing valid is stored", () => {
    install();
    expect(readTheme()).toBe(DEFAULT_THEME);
    install({ theme: "gruvbox" });
    expect(readTheme()).toBe("gruvbox");
    install({ theme: "not-a-theme" });
    expect(readTheme()).toBe(DEFAULT_THEME);
  });

  test("the theme id and scheme are one appearance", () => {
    install({ theme: "dracula", scheme: "system", light: true });
    expect(readAppearance()).toEqual({ theme: "dracula", scheme: "system" });
  });

  test("applying an appearance stamps both attributes", () => {
    const { root, events } = install();
    applyAppearance({ theme: "solarized", scheme: "light" });
    expect(root.dataset.theme).toBe("solarized");
    expect(root.dataset.scheme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    expect(events).toContain("strata-appearance");
    applyAppearance({ theme: "one", scheme: "system" });
    expect(root.dataset.theme).toBe("one");
    expect(root.dataset.scheme).toBe("dark");
  });

  test("saving persists both choices and applies them", () => {
    const { root, store } = install();
    saveAppearance({ theme: "catppuccin", scheme: "system" });
    expect(store.get(SCHEME_KEY)).toBe("system");
    expect(store.get(THEME_KEY)).toBe("catppuccin");
    expect(root.dataset.theme).toBe("catppuccin");
  });

  test("an unknown id still resolves to a theme", () => {
    expect(themeMeta("missing" as ThemeId).id).toBe(DEFAULT_THEME);
  });
});

function block(selector: string): string {
  const css = read("theme.css");
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

function tokens(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(/^\s*(--[\w-]+):\s*(.+);$/gm)) {
    found.set(match[1]!, match[2]!.trim());
  }
  return found;
}

/** Only the plain `hsl(h s% l%)` form theme.css uses for the default palette. */
function hslToHex(value: string): string {
  const parts = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(value);
  if (!parts) throw new Error(`unexpected colour ${value}`);
  const h = Number(parts[1]);
  const s = Number(parts[2]) / 100;
  const l = Number(parts[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const channel = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${channel(r!)}${channel(g!)}${channel(b!)}`;
}

function colorToHex(value: string): string {
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) {
    return `#${[...color.slice(1)].map((part) => part + part).join("")}`;
  }
  return hslToHex(color);
}

function valuesFor(id: ThemeId, scheme: ResolvedScheme): Map<string, string> {
  if (id === DEFAULT_THEME) {
    return tokens(block(scheme === "light" ? 'html[data-scheme="light"]' : ":root"));
  }
  return tokens(block(`html[data-theme="${id}"][data-scheme="${scheme}"]`));
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (at: number) => {
    const v = parseInt(value.slice(at, at + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("theme.css", () => {
  const css = read("theme.css");
  const dark = tokens(block(":root"));
  const light = tokens(block('html[data-scheme="light"]'));
  // Hairlines, scrollbar and elevation belong to the scheme, not the palette.
  const shared = new Set([
    "--border",
    "--input",
    "--scrollbar",
    "--popover-shadow",
    "--dialog-shadow",
    "--composer-shadow",
    "--action-shadow",
  ]);
  const palette = [...dark.keys()].filter((token) => !shared.has(token)).sort();
  const themes = [...css.matchAll(/html\[data-theme="([a-z-]+)"\]\[data-scheme="(dark|light)"\]/g)];

  test("the default light rendering defines every dark token", () => {
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
  });

  test("every named theme defines exactly the palette for both schemes", () => {
    const found = new Set(themes.map((match) => `${match[1]}/${match[2]}`));
    const expected = new Set(
      THEMES.filter((theme) => theme.id !== DEFAULT_THEME).flatMap((theme) =>
        (["dark", "light"] as const).map((scheme) => `${theme.id}/${scheme}`),
      ),
    );
    expect(found).toEqual(expected);
    for (const pair of expected) {
      const [id, scheme] = pair.split("/") as [ThemeId, ResolvedScheme];
      expect([...valuesFor(id, scheme).keys()].sort(), pair).toEqual(palette);
    }
  });

  test("picker swatches are the palette's own page, surface and accent", () => {
    for (const theme of THEMES) {
      for (const scheme of ["dark", "light"] as const) {
        const values = valuesFor(theme.id, scheme);
        const swatch = theme.swatch[scheme];
        expect(colorToHex(values.get("--background")!), `${theme.id}/${scheme} background`).toBe(
          swatch.background,
        );
        expect(colorToHex(values.get("--card")!), `${theme.id}/${scheme} card`).toBe(
          swatch.surface,
        );
        expect(colorToHex(values.get("--primary")!), `${theme.id}/${scheme} primary`).toBe(
          swatch.accent,
        );
      }
    }
  });

  test("text keeps AA contrast on the page and on a card, in every theme", () => {
    // The palette is allowed to be loud; the words are not. Faint metadata is
    // the smallest text in the app, so it is held to the same 4.5:1 as prose:
    // 4.45 leaves room for the rounding in a hand-written hex value.
    const roles = [
      "foreground",
      "muted-foreground",
      "faint-foreground",
      "status-active",
      "status-completed",
      "status-error",
      "status-cancelled",
      "status-pending",
      "event-user",
      "event-assistant",
      "event-tool",
      "event-permission",
      "event-file",
      "cost-up",
      "cost-down",
      "cost-flat",
      "destructive",
      "syntax-comment",
      "syntax-string",
      "syntax-number",
      "syntax-keyword",
      "syntax-function",
      "syntax-property",
      "syntax-type",
      "syntax-punctuation",
    ];
    for (const theme of THEMES) {
      for (const scheme of ["dark", "light"] as const) {
        const values = valuesFor(theme.id, scheme);
        const surfaces = ["--background", "--card"].map((token) =>
          colorToHex(values.get(token)!),
        );
        for (const role of roles) {
          const fg = colorToHex(values.get(`--${role}`)!);
          const minimum = Math.min(...surfaces.map((surface) => contrast(fg, surface)));
          expect(minimum, `${theme.id}/${scheme} ${role}`).toBeGreaterThanOrEqual(4.45);
        }
      }
    }
  });

  test("the native window backdrop matches the page background", () => {
    // The inline script paints before any stylesheet is guaranteed to be
    // there, so it carries literals. They must be the same literals.
    const html = read("..", "index.html");
    const inline = /var themes = (\{[\s\S]*?\});/.exec(html);
    expect(inline).not.toBeNull();
    const backdrops = JSON.parse(inline![1]!) as Record<string, Record<ResolvedScheme, string>>;
    expect(Object.keys(backdrops).sort()).toEqual(THEMES.map((theme) => theme.id).sort());
    for (const theme of THEMES) {
      for (const scheme of ["dark", "light"] as const) {
        expect(backdrops[theme.id]?.[scheme], `${theme.id}/${scheme}`).toBe(
          theme.swatch[scheme].background,
        );
      }
    }
    expect(html).toContain("root.dataset.theme = theme");
    expect(html).toContain("root.dataset.scheme = mode");
    expect(html).toContain('localStorage.getItem("strata.palette")');
    expect(html).toContain('localStorage.getItem("strata.scheme")');
    expect(html).toContain('localStorage.getItem("strata.theme")');

    // Tauri's static default is the default theme's dark backdrop.
    const conf = JSON.parse(read("..", "..", "src-tauri", "tauri.conf.json"));
    expect(conf.app.windows[0].backgroundColor.toLowerCase()).toBe(
      themeMeta(DEFAULT_THEME).swatch.dark.background,
    );
  });

  test("mermaid draws from tokens both schemes define, never from a JS palette", () => {
    const src = read("mermaid.ts");
    const used = new Set([...src.matchAll(/"--diagram-[a-z-]+"/g)].map((m) => m[0].slice(1, -1)));
    expect(used.size).toBe(12);
    for (const token of used) {
      expect(dark.has(token), token).toBe(true);
      expect(light.has(token), token).toBe(true);
    }
    expect(src).not.toMatch(/hsl\(/);
    expect(src).toContain('attributeFilter: ["data-theme", "data-scheme"]');
  });
});
