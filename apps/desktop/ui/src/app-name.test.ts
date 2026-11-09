import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_NAME, UPSTREAM, brandText } from "./app-name";
import { locale, setLocale, type Locale } from "./i18n";
import { isCustom, overlay as brandOverlay, resolveBrand } from "../../../../scripts/brand";

/**
 * The packaged build and the panels have to call the same thing the same way.
 *
 * Both come from one place: `scripts/brand.ts` resolves the brand from the
 * environment, `tauri build --config` merges the overlay it writes, and
 * `vite.config.ts` injects the same answer into the page. Nothing here may hold
 * a second copy of a name — a rename that reached one side and not the other
 * would show two names in the same window.
 *
 * A test process has no injected `__BRAND__`, so `APP_NAME` is the upstream
 * default. That is exactly the invariant the committed config has to satisfy:
 * `tauri.conf.json` is the upstream build, and a white-label build overrides it
 * through the overlay rather than by editing it.
 */
const tauriDir = fileURLToPath(new URL("../../src-tauri/", import.meta.url));

const conf = JSON.parse(readFileSync(`${tauriDir}tauri.conf.json`, "utf8")) as {
  productName?: string;
  app?: { windows?: { title?: string }[] };
};

const overlayPath = `${tauriDir}brand.overlay.json`;

describe("app name", () => {
  /**
   * The brand a build of this checkout resolves to.
   *
   * `app-name.ts` keeps its own `UPSTREAM` as the fallback a browser tab and a
   * test process see, while the value a real build injects comes from
   * `scripts/brand.ts`. Two copies of the same facts, in two modules — which is
   * exactly the drift these tests exist to catch, and could not while they
   * compared the config only to the copy sitting beside it.
   */
  const brand = () => resolveBrand({});

  test("the committed config carries the upstream name", async () => {
    // A fork must not edit this file: the overlay is how it renames the build,
    // and an edit here would conflict on every upstream change to it.
    expect(conf.productName).toBe((await brand()).productName);
  });

  test("the window opens with that name", async () => {
    expect(conf.app?.windows?.[0]?.title).toBe((await brand()).productName);
  });

  test("the page's fallback agrees with the generator's upstream", async () => {
    // What a browser tab and a test process see when nothing was injected. If
    // these two ever disagree, a real build shows the script's name while an
    // unbundled page shows the other one.
    const resolved = await brand();
    expect(UPSTREAM.productName).toBe(resolved.productName);
    expect(UPSTREAM.identifier).toBe(resolved.identifier);
    expect(UPSTREAM.dataDir).toBe(resolved.dataDir);
    expect(APP_NAME).toBe(resolved.productName);
    // The identifier has to keep agreeing too, or a machine would treat the
    // white-label build and the upstream one as the same application.
    const committed = JSON.parse(readFileSync(`${tauriDir}tauri.conf.json`, "utf8")) as {
      identifier?: string;
    };
    expect(committed.identifier).toBe(resolved.identifier);
  });

  test("the overlay, when present, is what the environment asks for", async () => {
    // `bun run brand` leaves this file behind, and a release job runs that step
    // before the build. A stale overlay — written under one `STRATA_BRAND`, then
    // built under another — would ship a name the environment no longer asks
    // for, so when the environment names a brand the file is held to a fresh
    // resolution of the same variables.
    //
    // With no brand named, a leftover overlay belongs to somebody's earlier
    // local white-label build and says nothing about this one. Failing there
    // would turn every white-label build into a red test suite afterwards, and
    // `bun run brand` removes the file anyway on the next plain build.
    if (!existsSync(overlayPath)) return;
    const named = Object.keys(process.env).some(
      (key) => key.startsWith("STRATA_BRAND") && process.env[key]?.trim(),
    );
    if (!named) return;
    const overlay = JSON.parse(readFileSync(overlayPath, "utf8")) as {
      productName?: string;
      identifier?: string;
      app?: { windows?: { title?: string }[] };
    };
    const fresh = await resolveBrand();
    expect(overlay.productName).toBe(fresh.productName);
    expect(overlay.identifier).toBe(fresh.identifier);
    expect(overlay.app?.windows?.[0]?.title).toBe(fresh.productName);
  });
});

/**
 * What `--config` does to the window, which is the part no test covered.
 *
 * `tauri build --config` is an RFC 7386 merge patch: arrays are replaced, not
 * merged element by element. An overlay carrying `app.windows` therefore
 * rewrites the window wholesale, and the list it carries is the whole truth for
 * every field it leaves out. This shipped once — a title-only entry silently
 * dropped `visible: false`, the window size, the macOS overlay title bar, the
 * dark background, and `dragDropEnabled: false`, which hands file drops to
 * Tauri and breaks dropping a file onto the composer.
 *
 * Every suite was green at the time, because they all checked the overlay's own
 * fields instead of what the window becomes after the merge.
 */
describe("the about row", () => {
  test("unset fields keep the upstream link and the translated wording", async () => {
    const brand = await resolveBrand({});
    expect(brand.sourceUrl).toBe(UPSTREAM.sourceUrl);
    expect(brand.sourceLabel).toBe(UPSTREAM.sourceLabel);
    expect(brand.sourceTitle).toBeUndefined();
    expect(brand.sourceHint).toBeUndefined();
    expect(isCustom(brand)).toBe(false);
  });

  test("a title, a sentence, and a link replace the row", async () => {
    const brand = await resolveBrand({
      STRATA_BRAND_SOURCE_TITLE: "使用说明",
      STRATA_BRAND_SOURCE_HINT: "安装和常见问题。",
      STRATA_BRAND_SOURCE_URL: "https://git.example.internal/ai/agent",
      STRATA_BRAND_SOURCE_LABEL: "内网仓库",
    });
    expect(brand.sourceTitle).toBe("使用说明");
    expect(brand.sourceHint).toBe("安装和常见问题。");
    expect(brand.sourceUrl).toBe("https://git.example.internal/ai/agent");
    expect(brand.sourceLabel).toBe("内网仓库");
    expect(isCustom(brand)).toBe(true);
  });

  test("a dash is no link, and a blank variable leaves the link alone", async () => {
    const cleared = await resolveBrand({ STRATA_BRAND_SOURCE_URL: "-" });
    expect(cleared.sourceUrl).toBe("");
    expect(isCustom(cleared)).toBe(true);
    const blank = await resolveBrand({ STRATA_BRAND_SOURCE_URL: "  " });
    expect(blank.sourceUrl).toBe(UPSTREAM.sourceUrl);
    expect(isCustom(blank)).toBe(false);
  });

  test("suffixed variables write each language its own wording", async () => {
    const brand = await resolveBrand({
      STRATA_BRAND_SOURCE_TITLE_ZH: "使用说明",
      STRATA_BRAND_SOURCE_TITLE_EN: "Usage notes",
    });
    expect(brand.sourceTitle).toEqual({ zh: "使用说明", en: "Usage notes" });
    expect(isCustom(brand)).toBe(true);
  });

  test("the plain variable is the language nobody named", async () => {
    const brand = await resolveBrand({
      STRATA_BRAND_SOURCE_TITLE: "说明",
      STRATA_BRAND_SOURCE_TITLE_EN: "Notes",
    });
    expect(brand.sourceTitle).toEqual({ zh: "说明", en: "Notes" });
  });

  test("one language alone collapses back to a plain string", async () => {
    // A map with a single wording is a plain string: the page resolves both
    // the same way, and the payload stays the simpler shape.
    const brand = await resolveBrand({ STRATA_BRAND_SOURCE_TITLE_ZH: "使用说明" });
    expect(brand.sourceTitle).toBe("使用说明");
  });

  /**
   * The link's own wording follows the same rule as the two fields above it.
   *
   * It did not, and that is the half of this that was easy to miss: the title
   * and the sentence were made translatable while the label stayed a plain
   * string, so a brand configured entirely with `_ZH`/`_EN` variables resolved
   * the last one to the upstream repository name and looked ignored.
   */
  test("the link's words take a language too", async () => {
    const brand = await resolveBrand({
      STRATA_BRAND_SOURCE_LABEL_ZH: "博客链接",
      STRATA_BRAND_SOURCE_LABEL_EN: "Blog Link",
    });
    expect(brand.sourceLabel).toEqual({ zh: "博客链接", en: "Blog Link" });
    expect(isCustom(brand)).toBe(true);
  });

  /**
   * A brand that names every field per language, and nothing plain.
   *
   * This is the shape the internal build actually uses, and the one that
   * produced an About row reading "源代码" over an upstream link: the fields
   * existed in the repository, but the workflow never passed them to the build.
   */
  test("a brand written entirely in suffixes resolves all three fields", async () => {
    const brand = await resolveBrand({
      STRATA_BRAND_SOURCE_TITLE_ZH: "功能指引",
      STRATA_BRAND_SOURCE_TITLE_EN: "Feature Guide",
      STRATA_BRAND_SOURCE_HINT_ZH: "反馈问题或查看更新可访问。",
      STRATA_BRAND_SOURCE_HINT_EN: "You can report issues or check for updates here.",
      STRATA_BRAND_SOURCE_LABEL_ZH: "博客链接",
      STRATA_BRAND_SOURCE_LABEL_EN: "Blog Link",
    });
    expect(brand.sourceTitle).toEqual({ zh: "功能指引", en: "Feature Guide" });
    expect(brand.sourceHint).toEqual({
      zh: "反馈问题或查看更新可访问。",
      en: "You can report issues or check for updates here.",
    });
    expect(brand.sourceLabel).toEqual({ zh: "博客链接", en: "Blog Link" });
  });

  /**
   * The workflow maps every one of those variables into the build.
   *
   * GitHub does not export repository variables on its own, so a name missing
   * from the workflow's `env:` block is a variable the build never sees — the
   * failure is silent, and the install ships with the upstream wording. This
   * asserts the mapping exists rather than the outcome, because the outcome
   * cannot be observed from a test.
   */
  test("every brand variable is mapped into the build", () => {
    const workflow = readFileSync(
      new URL("../../../../.github/workflows/desktop-release.yml", import.meta.url),
      "utf8",
    );
    for (const name of [
      "STRATA_BRAND_NAME",
      "STRATA_BRAND_IDENTIFIER",
      "STRATA_BRAND_DATA_DIR",
      "STRATA_BRAND_SOURCE_URL",
      "STRATA_BRAND_SOURCE_LABEL",
      "STRATA_BRAND_SOURCE_TITLE",
      "STRATA_BRAND_SOURCE_HINT",
      "STRATA_BRAND_SOURCE_LABEL_ZH",
      "STRATA_BRAND_SOURCE_LABEL_EN",
      "STRATA_BRAND_SOURCE_TITLE_ZH",
      "STRATA_BRAND_SOURCE_TITLE_EN",
      "STRATA_BRAND_SOURCE_HINT_ZH",
      "STRATA_BRAND_SOURCE_HINT_EN",
    ]) {
      expect(workflow).toContain(`${name}: \${{ vars.${name} }}`);
    }
  });
});

describe("the brand text in the active language", () => {
  const previous = locale();
  const inside = (loc: Locale, check: () => void) => {
    setLocale(loc);
    try {
      check();
    } finally {
      setLocale(previous);
    }
  };

  test("a plain string reads the same everywhere", () => {
    inside("zh", () => expect(brandText("使用说明")).toBe("使用说明"));
    inside("en", () => expect(brandText("使用说明")).toBe("使用说明"));
    expect(brandText(undefined)).toBe("");
  });

  test("a map follows the locale it is read under", () => {
    const text = { zh: "使用说明", en: "Usage notes" };
    inside("zh", () => expect(brandText(text)).toBe("使用说明"));
    inside("en", () => expect(brandText(text)).toBe("Usage notes"));
  });

  test("a missing language falls back to English, then to what exists", () => {
    inside("zh", () => expect(brandText({ en: "Notes" })).toBe("Notes"));
    inside("en", () => expect(brandText({ zh: "说明" })).toBe("说明"));
  });
});

describe("the overlay and the window it merges into", () => {
  const committed = JSON.parse(readFileSync(`${tauriDir}tauri.conf.json`, "utf8")) as {
    app?: { windows?: Record<string, unknown>[] };
  };
  const brand = { ...UPSTREAM, productName: "Agent Carrier", identifier: "com.example.agent" };

  test("the merge keeps every window field the config sets", () => {
    const before = committed.app?.windows?.[0] ?? {};
    const after = (brandOverlay(brand) as { app?: { windows?: Record<string, unknown>[] } }).app?.windows?.[0] ?? {};
    // A field the overlay drops is a field Tauri resets to its own default.
    for (const key of Object.keys(before)) {
      expect({ field: key, present: key in after }).toEqual({ field: key, present: true });
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  test("only the title changes", () => {
    const before = committed.app?.windows?.[0] ?? {};
    const after = (brandOverlay(brand) as { app?: { windows?: Record<string, unknown>[] } }).app?.windows?.[0] ?? {};
    const { title: _t, ...restAfter } = after;
    const { title: _b, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(after.title).toBe(brand.productName);
  });

  test("the two settings whose loss is invisible until it bites are carried", () => {
    const after = (brandOverlay(brand) as { app?: { windows?: Record<string, unknown>[] } }).app?.windows?.[0] ?? {};
    // `visible: false` prevents the blank-window flash before the shell shows it.
    expect(after.visible).toBe(false);
    // `dragDropEnabled: false` is what lets the page, not Tauri, receive a drop.
    expect(after.dragDropEnabled).toBe(false);
  });
});
