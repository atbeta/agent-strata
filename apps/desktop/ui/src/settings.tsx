import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
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
  isInstalled,
  readFonts,
  saveFonts,
  type CodeSize,
  type FontChoice,
} from "./font";
import { readThinkingOpen, saveThinkingOpen } from "./thinking";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChoiceCard } from "@/components/ui/choice-card";
import { RowButton } from "@/components/ui/row-button";
import { Switch } from "@/components/ui/switch";
import { Group, PillGroup, Row, Segmented } from "./settings-blocks";
import { PolicyEditor } from "./policy";
import { ProviderSettings } from "./providers";
import { SETTINGS_SECTIONS, settingsSection } from "./settings-sections";

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

const UI_PRESETS = [
  "Segoe UI",
  "Microsoft YaHei",
  "PingFang SC",
  "Inter",
  "Noto Sans",
  "Source Han Sans SC",
];

const PREVIEW_UI = "Agent Strata 会话与设置";
const PREVIEW_CODE = `const greeting = "你好";
function width(ch: string) {
  return ch.codePointAt(0)! > 255 ? 2 : 1;
}`;

/**
 * A font picker that shows what is chosen. The dropdown carries the families
 * this computer actually has, and anything else is reached through one text
 * field — so the control always reads back what the app is using, instead of
 * leaving a free-text box that no longer agrees with the row above it.
 */
function FontPicker(props: {
  label: string;
  value: string;
  presets: string[];
  onChange: (family: string) => void;
}) {
  const [editing, setEditing] = createSignal(false);
  // Availability cannot change while the window is open, so it is asked once.
  const available = createMemo(() => props.presets.filter((name) => isInstalled(name)));
  const chosen = () => (props.value === "" ? t("settings.font.system") : props.value);
  const missing = () => props.value !== "" && !isInstalled(props.value);

  return (
    <div class="w-full">
      <DropdownMenu>
        <DropdownMenuTrigger class="h-8 w-full justify-between gap-3 border border-border px-2.5 text-sm hover:bg-secondary/60">
          <span class={`truncate ${missing() ? "text-destructive" : ""}`}>{chosen()}</span>
          <Icon name="chevron" class="size-3 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => props.onChange("")}>
            {t("settings.font.system")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <For each={available()}>
            {(name) => (
              <DropdownMenuItem
                class="font-mono text-xs"
                onSelect={() => props.onChange(name)}
              >
                {name}
              </DropdownMenuItem>
            )}
          </For>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            {t("settings.font.custom")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Show when={editing() || missing()}>
        <input
          class="mt-2 h-8 w-full rounded-md border border-border bg-transparent px-2.5 text-sm outline-none focus:border-ring"
          placeholder={t("settings.font.placeholder")}
          aria-label={props.label}
          value={props.value}
          onInput={(e) => props.onChange(e.currentTarget.value)}
          onBlur={() => setEditing(false)}
        />
      </Show>
      <Show when={missing()}>
        <p class="mt-1.5 text-2xs leading-4 text-destructive">{t("settings.font.missing")}</p>
      </Show>
    </div>
  );
}

const CHOICES = (): { id: ThemeChoice; label: string }[] => [
  { id: "dark", label: t("settings.theme.dark") },
  { id: "light", label: t("settings.theme.light") },
  { id: "system", label: t("settings.theme.system") },
];

export function SettingsPage(props: { section?: string }) {
  const section = () => settingsSection(props.section);
  const [choice, setChoice] = createSignal<ThemeChoice>(readTheme());
  const [launch] = createResource(readOpencodeLaunch);
  const [mode, setMode] = createSignal<OpencodeLaunchMode>("embed");
  const [hydrated, setHydrated] = createSignal(false);
  const [saveErr, setSaveErr] = createSignal("");
  const [fonts, setFonts] = createSignal<FontChoice>(readFonts());
  const [thinkingOpen, setThinkingOpen] = createSignal(readThinkingOpen());
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
    // Anchored to the left edge rather than centred: a settings page is a
    // document, and a fixed measure floating in the middle of a wide window
    // reads as unfinished. The rail takes the space the measure used to waste.
    <div class="flex w-full items-start gap-10 px-8 py-10">
      <div class="w-44 shrink-0">
        <nav class="sticky top-0" role="tablist" aria-label={t("settings.title")}>
          <For each={SETTINGS_SECTIONS}>
            {(item) => (
              <RowButton
                role="tab"
                id={`settings-tab-${item.id}`}
                aria-selected={section() === item.id}
                aria-controls="settings-panel"
                class={`block px-2.5 py-1.5 hover:bg-secondary/60 ${
                  section() === item.id ? "bg-secondary text-foreground" : ""
                }`}
                active={section() === item.id}
                onClick={() => {
                  location.hash = item.id === SETTINGS_SECTIONS[0].id ? "/settings" : `/settings/${item.id}`;
                }}
              >
                {t(item.label)}
              </RowButton>
            )}
          </For>
        </nav>
        {/* These live in this app's store, not on the server. It belongs to the
            rail as a caption on the whole settings surface rather than as a
            subtitle repeating the title the shell already put in the caption
            bar — which is what this column used to open with. */}
        <p class="mt-3 px-2.5 text-2xs leading-4 text-muted-foreground">
          {t("settings.savedHere")}
        </p>
      </div>

      <div class="min-w-0 max-w-2xl flex-1">
        {/* The page's visible name is the caption bar's. This keeps the
            document outline intact without a second one on screen. */}
        <h1 class="sr-only">{t("settings.title")}</h1>

      <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${section()}`}>
      <Show when={section() === "interface"}>
      <Group label={t("settings.appearance")}>
        {/* This one was a bare Segmented straight inside the group, so its
            control sat under the group heading on the left while every other
            control on the page right-aligned against one edge — the ragged
            edge that Row exists to prevent. */}
        <Row label={t("settings.theme")} controlClass="w-88">
          <Segmented
            label={t("settings.theme")}
            value={choice()}
            onChange={(id) => pick(id as ThemeChoice)}
            options={CHOICES().map((item) => ({
              id: item.id,
              label: item.label,
              swatch: (
                <span
                  class={`h-3.5 w-6 shrink-0 rounded-sm border border-border ${
                    item.id === "light"
                      ? "bg-white"
                      : item.id === "system"
                        ? "bg-[linear-gradient(90deg,#f7f7f8_50%,#17171a_50%)]"
                        : "bg-[#17171a]"
                  }`}
                />
              ),
            }))}
          />
        </Row>
      </Group>

      {/* Language and notification are preferences, not a category each: they
          share one list so the page reads as a page instead of a stack of
          equally loud blocks. */}
      <Group label={t("settings.general")}>
      <section class="divide-y divide-border">
        <Row label={t("settings.language")} hint={t("settings.language.hint")}>
          {/* Each language in its own name. "English" is not a translation of
              "英文" to someone who cannot read the one they are looking at. */}
          <Segmented
            label={t("settings.language")}
            value={locale()}
            onChange={(id) => setLocale(id as Locale)}
            options={LOCALES.map((id) => ({ id, label: LOCALE_LABEL[id] }))}
          />
        </Row>

        <Row label={t("settings.thinking.title")} hint={t("settings.thinking.hint")}>
          <Segmented
            label={t("settings.thinking.title")}
            value={thinkingOpen() ? "open" : "closed"}
            onChange={(id) => {
              const open = id === "open";
              setThinkingOpen(open);
              saveThinkingOpen(open);
            }}
            options={[
              { id: "closed", label: t("settings.thinking.closed") },
              { id: "open", label: t("settings.thinking.open") },
            ]}
          />
        </Row>

        <Row label={t("settings.notify.title")} hint={t("settings.notify.hint")}>
          <Switch
            checked={notifyOn()}
            aria-label={t("settings.notify.title")}
            onChange={() => void toggleNotify()}
          />
        </Row>
      </section>
      <Show when={notifyErr()}>
        <p class="mt-2 text-2xs text-destructive">{notifyErr()}</p>
      </Show>
      </Group>

      <Group label={t("settings.font.title")}>
        <p class="text-2xs leading-4 text-muted-foreground">{t("settings.font.hint")}</p>

        {/* Both families have to appear here. A preview that only shows the code
            font leaves the interface-font row looking like it did nothing, which
            is the same doubt the picker itself has to answer. */}
        <div class="sticky top-0 z-10 -mx-2 mt-3 bg-background px-2 py-2">
          <div class="overflow-hidden rounded-lg border border-border bg-secondary/30">
            <div class="flex items-baseline gap-3 border-b border-border px-3 py-2">
              <span class="w-14 shrink-0 text-2xs text-muted-foreground">
                {t("settings.font.ui")}
              </span>
              <span class="truncate text-sm">{PREVIEW_UI}</span>
            </div>
            <div class="flex items-baseline gap-3 px-3 py-2">
              <span class="w-14 shrink-0 text-2xs text-muted-foreground">
                {t("settings.font.code")}
              </span>
              <pre class="min-w-0 overflow-x-auto font-mono text-xs whitespace-pre">{PREVIEW_CODE}</pre>
            </div>
          </div>
        </div>

        <div class="divide-y divide-border">
          <Row label={t("settings.font.ui")}>
            <FontPicker
              label={t("settings.font.ui")}
              value={fonts().ui}
              presets={UI_PRESETS}
              onChange={(ui) => patchFonts({ ui })}
            />
          </Row>

          <Row label={t("settings.font.code")}>
            <FontPicker
              label={t("settings.font.code")}
              value={fonts().code}
              presets={CODE_PRESETS}
              onChange={(code) => patchFonts({ code })}
            />
          </Row>

          <Row label={t("settings.font.terminal")} hint={t("settings.font.terminal.hint")}>
            <FontPicker
              label={t("settings.font.terminal")}
              value={fonts().terminal}
              presets={CODE_PRESETS}
              onChange={(terminal) => patchFonts({ terminal })}
            />
          </Row>

          <Row label={t("settings.font.size")} controlClass="w-72">
            <PillGroup
              label={t("settings.font.size")}
              value={fonts().size}
              options={[
                { id: "", label: t("settings.font.system") },
                ...CODE_SIZES.map((size: CodeSize) => ({ id: size, label: size })),
              ]}
              onChange={(size) => patchFonts({ size: size as CodeSize | "" })}
            />
          </Row>

          <Row label={t("settings.font.leading")} controlClass="w-72">
            <PillGroup
              label={t("settings.font.leading")}
              value={fonts().leading}
              options={(["", "compact", "normal", "relaxed"] as const).map((option) => ({
                id: option,
                label:
                  option === ""
                    ? t("settings.font.system")
                    : t(`settings.font.leading.${option}`),
              }))}
              onChange={(leading) =>
                patchFonts({
                  leading: leading as "" | "compact" | "normal" | "relaxed",
                })
              }
            />
          </Row>

          <Row label={t("settings.font.ligatures")}>
            <PillGroup
              label={t("settings.font.ligatures")}
              value={fonts().ligatures ? "on" : "off"}
              options={[
                { id: "on", label: t("settings.font.ligatures.on") },
                { id: "off", label: t("settings.font.ligatures.off") },
              ]}
              onChange={(v) => patchFonts({ ligatures: v === "on" })}
            />
          </Row>
        </div>
      </Group>
      </Show>

      <Show when={section() === "opencode"}>
      <Group label={t("settings.opencode.title")}>
        <div
          class="mt-3 grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label={t("settings.opencode.title")}
        >
          {OPENCODE_MODES().map((item) => (
            <ChoiceCard
              mode="radio"
              class="rounded-lg px-3 py-2.5"
              selected={mode() === item.id}
              onSelect={() => void pickMode(item.id)}
            >
              <span class="block text-sm font-medium">{item.label}</span>
              <span class="mt-0.5 block text-2xs text-muted-foreground">{item.hint}</span>
            </ChoiceCard>
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
      </Group>

      <ProviderSettings />
      </Show>

      <Show when={section() === "permission"}>
      {/* Policy is global to strata rather than to one backend, so it is not
          filed under OpenCode. It lives here as the editor itself: one place
          to reach it, and the deep link is the section. */}
      <Group label={t("settings.permission.title")}>
        <PolicyEditor />
      </Group>
      </Show>
      </div>
      </div>
    </div>
  );
}
