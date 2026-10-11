export const FONT_KEY = "strata.fonts";

export const CODE_SIZES = ["12", "13", "14", "15", "16"] as const;
export type CodeSize = (typeof CODE_SIZES)[number];

export const CODE_LEADINGS = ["compact", "normal", "relaxed"] as const;
export type CodeLeading = (typeof CODE_LEADINGS)[number];

export type FontChoice = {
  ui: string;
  code: string;
  size: CodeSize | "";
  leading: CodeLeading | "";
  ligatures: boolean;
};

export const DEFAULT_FONTS: FontChoice = {
  ui: "",
  code: "",
  size: "",
  leading: "",
  ligatures: true,
};

const SANS_FALLBACK = "ui-sans-serif, system-ui, sans-serif";
const MONO_FALLBACK = 'ui-monospace, "SF Mono", "Cascadia Code", monospace';

const SIZE_PX: Record<CodeSize, string> = {
  "12": "12px",
  "13": "13px",
  "14": "14px",
  "15": "15px",
  "16": "16px",
};

const LEADING: Record<CodeLeading, string> = {
  compact: "1.35",
  normal: "1.5",
  relaxed: "1.7",
};

/** A family name that can sit inside a CSS `font-family` list. */
export function sanitizeFamily(raw: string): string {
  const cleaned = raw.replace(/["'\\;{}<>]/g, "").trim().slice(0, 80);
  if (!cleaned || !/^[\p{L}\p{N} ._-]+$/u.test(cleaned)) return "";
  return cleaned;
}

export function fontStack(family: string, fallback: string): string {
  const name = sanitizeFamily(family);
  return name ? `"${name}", ${fallback}` : fallback;
}

/**
 * Unrelated families to compare against. One is not enough: a family can
 * happen to measure the same as `monospace` while still being installed, and
 * the browser substitutes silently either way, so every answer has to survive
 * more than one baseline.
 */
const BASELINES = ["monospace", "serif", "sans-serif"] as const;

/**
 * Whether the browser resolves `family` to something of its own. Rendering it
 * at a size where the fallback's advance width is decisive, and comparing
 * against each baseline, is the only way to ask without a font enumeration API.
 *
 * Kept pure so it can be tested without a DOM; `measure` supplies the widths.
 */
export function fontIsAvailable(measure: (stack: string) => number, family: string): boolean {
  const name = sanitizeFamily(family);
  if (!name) return false;
  return BASELINES.some((base) => Math.abs(measure(`"${name}", ${base}`) - measure(base)) > 0.5);
}

let measured: CanvasRenderingContext2D | null | undefined;

/** `true` when the answer cannot be known, so callers do not warn about a font that may be there. */
export function isInstalled(family: string): boolean {
  if (typeof document === "undefined") return true;
  if (measured === undefined) {
    measured = document.createElement("canvas").getContext("2d");
  }
  if (!measured) return true;
  const ctx = measured;
  const SAMPLE = "mmmmmmmmmmlli WWW中文0Oo";
  return fontIsAvailable((stack) => {
    ctx.font = `72px ${stack}`;
    return ctx.measureText(SAMPLE).width;
  }, family);
}

function isSize(value: unknown): value is CodeSize {
  return typeof value === "string" && (CODE_SIZES as readonly string[]).includes(value);
}

function isLeading(value: unknown): value is CodeLeading {
  return typeof value === "string" && (CODE_LEADINGS as readonly string[]).includes(value);
}

export function parseFonts(raw: string | null): FontChoice {
  if (!raw) return { ...DEFAULT_FONTS };
  try {
    const parsed = JSON.parse(raw) as Partial<FontChoice>;
    return {
      ui: sanitizeFamily(typeof parsed.ui === "string" ? parsed.ui : ""),
      code: sanitizeFamily(typeof parsed.code === "string" ? parsed.code : ""),
      size: isSize(parsed.size) ? parsed.size : "",
      leading: isLeading(parsed.leading) ? parsed.leading : "",
      ligatures: parsed.ligatures !== false,
    };
  } catch {
    return { ...DEFAULT_FONTS };
  }
}

export function readFonts(): FontChoice {
  try {
    return parseFonts(localStorage.getItem(FONT_KEY));
  } catch {
    return { ...DEFAULT_FONTS };
  }
}

export function applyFonts(choice: FontChoice) {
  const root = document.documentElement;
  const ui = sanitizeFamily(choice.ui);
  const code = sanitizeFamily(choice.code);
  if (ui) root.style.setProperty("--font-sans", fontStack(ui, SANS_FALLBACK));
  else root.style.removeProperty("--font-sans");
  if (code) root.style.setProperty("--font-mono", fontStack(code, MONO_FALLBACK));
  else root.style.removeProperty("--font-mono");

  if (choice.size) {
    root.dataset.codeSize = choice.size;
    root.style.setProperty("--code-size", SIZE_PX[choice.size]);
  } else {
    delete root.dataset.codeSize;
    root.style.removeProperty("--code-size");
  }
  if (choice.leading) {
    root.dataset.codeLeading = choice.leading;
    root.style.setProperty("--code-leading", LEADING[choice.leading]);
  } else {
    delete root.dataset.codeLeading;
    root.style.removeProperty("--code-leading");
  }
  if (choice.ligatures) delete root.dataset.codeLigatures;
  else root.dataset.codeLigatures = "off";
}

export function saveFonts(choice: FontChoice) {
  const next: FontChoice = {
    ui: sanitizeFamily(choice.ui),
    code: sanitizeFamily(choice.code),
    size: choice.size,
    leading: choice.leading,
    ligatures: choice.ligatures,
  };
  localStorage.setItem(FONT_KEY, JSON.stringify(next));
  applyFonts(next);
}
