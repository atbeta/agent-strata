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
import { LOCALES, LOCALE_LABEL, locale, setLocale, stamp, t, type Locale } from "./i18n";
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
import { RowButton } from "@/components/ui/row-button";
import { Switch } from "@/components/ui/switch";
import { TextFieldInput } from "@/components/ui/text-field";
import { Card, Group, PillGroup, Row, Segmented } from "./settings-blocks";
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
  return ch.codePointAt(0)! >= 255 ? 2 : 1;
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
  const [diagKey, setDiagKey] = createSignal("");
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
      </div>

      <div class="w-full min-w-0 max-w-2xl flex-1">
        {/* The page's visible name is the caption bar's. This keeps the
            document outline intact without a second one on screen. */}
        <h1 class="sr-only">{t("settings.title")}</h1>

      <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${section()}`} class="[&>section:first-child]:mt-0">
      <Show when={section() === "interface"}>
      <Group label={t("settings.appearance")}>
        <Card>
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
        </Card>
      </Group>

      {/* Language and notification are preferences, not a category each: they
          share one list so the page reads as a page instead of a stack of
          equally loud blocks. */}
      <Group label={t("settings.general")}>
      <Card>
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

        <Row
          label={t("settings.notify.title")}
          hint={t("settings.notify.hint")}
          note={
            <Show when={notifyErr()}>
              <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-destructive">
                <Icon name="alert" class="size-3 shrink-0" />
                {notifyErr()}
              </p>
            </Show>
          }
        >
          <Switch
            checked={notifyOn()}
            aria-label={t("settings.notify.title")}
            onChange={(next) => {
              if (next !== notifyOn()) void toggleNotify();
            }}
          />
        </Row>
      </Card>
      </Group>

      <Group label={t("settings.font.title")} hint={t("settings.font.hint")}>
        <Card>
          {/* Both families have to appear here. A preview that only shows the code
              font leaves the interface-font row looking like it did nothing, which
              is the same doubt the picker itself has to answer. It pins while the
              rows beneath scroll past, on the card's own surface. */}
          <div class="sticky top-0 z-10 rounded-t-lg bg-card py-3">
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
        </Card>
      </Group>
      </Show>

      <Show when={section() === "backends"}>
        <BackendSettings conns={props.conns} />
      </Show>

      <Show when={section() === "opencode"}>
      <Group label={t("settings.opencode.title")} hint={t("settings.opencode.runtimeHint")}>
      <Card>
        <Row
          label={t("settings.opencode.mode")}
          hint={t("settings.opencode.modeHint", {
            desc: (OPENCODE_MODES().find((m) => m.id === mode())?.hint ?? "").replace(
              /[.。]\s*$/,
              "",
            ),
            apply: t("settings.opencode.apply"),
          })}
          controlClass="w-auto"
          note={
            <Show when={saveErr()}>
              <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-destructive">
                <Icon name="alert" class="size-3 shrink-0" />
                {saveErr()}
              </p>
            </Show>
          }
        >
          <Segmented
            label={t("settings.opencode.mode")}
            value={mode()}
            onChange={(id) => void pickMode(id as OpencodeLaunchMode)}
            options={OPENCODE_MODES().map((item) => ({ id: item.id, label: item.label }))}
          />
        </Row>

        {/* An external server brings its own binary; the app has nothing here
            to find, check or restart. Keyed on the chosen mode rather than the
            running one, so picking 内嵌 shows where its binary will come from.
            `mode` reads "embed" until the saved choice arrives; waiting for it
            keeps an external setup from flashing the rows on open. */}
        <Show when={hydrated() && mode() !== "external"}>
          {/* Doctor's verdict sits next to the binary it belongs to — this is
              the "is my setup okay" line, not a status page. */}
          <Row
            label={t("settings.opencode.bin")}
            hint={`${t("settings.opencode.source")}: ${runtimeSource()} · ${t("settings.opencode.version")}: ${runtime()?.version ?? "—"} · ${t("settings.opencode.checkedAt", { at: runtime()?.checked_at ? stamp(runtime()!.checked_at! * 1000) : "—" })}`}
            controlClass="w-auto"
            note={
              <>
                <Show
                  when={runtime()?.source === "external"}
                  fallback={
                    <p
                      class="mt-1.5 max-w-full truncate font-mono text-2xs text-muted-foreground"
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
                <Show when={!inDesktopShell()}>
                  <p class="mt-1.5 flex items-center gap-1.5 text-2xs leading-4 text-muted-foreground">
                    {t("settings.opencode.desktopOnly")}
                  </p>
                </Show>
                <Show when={runtime()?.source === "env"}>
                  <p class="mt-1.5 text-2xs leading-4 text-muted-foreground">
                    {t("settings.opencode.envHint")}
                  </p>
                </Show>
                <Show when={versionAhead()}>
                  <p class="mt-1.5 text-2xs leading-4 text-muted-foreground">
                    {t("settings.opencode.versionHint")}
                  </p>
                </Show>
                <Show when={runtimeErr()}>
                  <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-destructive">
                    <Icon name="alert" class="size-3 shrink-0" />
                    {runtimeErr()}
                  </p>
                </Show>
                <Show when={runtime()?.error}>
                  <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-destructive">
                    <Icon name="alert" class="size-3 shrink-0" />
                    {runtime()?.error}
                  </p>
                </Show>
              </>
            }
          >
            <div class="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={runtimeBusy() || !inDesktopShell()}
                onClick={() => void pickRuntime()}
              >
                {t("settings.opencode.chooseBin")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={runtimeBusy() || !inDesktopShell()}
                onClick={() => void checkRuntime()}
              >
                {t("settings.opencode.check")}
              </Button>
              <Show when={runtime()?.source === "setting"}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={runtimeBusy() || !inDesktopShell()}
                  onClick={() => void clearRuntime()}
                >
                  {t("settings.opencode.clearBin")}
                </Button>
              </Show>
            </div>
          </Row>

          <Row
            label={t("settings.opencode.state")}
            controlClass="w-auto"
            note={
              <>
                <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                  <span aria-hidden="true" class={`size-1.5 shrink-0 rounded-full ${runtimeTone()}`} />
                  {runtimeState()}
                </p>
                <Show when={runtimeNote()}>
                  <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                    <Icon name="check" class="size-3 shrink-0" />
                    {runtimeNote()}
                  </p>
                </Show>
                <Show when={launchData()?.state === "missing"}>
                  <p class="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                    <Icon name="alert" class="size-3 shrink-0" />
                    {t("settings.opencode.missing")}{" "}
                    <a
                      href="https://opencode.ai"
                      target="_blank"
                      rel="noreferrer"
                      class="underline decoration-border underline-offset-2 hover:text-foreground"
                    >
                      {t("settings.opencode.install")}
                    </a>
                  </p>
                </Show>
              </>
            }
          >
            <Show when={launchData()?.mode === "embed" && launchData()?.state !== "external"}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={runtimeBusy() || !inDesktopShell()}
                title={restartArmed() ? undefined : t("settings.opencode.restartHint")}
                onClick={armRestart}
              >
                {restartArmed()
                  ? t("settings.opencode.restartConfirm")
                  : t("settings.opencode.restart")}
              </Button>
            </Show>
          </Row>
        </Show>
      </Card>

      {/* Terminals are an opencode capability — the ACP adapter reports
          `terminal: false` — so this sits with the rest of what only that backend
          offers rather than pretending every session can open one. */}
      <Group label={t("settings.shell.group")}>
        <Card>
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
        </Card>
      </Group>

      </Group>

      <ProviderSettings />
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
            <div class="text-sm font-medium">Agent Strata</div>
            <p class="mt-0.5 text-2xs leading-4 text-muted-foreground">
              {t("settings.about.tagline")}
            </p>
          </div>
        </div>

        <Card class="mt-5">
          {/* Sans tabular — a number read as a number; the link next row is
              the one that truncates. */}
          <Row label={t("settings.about.version")} controlClass="w-40">
            <span class="text-sm tabular-nums text-foreground">v{__APP_VERSION__}</span>
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
            controlClass="w-auto"
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
            controlClass="w-auto"
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
          {/* Only a dev shell borrows Terminal's notification identity; a
              packaged build has its own, so the caveat would only mislead there. */}
          <Row
            label={t("settings.about.notifications")}
            hint={import.meta.env.DEV ? t("settings.about.notifyHint") : undefined}
            controlClass="w-auto"
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
