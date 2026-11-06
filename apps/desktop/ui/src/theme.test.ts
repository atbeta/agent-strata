import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyTheme,
  readTheme,
  resolvedTheme,
  saveTheme,
  THEME_KEY,
  WINDOW_COLORS,
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

function install(options: { stored?: string; light?: boolean; denied?: boolean } = {}) {
  const root = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
  };
  const store = new Map<string, string>();
  if (options.stored !== undefined) store.set(THEME_KEY, options.stored);
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
  globals.document = { documentElement: root };
  globals.localStorage = localStorage;
  globals.window = { matchMedia: () => ({ matches: options.light === true }) };
  return { root, store };
}

describe("theme switching", () => {
  test("dark is the default, including when storage is unavailable", () => {
    install();
    expect(readTheme()).toBe("dark");
    install({ denied: true });
    expect(readTheme()).toBe("dark");
  });

  test("only the three known choices are accepted", () => {
    install({ stored: "light" });
    expect(readTheme()).toBe("light");
    install({ stored: "system" });
    expect(readTheme()).toBe("system");
    install({ stored: "solarized" });
    expect(readTheme()).toBe("dark");
  });

  test("system follows the OS, explicit choices do not", () => {
    install({ light: true });
    expect(resolvedTheme("system")).toBe("light");
    expect(resolvedTheme("dark")).toBe("dark");
    install({ light: false });
    expect(resolvedTheme("system")).toBe("dark");
    expect(resolvedTheme("light")).toBe("light");
  });

  test("applying a theme stamps the document before any repaint", () => {
    const { root } = install();
    applyTheme("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    applyTheme("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  test("saving persists the choice and applies it in one step", () => {
    const { root, store } = install();
    saveTheme("light");
    expect(store.get(THEME_KEY)).toBe("light");
    expect(root.dataset.theme).toBe("light");
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

/** Only the plain `hsl(h s% l%)` form theme.css uses for surfaces. */
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

describe("theme tokens", () => {
  const css = read("theme.css");
  const dark = tokens(block(":root"));
  const light = tokens(block('html[data-theme="light"]'));
  // Every theme block is a full replacement for `:root`, so a new theme cannot
  // be half a palette that silently inherits the dark values it forgot.
  const themes = [...css.matchAll(/html\[data-theme="([a-z-]+)"\]/g)].map((m) => String(m[1]));

  test("every theme defines every token the default does", () => {
    expect(themes.length).toBeGreaterThan(0);
    for (const theme of themes) {
      const values = tokens(block(`html[data-theme="${theme}"]`));
      expect([...values.keys()].sort(), theme).toEqual([...dark.keys()].sort());
    }
  });

  test("the native window backdrop matches the page background", () => {
    expect(hslToHex(dark.get("--background")!)).toBe(WINDOW_COLORS.dark);
    expect(hslToHex(light.get("--background")!)).toBe(WINDOW_COLORS.light);

    // The inline script paints before any stylesheet is guaranteed to be
    // there, so it carries literals. They must be the same literals.
    const html = read("..", "index.html");
    const inline = /style\.backgroundColor = light \? "(#[0-9a-f]{6})" : "(#[0-9a-f]{6})"/i.exec(html);
    expect(inline).not.toBeNull();
    expect(inline![1]!.toLowerCase()).toBe(WINDOW_COLORS.light);
    expect(inline![2]!.toLowerCase()).toBe(WINDOW_COLORS.dark);

    // Tauri's static default is the dark backdrop the app launches on.
    const conf = JSON.parse(read("..", "..", "src-tauri", "tauri.conf.json"));
    expect(conf.app.windows[0].backgroundColor.toLowerCase()).toBe(WINDOW_COLORS.dark);
  });

  test("mermaid draws from tokens both themes define, never from a JS palette", () => {
    const src = read("mermaid.ts");
    const used = new Set([...src.matchAll(/"--diagram-[a-z-]+"/g)].map((m) => m[0].slice(1, -1)));
    expect(used.size).toBe(12);
    for (const token of used) {
      expect(dark.has(token), token).toBe(true);
      expect(light.has(token), token).toBe(true);
    }
    expect(src).not.toMatch(/hsl\(/);
  });
});
