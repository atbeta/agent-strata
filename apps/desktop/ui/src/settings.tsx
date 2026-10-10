import { createEffect, createResource, createSignal, Show } from "solid-js";
import {
  readOpencodeLaunch,
  saveOpencodeMode,
  type OpencodeLaunchMode,
} from "./api";
import { LOCALES, LOCALE_LABEL, locale, setLocale, t, type Locale } from "./i18n";
import { Icon } from "./icons";
import { readTheme, saveTheme, type ThemeChoice } from "./theme";
import { disableNotify, enableNotify, readNotify } from "./notify";
import {
  CODE_SIZES,
  readFonts,
  saveFonts,
  type CodeSize,
  type FontChoice,
} from "./font";

/** A function, not a const: the labels are translated, so they have to be read
 *  during render for a language switch to reach them. */
const OPENCODE_MODES = (): { id: OpencodeLaunchMode; label: string; hint: string }[] => [
  { id: "embed", label: t("settings.opencode.embed"), hint: t("settings.opencode.embedHint") },
  { id: "external", label: t("settings.opencode.external"), hint: t("settings.opencode.externalHint") },
];

const CODE_PRESETS = [
  "Cascadia Code",
  "Cascadia Mono",
  "Consolas",
  "JetBrains Mono",
  "Sarasa Gothic SC",
  "Maple Mono",
];

const PREVIEW = `const greeting = "你好";
function width(ch: string) {
  return ch.codePointAt(0)! > 255 ? 2 : 1;
}`;

function pill(on: boolean): string {
  return `rounded-md border px-2.5 py-1 text-xs transition-colors ${
    on ? "border-ring bg-secondary text-foreground" : "border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
  }`;
}

const CHOICES = (): { id: ThemeChoice; label: string; hint: string }[] => [
  { id: "dark", label: t("settings.theme.dark"), hint: t("settings.theme.darkHint") },
  { id: "light", label: t("settings.theme.light"), hint: t("settings.theme.lightHint") },
  { id: "system", label: t("settings.theme.system"), hint: t("settings.theme.systemHint") },
];

export function SettingsPage() {
  const [choice, setChoice] = createSignal<ThemeChoice>(readTheme());
  const [launch] = createResource(readOpencodeLaunch);
  const [mode, setMode] = createSignal<OpencodeLaunchMode>("embed");
  const [hydrated, setHydrated] = createSignal(false);
  const [saveErr, setSaveErr] = createSignal("");
  const [fonts, setFonts] = createSignal<FontChoice>(readFonts());
  const [notifyOn, setNotifyOn] = createSignal(readNotify());
  const [notifyErr, setNotifyErr] = createSignal("");

  const patchFonts = (patch: Partial<FontChoice>) => {
    const next = { ...fonts(), ...patch };
    setFonts(next);
    saveFonts(next);
  };

  const launchData = () => (launch.error ? undefined : launch());

  createEffect(() => {
    if (hydrated()) return;
    const data = launchData();
    if (data) {
      setMode(data.mode);
      setHydrated(true);
    } else if (launch.error) {
      setHydrated(true);
    }
  });

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    saveTheme(next);
  };

  const toggleNotify = async () => {
    if (notifyOn()) {
      disableNotify();
      setNotifyOn(false);
      setNotifyErr("");
      return;
    }
    const ok = await enableNotify();
    setNotifyOn(readNotify() && ok);
    setNotifyErr(ok ? "" : t("settings.notify.blocked"));
    if (!ok) disableNotify();
  };

  const pickMode = async (next: OpencodeLaunchMode) => {
    if (next === mode()) return;
    const previous = mode();
    setHydrated(true);
    setMode(next);
    setSaveErr("");
    try {
      await saveOpencodeMode(next);
    } catch (e) {
      setMode(previous);
      setSaveErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div class="mx-auto w-full max-w-lg px-8 py-10">
      <h1 class="text-xl font-medium">{t("settings.title")}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{t("settings.savedHere")}</p>

      <section class="mt-8">
        <h2 class="text-sm font-medium">{t("settings.appearance")}</h2>
        <div
          class="mt-3 grid grid-cols-3 gap-2"
          role="radiogroup"
          aria-label={t("settings.theme")}
        >
          {CHOICES().map((item) => (
            <button
              type="button"
              role="radio"
              aria-checked={choice() === item.id}
              class={`rounded-lg border px-3 py-3 text-left transition-colors ${
                choice() === item.id
                  ? "border-ring bg-secondary"
                  : "border-border hover:bg-secondary/60"
              }`}
              onClick={() => pick(item.id)}
            >
              <span
                class={`mb-2 block h-8 rounded-md border border-border ${
                  item.id === "light"
                    ? "bg-white"
                    : item.id === "system"
                      ? "bg-[linear-gradient(90deg,#f7f7f8_50%,#17171a_50%)]"
                      : "bg-[#17171a]"
                }`}
              />
              <span class="block text-sm font-medium">{item.label}</span>
              <span class="mt-0.5 block text-2xs text-muted-foreground">{item.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section class="mt-8">
        <h2 class="text-sm font-medium">{t("settings.notify.title")}</h2>
        <p class={`mt-1 text-sm leading-5 ${notifyErr() ? "text-destructive" : "text-muted-foreground"}`}>
          {notifyErr() || t("settings.notify.hint")}
        </p>
        <div class="mt-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("settings.notify.title")}>
          <button
            type="button"
            role="radio"
            aria-checked={notifyOn()}
            class={`rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
              notifyOn() ? "border-ring bg-secondary" : "border-border hover:bg-secondary/60"
            }`}
            onClick={() => {
              if (!notifyOn()) void toggleNotify();
            }}
          >
            {t("settings.notify.on")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!notifyOn()}
            class={`rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
              !notifyOn() ? "border-ring bg-secondary" : "border-border hover:bg-secondary/60"
            }`}
            onClick={() => {
              if (notifyOn()) void toggleNotify();
            }}
          >
            {t("settings.notify.off")}
          </button>
        </div>
      </section>

      <section class="mt-8">
        <h2 class="text-sm font-medium">{t("settings.language")}</h2>
        <p class="mt-1 text-sm leading-5 text-muted-foreground">{t("settings.language.hint")}</p>
        <div
          class="mt-3 grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label={t("settings.language")}
        >
          {LOCALES.map((id: Locale) => (
            <button
              type="button"
              role="radio"
              aria-checked={locale() === id}
              class={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                locale() === id
                  ? "border-ring bg-secondary"
                  : "border-border hover:bg-secondary/60"
              }`}
              onClick={() => setLocale(id)}
            >
              {/* Each language in its own name. "English" is not a translation of
                  "英文" to someone who cannot read the one they are looking at. */}
              <span class="block text-sm font-medium">{LOCALE_LABEL[id]}</span>
            </button>
          ))}
        </div>
      </section>

      <section class="mt-8">
        <h2 class="text-sm font-medium">{t("settings.font.title")}</h2>
        <p class="mt-1 text-sm leading-5 text-muted-foreground">{t("settings.font.hint")}</p>

        <label class="mt-4 block">
          <span class="text-xs text-muted-foreground">{t("settings.font.ui")}</span>
          <input
            class="mt-1.5 h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-sm outline-none focus:border-ring"
            placeholder={t("settings.font.placeholder")}
            aria-label={t("settings.font.ui")}
            value={fonts().ui}
            onInput={(e) => patchFonts({ ui: e.currentTarget.value })}
          />
        </label>

        <div class="mt-4">
          <span class="text-xs text-muted-foreground">{t("settings.font.code")}</span>
          <div class="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label={t("settings.font.code")}>
            <button type="button" class={pill(fonts().code === "")} onClick={() => patchFonts({ code: "" })}>
              {t("settings.font.default")}
            </button>
            {CODE_PRESETS.map((name) => (
              <button type="button" class={pill(fonts().code === name)} onClick={() => patchFonts({ code: name })}>
                {name}
              </button>
            ))}
          </div>
          <input
            class="mt-2 h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-sm outline-none focus:border-ring"
            placeholder={t("settings.font.placeholder")}
            aria-label={t("settings.font.family")}
            value={fonts().code}
            onInput={(e) => patchFonts({ code: e.currentTarget.value })}
          />
        </div>

        <div class="mt-4">
          <span class="text-xs text-muted-foreground">{t("settings.font.size")}</span>
          <div class="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("settings.font.size")}>
            <button
              type="button"
              role="radio"
              aria-checked={fonts().size === ""}
              class={pill(fonts().size === "")}
              onClick={() => patchFonts({ size: "" })}
            >
              {t("settings.font.default")}
            </button>
            {CODE_SIZES.map((size: CodeSize) => (
              <button
                type="button"
                role="radio"
                aria-checked={fonts().size === size}
                class={pill(fonts().size === size)}
                onClick={() => patchFonts({ size })}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        <div class="mt-4">
          <span class="text-xs text-muted-foreground">{t("settings.font.leading")}</span>
          <div class="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("settings.font.leading")}>
            <button
              type="button"
              role="radio"
              aria-checked={fonts().leading === ""}
              class={pill(fonts().leading === "")}
              onClick={() => patchFonts({ leading: "" })}
            >
              {t("settings.font.default")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={fonts().leading === "compact"}
              class={pill(fonts().leading === "compact")}
              onClick={() => patchFonts({ leading: "compact" })}
            >
              {t("settings.font.leading.compact")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={fonts().leading === "normal"}
              class={pill(fonts().leading === "normal")}
              onClick={() => patchFonts({ leading: "normal" })}
            >
              {t("settings.font.leading.normal")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={fonts().leading === "relaxed"}
              class={pill(fonts().leading === "relaxed")}
              onClick={() => patchFonts({ leading: "relaxed" })}
            >
              {t("settings.font.leading.relaxed")}
            </button>
          </div>
        </div>

        <div class="mt-4">
          <span class="text-xs text-muted-foreground">{t("settings.font.ligatures")}</span>
          <div class="mt-1.5 flex gap-1.5" role="radiogroup" aria-label={t("settings.font.ligatures")}>
            <button
              type="button"
              role="radio"
              aria-checked={fonts().ligatures}
              class={pill(fonts().ligatures)}
              onClick={() => patchFonts({ ligatures: true })}
            >
              {t("settings.font.ligatures.on")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!fonts().ligatures}
              class={pill(!fonts().ligatures)}
              onClick={() => patchFonts({ ligatures: false })}
            >
              {t("settings.font.ligatures.off")}
            </button>
          </div>
        </div>

        <pre class="mt-4 overflow-x-auto rounded-lg border border-border bg-secondary/40 px-3 py-2 font-mono text-xs whitespace-pre">{PREVIEW}</pre>
      </section>

      <section class="mt-8">
        <h2 class="text-sm font-medium">{t("settings.opencode.title")}</h2>
        <div
          class="mt-3 grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label={t("settings.opencode.title")}
        >
          {OPENCODE_MODES().map((item) => (
            <button
              type="button"
              role="radio"
              aria-checked={mode() === item.id}
              class={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                mode() === item.id
                  ? "border-ring bg-secondary"
                  : "border-border hover:bg-secondary/60"
              }`}
              onClick={() => void pickMode(item.id)}
            >
              <span class="block text-sm font-medium">{item.label}</span>
              <span class="mt-0.5 block text-2xs text-muted-foreground">{item.hint}</span>
            </button>
          ))}
        </div>
        <p class={`mt-3 text-sm ${saveErr() ? "text-destructive" : "text-muted-foreground"}`}>
          {saveErr() || t("settings.opencode.apply")}
        </p>
        <Show when={launchData()?.state === "missing"}>
          <div>
            <p class="mt-3 text-sm text-muted-foreground">{t("settings.opencode.missing")}</p>
            <a
              href="https://opencode.ai"
              target="_blank"
              rel="noreferrer"
              class="mt-1 inline-block text-sm text-muted-foreground hover:text-foreground"
            >
              {t("settings.opencode.install")}
            </a>
          </div>
        </Show>
      </section>

      <section class="mt-8 border-t border-border pt-6">
        <h2 class="text-sm font-medium">{t("settings.permission.title")}</h2>
        <p class="mt-1 text-sm leading-5 text-muted-foreground">
          {t("settings.permission.hint")}
        </p>
        <button
          type="button"
          class="mt-3 inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary"
          onClick={() => (location.hash = "/policy")}
        >
          <Icon name="shield" class="size-3.5 text-muted-foreground" />
          {t("settings.permission.open")}
        </button>
      </section>
    </div>
  );
}
