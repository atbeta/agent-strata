import { createSignal } from "solid-js";
import { LOCALES, LOCALE_LABEL, locale, setLocale, t, type Locale } from "./i18n";
import { Icon } from "./icons";
import { readTheme, saveTheme, type ThemeChoice } from "./theme";

/** A function, not a const: the labels are translated, so they have to be read
 *  during render for a language switch to reach them. */
const CHOICES = (): { id: ThemeChoice; label: string; hint: string }[] => [
  { id: "dark", label: t("settings.theme.dark"), hint: t("settings.theme.darkHint") },
  { id: "light", label: t("settings.theme.light"), hint: t("settings.theme.lightHint") },
  { id: "system", label: t("settings.theme.system"), hint: t("settings.theme.systemHint") },
];

export function SettingsPage() {
  const [choice, setChoice] = createSignal<ThemeChoice>(readTheme());

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    saveTheme(next);
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
