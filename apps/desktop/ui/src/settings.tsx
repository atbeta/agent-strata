import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  listTerminals,
  readOpencodeLaunch,
  saveOpencodeMode,
  type OpencodeLaunchMode,
  type OpencodeRuntime,
} from "./api";
import {
  checkOpencodeRuntime,
  chooseOpencodeBinary,
  openOpencodeLog,
  restartOpencode,
  setOpencodeBinary,
} from "./opencode-runtime";
import { copyText } from "./clipboard";
import { inDesktopShell } from "./shell";
import { readMru } from "./session-switch";
import {
  isShellAvailable,
  readTerminalShell,
  shellChoices,
  writeTerminalShell,
} from "./terminal-shell";
import { LOCALES, LOCALE_LABEL, locale, setLocale, t, type Locale } from "./i18n";
import { Icon } from "./icons";
import { readTheme, saveTheme, type ThemeChoice } from "./theme";
import {
  disableNotify,
  enableNotify,
  openNotificationSettings,
  readNotify,
  sendTestNotification,
} from "./notify";
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
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/choice-card";
import { RowButton } from "@/components/ui/row-button";
import { Switch } from "@/components/ui/switch";
import { TextFieldInput } from "@/components/ui/text-field";
import { Group, PillGroup, Row, Segmented } from "./settings-blocks";
import { BackendSettings } from "./backend-settings";
import type { ConnectionsCtl } from "./use-connections";
import { PolicyEditor } from "./policy";
import { ProviderSettings } from "./providers";
import { MaintenanceSettings } from "./maintenance";
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

/** Where a question about this build should end up. */
const SOURCE_URL = "https://github.com/atbeta/agent-strata";

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

/**
 * Which shell a new terminal opens with.
 *
 * The choices are the backend's, not PATH's: it is the backend that decides
 * what it will broker, and a binary it found but will not run is worse than one
 * it never mentioned. The list is read through the session you were last in,
 * because that is the only place a directory to ask about comes from — which is
 * also why the control is honest about having nothing to show before the first
 * session exists.
 *
 * A shell the backend has dropped is still shown, in its own name and in red.
 * Silently swapping it would report a preference the reader never chose.
 */
function TerminalShellPicker(props: { label: string; value: string; onChange: (name: string) => void }) {
  const [shells] = createResource(
    () => readMru()[0],
    async (sessionId) => (sessionId ? ((await listTerminals(sessionId)).shells ?? []) : []),
  );

  const available = () => shellChoices(shells() ?? []);
  const chosen = () => (props.value === "" ? t("terminal.shellBackend") : props.value);
  const missing = () => props.value !== "" && shells() !== undefined && !isShellAvailable(props.value, shells()!);

  return (
    <div class="w-full">
      <DropdownMenu>
        <DropdownMenuTrigger
          class="h-8 w-full justify-between gap-3 border border-border px-2.5 text-sm hover:bg-secondary/60"
          aria-label={props.label}
        >
          <span class={`truncate ${props.value ? "font-mono text-xs" : ""} ${missing() ? "text-destructive" : ""}`}>
            {chosen()}
          </span>
          <Icon name="chevron" class="size-3 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => props.onChange("")}>
            {t("terminal.shellBackend")}
          </DropdownMenuItem>
          <Show when={available().length > 0}>
            <DropdownMenuSeparator />
            <For each={available()}>
              {(shell) => (
                <DropdownMenuItem class="font-mono text-xs" onSelect={() => props.onChange(shell.name)}>
                  {shell.name}
                </DropdownMenuItem>
              )}
            </For>
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>
      <Show when={missing()}>
        <p class="mt-1.5 text-2xs leading-4 text-destructive">
          {t("settings.shell.missing", { name: props.value })}
        </p>
      </Show>
    </div>
  );
}

const CHOICES = (): { id: ThemeChoice; label: string }[] => [
  { id: "dark", label: t("settings.theme.dark") },
  { id: "light", label: t("settings.theme.light") },
  { id: "system", label: t("settings.theme.system") },
];

export function SettingsPage(props: { section?: string; conns: ConnectionsCtl }) {
  const section = () => settingsSection(props.section);
  const [choice, setChoice] = createSignal<ThemeChoice>(readTheme());
  const [launch, { refetch: refetchLaunch }] = createResource(readOpencodeLaunch);
  const [mode, setMode] = createSignal<OpencodeLaunchMode>("embed");
  const [runtime, setRuntime] = createSignal<OpencodeRuntime>();
  const [runtimeBusy, setRuntimeBusy] = createSignal(false);
  const [runtimeErr, setRuntimeErr] = createSignal("");
  const [runtimeNote, setRuntimeNote] = createSignal("");
  const [restartArmed, setRestartArmed] = createSignal(false);
  const [diagNote, setDiagNote] = createSignal("");
  const [diagErr, setDiagErr] = createSignal("");
  const [hydrated, setHydrated] = createSignal(false);
  const [saveErr, setSaveErr] = createSignal("");
  const [fonts, setFonts] = createSignal<FontChoice>(readFonts());
  const [thinkingOpen, setThinkingOpen] = createSignal(readThinkingOpen());
  const [notifyOn, setNotifyOn] = createSignal(readNotify());
  const [notifyErr, setNotifyErr] = createSignal("");
  const [shellDefault, setShellDefault] = createSignal(readTerminalShell());

  const patchFonts = (patch: Partial<FontChoice>) => {
    const next = { ...fonts(), ...patch };
    setFonts(next);
    saveFonts(next);
  };

  const launchData = () => (launch.error ? undefined : launch());
  const runtimeSource = () => {
    switch (runtime()?.source) {
      case "setting":
        return t("settings.opencode.sourceShort.setting");
      case "env":
        return t("settings.opencode.sourceShort.env");
      case "path":
        return t("settings.opencode.sourceShort.path");
      case "missing":
        return t("settings.opencode.sourceShort.missing");
      case "external":
        return t("settings.opencode.sourceShort.external");
      default:
        return "—";
    }
  };
  /** Running is the ordinary case: a green dot says it, no word needed. */
  const runtimeWord = () => {
    if (launchData()?.state === "running") return undefined;
    return runtimeState();
  };
  const runtimeTone = () => {
    switch (launchData()?.state) {
      case "running":
        return "bg-status-active";
      case "missing":
      case "stopped":
        return "bg-status-error";
      case "starting":
      case "restarting":
        return "bg-status-cancelled";
      default:
        return "bg-status-pending";
    }
  };
  const runtimeState = () => {
    switch (launchData()?.state) {
      case "starting":
        return t("settings.opencode.state.starting");
      case "running":
        return t("settings.opencode.state.running");
      case "missing":
        return t("settings.opencode.state.missing");
      case "restarting":
        return t("settings.opencode.state.restarting");
      case "stopped":
        return t("settings.opencode.state.stopped");
      case "external":
        return t("settings.opencode.state.external");
      case "unmanaged":
        return t("settings.opencode.state.unmanaged");
      default:
        return "—";
    }
  };
  /** A version this build was not tuned against is worth naming, not blocking. */
  const versionAhead = () => {
    const version = runtime()?.version;
    return Boolean(version && !version.includes("1.18."));
  };
  const checkRuntime = async () => {
    setRuntimeBusy(true);
    setRuntimeErr("");
    setRuntimeNote("");
    try {
      const report = await checkOpencodeRuntime();
      if (report) setRuntime(report);
      else setRuntimeErr(t("settings.opencode.desktopOnly"));
    } catch (e) {
      setRuntimeErr(e instanceof Error ? e.message : t("err.network"));
    } finally {
      setRuntimeBusy(false);
    }
  };
  const pickRuntime = async () => {
    setRuntimeErr("");
    setRuntimeNote("");
    try {
      const picked = await chooseOpencodeBinary(t("settings.opencode.chooseBin"));
      if (!picked) return;
      setRuntimeBusy(true);
      const report = await setOpencodeBinary(picked);
      if (report) {
        setRuntime(report);
        setRuntimeNote(t("settings.opencode.binSaved"));
      }
    } catch (e) {
      setRuntimeErr(e instanceof Error ? e.message : t("err.network"));
    } finally {
      setRuntimeBusy(false);
    }
  };
  const clearRuntime = async () => {
    setRuntimeBusy(true);
    setRuntimeErr("");
    setRuntimeNote("");
    try {
      const report = await setOpencodeBinary(null);
      if (report) {
        setRuntime(report);
        setRuntimeNote(t("settings.opencode.binCleared"));
      }
    } catch (e) {
      setRuntimeErr(e instanceof Error ? e.message : t("err.network"));
    } finally {
      setRuntimeBusy(false);
    }
  };
  const restartRuntime = async () => {
    setRuntimeBusy(true);
    setRuntimeErr("");
    setRuntimeNote("");
    setRestartArmed(false);
    try {
      await restartOpencode();
      // The supervisor reacts on its next five-second beat, then the new
      // server has to become healthy. Poll rather than claiming success.
      for (let i = 0; i < 30; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const next = await readOpencodeLaunch();
        if (next.state === "running") {
          setRuntime(next.runtime);
          await refetchLaunch();
          setRuntimeNote(t("settings.opencode.restarted"));
          return;
        }
        if (next.state === "missing" || next.state === "stopped") {
          throw new Error(t("settings.opencode.restartFailed"));
        }
      }
      setRuntimeNote(t("settings.opencode.restartSlow"));
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setRuntimeErr(
        message.includes("not being supervised")
          ? t("settings.opencode.restartFailed")
          : message || t("err.network"),
      );
    } finally {
      setRuntimeBusy(false);
    }
  };
  const armRestart = () => {
    if (!restartArmed()) {
      setRestartArmed(true);
      setTimeout(() => setRestartArmed(false), 4000);
      return;
    }
    setRestartArmed(false);
    void restartRuntime();
  };
  const testNotification = async () => {
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
    setDiagErr("");
    setDiagNote("");
    try {
      await openNotificationSettings();
    } catch (e) {
      setDiagErr(e instanceof Error ? e.message : t("err.network"));
    }
  };

  const openLog = async () => {
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

  const copyDiagnostics = async () => {
    const report = runtime();
    const lines = [
      `Agent Strata v${__APP_VERSION__}`,
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

  createEffect(() => {
    if (hydrated()) return;
    const data = launchData();
    if (data) {
      setMode(data.mode);
      setRuntime(data.runtime);
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
    <div class="flex w-full flex-col items-start gap-6 px-5 py-6 @min-[880px]/main:flex-row @min-[880px]/main:gap-10 @min-[880px]/main:px-8 @min-[880px]/main:py-10">
      <div class="w-full shrink-0 @min-[880px]/main:w-44">
        <nav class="flex gap-1 overflow-x-auto @min-[880px]/main:sticky @min-[880px]/main:top-0 @min-[880px]/main:block" role="tablist" aria-label={t("settings.title")}>
          <For each={SETTINGS_SECTIONS}>
            {(item) => (
              <RowButton
                role="tab"
                id={`settings-tab-${item.id}`}
                aria-selected={section() === item.id}
                aria-controls="settings-panel"
                class={`block w-auto shrink-0 whitespace-nowrap px-2.5 py-1.5 hover:bg-secondary/60 @min-[880px]/main:w-full ${
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
        <p class="hidden px-2.5 text-2xs leading-4 text-muted-foreground @min-[880px]/main:mt-3 @min-[880px]/main:block">
          {t("settings.savedHere")}
        </p>
      </div>

      <div class="w-full min-w-0 max-w-2xl flex-1">
        {/* The page's visible name is the caption bar's. This keeps the
            document outline intact without a second one on screen. */}
        <h1 class="sr-only">{t("settings.title")}</h1>

      <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${section()}`} class="[&>section:first-child]:mt-0">
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
            onChange={(next) => {
              if (next !== notifyOn()) void toggleNotify();
            }}
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

      <Show when={section() === "backends"}>
        <BackendSettings conns={props.conns} />
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
      </Group>

      {/* An external server brings its own binary; the app has nothing here to
          find, check or restart. Keyed on the chosen mode rather than the
          running one, so picking 内嵌 shows where its binary will come from.
          `mode` reads "embed" until the saved choice arrives; waiting for it
          keeps an external setup from flashing the block on open. */}
      <Show when={hydrated() && mode() !== "external"}>
      <Group label={t("settings.opencode.runtime")}>
        <div class="mt-3 rounded-lg border border-border px-3 py-2.5">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span aria-hidden="true" class={`size-1.5 shrink-0 rounded-full ${runtimeTone()}`} />
            <span class="text-sm font-medium">OpenCode</span>
            <Show when={runtime()?.version}>
              <span class="font-mono text-2xs text-muted-foreground">{runtime()?.version}</span>
            </Show>
            <Show when={runtime()?.source}>
              <span class="rounded bg-secondary/60 px-1 py-0.5 text-2xs text-muted-foreground">
                {runtimeSource()}
              </span>
            </Show>
            <Show when={runtimeWord()}>
              <span class="text-2xs text-muted-foreground">{runtimeWord()}</span>
            </Show>
            <span class="ml-auto flex flex-wrap items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant="quiet"
                disabled={runtimeBusy() || !inDesktopShell()}
                onClick={() => void pickRuntime()}
              >
                {t("settings.opencode.chooseBin")}
              </Button>
              <Button
                type="button"
                size="xs"
                variant="quiet"
                disabled={runtimeBusy() || !inDesktopShell()}
                onClick={() => void checkRuntime()}
              >
                {t("settings.opencode.check")}
              </Button>
              <Show when={launchData()?.mode === "embed" && launchData()?.state !== "external"}>
                <Button
                  type="button"
                  size="xs"
                  variant="quiet"
                  disabled={runtimeBusy() || !inDesktopShell()}
                  title={t("settings.opencode.restartHint")}
                  onClick={armRestart}
                >
                  {restartArmed()
                    ? t("settings.opencode.restartConfirm")
                    : t("settings.opencode.restart")}
                </Button>
              </Show>
              <Show when={runtime()?.source === "setting"}>
                <Button
                  type="button"
                  size="xs"
                  variant="quiet"
                  disabled={runtimeBusy() || !inDesktopShell()}
                  onClick={() => void clearRuntime()}
                >
                  {t("settings.opencode.clearBin")}
                </Button>
              </Show>
            </span>
          </div>
          <Show
            when={runtime()?.source === "external"}
            fallback={
              <p
                class="mt-1.5 truncate font-mono text-2xs text-muted-foreground"
                title={runtime()?.bin ?? ""}
              >
                {runtime()?.bin ?? (runtime() ? t("settings.opencode.binMissing") : "—")}
              </p>
            }
          >
            <p class="mt-1.5 text-2xs text-muted-foreground">
              {t("settings.opencode.externalPath")}
            </p>
          </Show>
          <Show
            when={
              !inDesktopShell() ||
              runtime()?.source === "env" ||
              runtimeErr() ||
              runtimeNote() ||
              runtime()?.error
            }
          >
            <div class="mt-1.5 space-y-1">
              <Show when={!inDesktopShell()}>
                <p class="text-2xs leading-4 text-muted-foreground">
                  {t("settings.opencode.desktopOnly")}
                </p>
              </Show>
              <Show when={runtime()?.source === "env"}>
                <p class="text-2xs leading-4 text-muted-foreground">
                  {t("settings.opencode.envHint")}
                </p>
              </Show>
              <Show when={runtimeErr()}>
                <p class="text-sm text-destructive">{runtimeErr()}</p>
              </Show>
              <Show when={runtimeNote()}>
                <p class="text-sm text-muted-foreground">{runtimeNote()}</p>
              </Show>
              <Show when={runtime()?.error}>
                <p class="text-sm text-destructive">{runtime()?.error}</p>
              </Show>
              <Show when={launchData()?.state === "missing"}>
                <p class="text-sm text-muted-foreground">
                  {t("settings.opencode.missing")}{" "}
                  <a
                    href="https://opencode.ai"
                    target="_blank"
                    rel="noreferrer"
                    class="text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                  >
                    {t("settings.opencode.install")}
                  </a>
                </p>
              </Show>
            </div>
          </Show>
          <Show when={versionAhead()}>
            <p class="mt-1.5 text-2xs leading-4 text-muted-foreground">
              {t("settings.opencode.versionHint")}
            </p>
          </Show>
        </div>
        <p class="mt-2 text-2xs leading-4 text-muted-foreground">
          {t("settings.opencode.runtimeHint")}
        </p>
      </Group>
      </Show>

      {/* Terminals are an opencode capability — the ACP adapter reports
          `terminal: false` — so this sits with the rest of what only that backend
          offers rather than pretending every session can open one. */}
      <Group label={t("settings.shell.group")}>
        <section class="divide-y divide-border">
          <Row label={t("settings.shell.title")} hint={t("settings.shell.hint")}>
            <TerminalShellPicker
              label={t("settings.shell.title")}
              value={shellDefault()}
              onChange={(name) => {
                setShellDefault(name);
                writeTerminalShell(name);
              }}
            />
          </Row>
        </section>
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
            <div class="text-sm font-medium">Agent Strata</div>
            <p class="mt-0.5 text-2xs leading-4 text-muted-foreground">
              {t("settings.about.tagline")}
            </p>
          </div>
        </div>

        <div class="mt-5 divide-y divide-border">
          {/* Mono because this is a build identifier, read against the tag
              list — not a sentence. */}
          <Row label={t("settings.about.version")} controlClass="w-40">
            <span class="font-mono text-sm text-muted-foreground">v{__APP_VERSION__}</span>
          </Row>

          <Row
            label={t("settings.about.source")}
            hint={t("settings.about.sourceHint")}
            controlClass="w-40"
          >
            <a
              href={SOURCE_URL}
              target="_blank"
              rel="noreferrer"
              class="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <Icon name="globe" class="size-3.5 shrink-0" />
              <span class="truncate">atbeta/agent-strata</span>
            </a>
          </Row>
        </div>
      </Group>
      <Group label={t("settings.about.diagnostics")}>
        <p class="text-2xs leading-4 text-muted-foreground">
          {t("settings.about.diagnosticsHint")}
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!inDesktopShell()}
            onClick={() => void openLog()}
          >
            {t("settings.about.openLog")}
          </Button>
          <Button type="button" size="sm" variant="quiet" onClick={() => void copyDiagnostics()}>
            {t("settings.about.copyDiagnostics")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="quiet"
            disabled={!inDesktopShell()}
            onClick={() => void testNotification()}
          >
            {t("settings.about.testNotification")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="quiet"
            disabled={!inDesktopShell()}
            onClick={() => void openNotifySettings()}
          >
            {t("settings.about.notificationSettings")}
          </Button>
        </div>
        <Show when={diagNote()}>
          <p class="mt-2 text-2xs text-muted-foreground">{diagNote()}</p>
        </Show>
        <Show when={diagErr()}>
          <p class="mt-2 text-2xs text-destructive">{diagErr()}</p>
        </Show>
        <Show when={!inDesktopShell()}>
          <p class="mt-2 text-2xs leading-4 text-muted-foreground">
            {t("settings.about.desktopOnly")}
          </p>
        </Show>
        <p class="mt-2 text-2xs leading-4 text-muted-foreground">{t("settings.about.logHint")}</p>
        {/* Only a dev shell borrows Terminal's notification identity; a packaged
            build has its own, so the caveat would only mislead there. */}
        <Show when={import.meta.env.DEV}>
          <p class="mt-1 text-2xs leading-4 text-muted-foreground">{t("settings.about.notifyHint")}</p>
        </Show>
      </Group>
      </Show>
      </div>
      </div>
    </div>
  );
}
