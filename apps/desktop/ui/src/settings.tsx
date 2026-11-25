import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { APP_NAME, BRAND, SOURCE_URL, brandText } from "./app-name";
import { readOpencodeLaunch } from "./api";
import { openOpencodeLog } from "./opencode-runtime";
import { copyText } from "./clipboard";
import { settled } from "./resource";
import { inDesktopShell } from "./shell";
import { LOCALES, LOCALE_LABEL, locale, setLocale, t, type Locale } from "./i18n";
import { fadeSignal } from "./errors";
import { Icon } from "./icons";
import {
  readScheme,
  readTheme,
  resolvedScheme,
  saveAppearance,
  THEMES,
  themeMeta,
  type ColorScheme,
  type ResolvedScheme,
  type Theme,
  type ThemeId,
} from "./theme";
import { openNotificationSettings, sendTestNotification } from "./notify";
import {
  CONTENT_SIZES,
  isInstalled,
  readFonts,
  saveFonts,
  type ContentSize,
  type FontChoice,
} from "./font";
import { NotificationSettings } from "./notification-settings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { RowButton } from "@/components/ui/row-button";
import { Switch } from "@/components/ui/switch";
import { TextFieldInput } from "@/components/ui/text-field";
import { Card, Group, PillGroup, Row, Segmented, pickerTrigger } from "./settings-blocks";
import { BackendSettings } from "./backend-settings";
import type { ConnectionsCtl } from "./use-connections";
import { connectionName } from "./connection-name";
import { PolicyEditor } from "./policy";
import { ProviderSettings } from "./providers";
import { MaintenanceSettings } from "./maintenance";
import { PluginSettings } from "./plugin-settings";
import { SkillSettings } from "./skill-settings";
import { WorktreeSettings } from "./worktree-settings";
import { SETTINGS_SECTIONS, settingsSection } from "./settings-sections";
import { handleRovingKey } from "./roving-key";

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

/** A sample of the app's own prose, so the picker previews the real thing. */
const PREVIEW_UI = "本地会话与设置";
const PREVIEW_CODE = `const greeting = "你好";
function width(ch: string) {
  return ch.codePointAt(0)! >= 255 ? 2 : 1;
}`;

// The source link comes from the brand, so a white-label build points wherever
// its own build points rather than at the upstream repository.

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
        <DropdownMenuTrigger class={pickerTrigger}>
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
        <TextFieldInput
          size="sm"
          class="mt-2"
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

/** Three marks from the palette: the page, a surface on it, and the accent. */
function ThemeSwatch(props: { theme: Theme; scheme: ResolvedScheme }) {
  const colors = () => props.theme.swatch[props.scheme];
  return (
    <span class="flex shrink-0 items-center -space-x-1" aria-hidden="true">
      <span
        class="size-3 rounded-full ring-1 ring-inset ring-foreground/15"
        style={{ background: colors().background }}
      />
      <span
        class="size-3 rounded-full ring-1 ring-inset ring-foreground/15"
        style={{ background: colors().surface }}
      />
      <span
        class="size-3 rounded-full ring-1 ring-inset ring-foreground/15"
        style={{ background: colors().accent }}
      />
    </span>
  );
}

/**
 * A palette is chosen by name, with its own colours in front of it. The swatch
 * follows the current scheme, so the picker previews the rendering the reader
 * would actually get rather than always showing the dark one.
 */
function ThemePicker(props: {
  label: string;
  value: ThemeId;
  scheme: ResolvedScheme;
  onChange: (id: ThemeId) => void;
}) {
  const current = () => themeMeta(props.value);
  return (
    <div class="w-full">
      <DropdownMenu>
        <DropdownMenuTrigger class={pickerTrigger} aria-label={props.label}>
          <span class="flex min-w-0 items-center gap-2">
            <ThemeSwatch theme={current()} scheme={props.scheme} />
            <span class="truncate">{current().name}</span>
          </span>
          <Icon name="chevron" class="size-3 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="max-h-80 w-[var(--kb-popper-anchor-width)] min-w-0 overflow-y-auto">
          <For each={THEMES}>
            {(theme) => (
              <DropdownMenuItem onSelect={() => props.onChange(theme.id)}>
                <ThemeSwatch theme={theme} scheme={props.scheme} />
                <span class="min-w-0 flex-1 truncate">{theme.name}</span>
                <Show when={theme.id === props.value}>
                  <Icon name="check" class="ml-auto size-3 shrink-0" />
                </Show>
              </DropdownMenuItem>
            )}
          </For>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const SCHEMES = (): { id: ColorScheme; label: string }[] => [
  { id: "dark", label: t("settings.scheme.dark") },
  { id: "light", label: t("settings.scheme.light") },
  { id: "system", label: t("settings.scheme.system") },
];

export function SettingsPage(props: { section?: string; plugin?: string; skill?: string; conns: ConnectionsCtl }) {
  const section = () => settingsSection(props.section);
  const [scheme, setScheme] = createSignal<ColorScheme>(readScheme());
  const [theme, setTheme] = createSignal<ThemeId>(readTheme());
  const [diagNote, setDiagNote] = fadeSignal("");
  const [diagErr, setDiagErr] = fadeSignal("");
  const [diagKey, setDiagKey] = createSignal("");
  const [fonts, setFonts] = createSignal<FontChoice>(readFonts());
  // What the diagnostics report reads; the engine itself is managed with the servers.
  const [launch] = createResource(readOpencodeLaunch);

  const patchFonts = (patch: Partial<FontChoice>) => {
    const next = { ...fonts(), ...patch };
    setFonts(next);
    saveFonts(next);
  };

  const launchData = () => (launch.error ? undefined : launch());
  const unreachedBackends = () =>
    (settled(props.conns.conns)?.connections ?? [])
      .filter((conn) => conn.plugins === false)
      .map((conn) => connectionName(conn));
  const testNotification = async () => {
    setDiagKey("notify");
    setDiagErr("");
    setDiagNote("");
    try {
      await sendTestNotification();
      setDiagNote(t("settings.about.testSent"));
    } catch (e) {
      setDiagErr(e instanceof Error ? e.message : t("err.network"));
    }
  };
  const openNotifySettings = async () => {
    setDiagKey("notify");
    setDiagErr("");
    setDiagNote("");
    try {
      await openNotificationSettings();
    } catch (e) {
      setDiagErr(e instanceof Error ? e.message : t("err.network"));
    }
  };

  const openLog = async () => {
    setDiagKey("log");
    setDiagErr("");
    setDiagNote("");
    try {
      const path = await openOpencodeLog();
      setDiagNote(t("settings.about.logOpened", { path }));
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setDiagErr(message.includes("log file") ? t("settings.about.noLog") : message || t("err.network"));
    }
  };

  /** Feedback for the row that produced it — log opened, report copied,
   *  notification sent. */
  const diagLine = (key: string) => (
    <Show when={diagKey() === key && (diagNote() || diagErr())}>
      <p
        class={`mt-1.5 flex items-center gap-1.5 text-2xs ${
          diagErr() ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        <Icon name={diagErr() ? "alert" : "check"} class="size-3 shrink-0" />
        {diagErr() || diagNote()}
      </p>
    </Show>
  );

  const copyDiagnostics = async () => {
    setDiagKey("report");
    setDiagErr("");
    setDiagNote("");
    const report = launchData()?.runtime;
    const lines = [
      `${APP_NAME} v${__APP_VERSION__}`,
      `mode: ${launchData()?.mode ?? "—"}`,
      `state: ${launchData()?.state ?? "—"}`,
      `url: ${launchData()?.url ?? "—"}`,
      `opencode: ${report?.bin ?? "—"}`,
      `version: ${report?.version ?? "—"}`,
      `source: ${report?.source ?? "—"}`,
      `error: ${report?.error ?? "—"}`,
      `checked_at: ${report?.checked_at ? new Date(report.checked_at * 1000).toISOString() : "—"}`,
    ];
    if (await copyText(lines.join("\n"))) setDiagNote(t("settings.about.diagnosticsCopied"));
  };

  const pickScheme = (next: ColorScheme) => {
    setScheme(next);
    saveAppearance({ theme: theme(), scheme: next });
  };

  const pickTheme = (next: ThemeId) => {
    setTheme(next);
    saveAppearance({ theme: next, scheme: scheme() });
  };

  const sectionItems: HTMLButtonElement[] = [];
  const selectSection = (id: string) => {
    location.hash = id === SETTINGS_SECTIONS[0].id ? "/settings" : `/settings/${id}`;
  };

  return (
    // Anchored to the left edge rather than centred: a settings page is a
    // document, and a fixed measure floating in the middle of a wide window
    // reads as unfinished. The rail takes the space the measure used to waste.
    <div class="flex w-full flex-col items-start gap-6 px-5 py-6 @min-[880px]/main:flex-row @min-[880px]/main:gap-10 @min-[880px]/main:px-8 @min-[880px]/main:py-10">
      <div class="w-full shrink-0 @min-[880px]/main:w-44">
        <nav class="flex gap-1 overflow-x-auto @min-[880px]/main:sticky @min-[880px]/main:top-0 @min-[880px]/main:block" role="tablist" aria-label={t("settings.title")}>
          <For each={SETTINGS_SECTIONS}>
            {(item, index) => (
              <RowButton
                ref={(el) => (sectionItems[index()] = el)}
                role="tab"
                id={`settings-tab-${item.id}`}
                aria-selected={section() === item.id}
                aria-controls="settings-panel"
                tabIndex={section() === item.id ? 0 : -1}
                class={`w-auto shrink-0 whitespace-nowrap px-2.5 py-1.5 @min-[880px]/main:w-full ${
                  section() === item.id ? "bg-accent text-foreground hover:bg-accent font-medium" : ""
                }`}
                active={section() === item.id}
                onClick={() => selectSection(item.id)}
                onKeyDown={(event) =>
                  handleRovingKey(event, index(), SETTINGS_SECTIONS, selectSection, sectionItems)
                }
              >
                <Icon name={item.icon} class="size-3.5 shrink-0" />
                {t(item.label)}
              </RowButton>
            )}
          </For>
        </nav>
      </div>

      <div class={`w-full min-w-0 flex-1 ${section() === "plugins" ? "max-w-5xl" : section() === "skills" ? "max-w-4xl" : "max-w-2xl"}`}>
        {/* The page's visible name is the caption bar's. This keeps the
            document outline intact without a second one on screen. */}
        <h1 class="sr-only">{t("settings.title")}</h1>

      <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${section()}`} class="[&>section:first-child]:mt-0">
      <Show when={section() === "interface"}>
      {/* One card for everything the eye sees — the theme, then the two
          families and their sizes. A group per concern left 主题 alone in a
          bordered box: ceremony without content. */}
      <Group label={t("settings.appearance")} hint={t("settings.appearance.hint")}>
        <Card>
          {/* Right-aligned like every other row on the page — a bare Segmented
              under the group heading was the ragged edge that Row prevents. */}
          <Row label={t("settings.scheme")}>
            <Segmented
              label={t("settings.scheme")}
              value={scheme()}
              onChange={(id) => pickScheme(id as ColorScheme)}
              options={SCHEMES()}
            />
          </Row>

          <Row label={t("settings.theme")} hint={t("settings.theme.hint")} controlClass="w-48">
            <ThemePicker
              label={t("settings.theme")}
              value={theme()}
              scheme={resolvedScheme(scheme())}
              onChange={pickTheme}
            />
          </Row>

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
          {/* Both families have to appear here. A preview that only shows the code
              font leaves the interface-font row looking like it did nothing, which
              is the same doubt the picker itself has to answer. It pins while the
              rows beneath scroll past, on the card's own surface. */}
          <div class="sticky top-0 z-10 border-b border-border bg-card py-3">
            <div class="flex items-baseline gap-3">
              <span class="w-14 shrink-0 text-2xs text-muted-foreground">
                {t("settings.font.ui")}
              </span>
              <span class="truncate text-sm">{PREVIEW_UI}</span>
            </div>
            <div class="mt-2 flex items-baseline gap-3">
              <span class="w-14 shrink-0 text-2xs text-muted-foreground">
                {t("settings.font.code")}
              </span>
              <pre class="min-w-0 overflow-x-auto font-mono text-xs whitespace-pre">{PREVIEW_CODE}</pre>
            </div>
          </div>

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

          <Row label={t("settings.font.size")} hint={t("settings.font.size.hint")}>
            <PillGroup
              label={t("settings.font.size")}
              value={fonts().size}
              options={[
                { id: "", label: t("settings.font.default") },
                ...CONTENT_SIZES.map((size: ContentSize) => ({ id: size, label: size })),
              ]}
              onChange={(size) => patchFonts({ size: size as ContentSize | "" })}
            />
          </Row>

          <Row label={t("settings.font.leading")}>
            <PillGroup
              label={t("settings.font.leading")}
              value={fonts().leading}
              options={(["", "compact", "normal", "relaxed"] as const).map((option) => ({
                id: option,
                label:
                  option === ""
                    ? t("settings.font.default")
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
            <Switch
              checked={fonts().ligatures}
              aria-label={t("settings.font.ligatures")}
              onChange={(next) => patchFonts({ ligatures: next })}
            />
          </Row>
        </Card>
      </Group>

      </Show>

      <Show when={section() === "notifications"}>
        <WorktreeSettings />
        <NotificationSettings />
      </Show>

      <Show when={section() === "backends"}>
        <BackendSettings conns={props.conns} />
      </Show>


      <Show when={section() === "skills"}>
        <SkillSettings conns={props.conns} skillId={props.skill} />
      </Show>

      <Show when={section() === "models"}>
      {/* Filling a key is a first-run task, not runtime surgery: it gets its
          own section instead of the bottom of the process manager. The keys
          themselves are written to OpenCode either way. */}
      <ProviderSettings conns={props.conns} />
      </Show>

      <Show when={section() === "plugins"}>
        <PluginSettings pluginId={props.plugin} unreached={unreachedBackends()} />
      </Show>

      <Show when={section() === "permission"}>
      {/* Policy is global to strata rather than to one backend, so it is not
          filed under OpenCode. It lives here as the editor itself: one place
          to reach it, and the deep link is the section. */}
      <PolicyEditor />
      </Show>

      <Show when={section() === "maintenance"}>
        <MaintenanceSettings />
      </Show>

      <Show when={section() === "about"}>
      {/* The caption bar already carries the mark, but only at 24px and only
          when the window draws its own title bar. This is the one surface that
          states the build outright — the first thing anyone checks before
          filing a bug — so the icon is worth showing at a readable size. */}
      <Group label={t("settings.about.title")}>
        <div class="flex items-center gap-4">
          <img
            src="/favicon.svg"
            alt=""
            draggable={false}
            class="size-16 shrink-0 rounded-2xl"
          />
          <div class="min-w-0">
            <div class="text-sm font-medium">{APP_NAME}</div>
            <p class="mt-0.5 text-2xs leading-4 text-muted-foreground">
              {t("settings.about.tagline")}
            </p>
          </div>
        </div>

        <Card class="mt-5">
          {/* Sans tabular — a number read as a number; the link next row is
              the one that truncates. */}
          <Row label={t("settings.about.version")}>
            <span class="text-sm tabular-nums text-foreground">v{__APP_VERSION__}</span>
          </Row>

          <Row
            label={brandText(BRAND.sourceTitle) || t("settings.about.source")}
            hint={brandText(BRAND.sourceHint) || t("settings.about.sourceHint")}
          >
            <Show when={SOURCE_URL}>
              <a
                href={SOURCE_URL}
                target="_blank"
                rel="noreferrer"
                class="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <Icon name="globe" class="size-3.5 shrink-0" />
                <span class="truncate">{brandText(BRAND.sourceLabel) || SOURCE_URL}</span>
              </a>
            </Show>
          </Row>
        </Card>
      </Group>
      <Group
        label={t("settings.about.diagnostics")}
        hint={
          t("settings.about.diagnosticsHint") +
          (inDesktopShell() ? "" : ` ${t("settings.about.desktopOnly")}`)
        }
      >
        <Card>
          <Row
            label={t("settings.about.log")}
            hint={t("settings.about.logHint")}
            note={diagLine("log")}
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!inDesktopShell()}
              onClick={() => void openLog()}
            >
              {t("settings.about.openLog")}
            </Button>
          </Row>
          <Row
            label={t("settings.about.report")}
            note={diagLine("report")}
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copyDiagnostics()}
            >
              {t("settings.about.copyDiagnostics")}
            </Button>
          </Row>
          {/* What the reader can act on, in the build they are holding: a
              packaged app notifies under its own name, and a missing banner is
              almost always the system permission. A dev build borrows the
              launching process's identity — build-time trivia that is not worth
              a row in the About pane. */}
          <Row
            label={t("settings.about.notifications")}
            hint={
              inDesktopShell()
                ? t("settings.about.notifyHint", { app: APP_NAME })
                : undefined
            }
            note={diagLine("notify")}
          >
            <div class="flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!inDesktopShell()}
                onClick={() => void testNotification()}
              >
                {t("settings.about.testNotification")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!inDesktopShell()}
                onClick={() => void openNotifySettings()}
              >
                {t("settings.about.notificationSettings")}
              </Button>
            </div>
          </Row>
        </Card>
      </Group>
      </Show>
      </div>
      </div>
    </div>
  );
}
