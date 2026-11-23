import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import { RangeField } from "@/components/ui/range-field";
import { TextFieldInput } from "@/components/ui/text-field";
import {
  setPluginLifecycle,
  setPluginSettings,
  type PluginLifecycleAction,
  type PluginSummary,
} from "./api";
import { explain, fadeKeyed } from "./errors";
import { num, t, type MessageKey } from "./i18n";
import { Icon } from "./icons";
import {
  pluginDisplayDescription,
  pluginDisplayIcon,
  pluginDisplayName,
  pluginDisplaySummary,
  pluginSettingDescription,
  pluginSettingTitle,
  pluginSettingValueLabel,
} from "./plugin-display";
import {
  pluginSummaries,
  pluginsLoaded,
  pluginsReadFailed,
  refreshPlugins,
} from "./plugin-registry";
import { PluginSettingsComponent } from "./plugin-settings-registry";
import { handleRovingKey } from "./roving-key";
import { Card, Group, Row, Segmented } from "./settings-blocks";

const STATE_KEYS: Record<PluginSummary["state"], MessageKey> = {
  disabled: "settings.plugins.state.disabled",
  starting: "settings.plugins.state.starting",
  running: "settings.plugins.state.running",
  stopping: "settings.plugins.state.stopping",
  failed: "settings.plugins.state.failed",
};

const STATE_TONES: Record<PluginSummary["state"], string> = {
  disabled: "bg-muted-foreground/40",
  starting: "bg-amber-500",
  running: "bg-emerald-500",
  stopping: "bg-amber-500",
  failed: "bg-destructive",
};

const UNDO_MS = 10_000;
type DetailTab = "settings" | "capabilities" | "about";

export function PluginSettings(props: { pluginId?: string }) {
  const [busyId, setBusyId] = createSignal("");
  const [feedback, setFeedback] = fadeKeyed();
  const [savedFeedback, setSavedFeedback] = fadeKeyed();
  const [confirming, setConfirming] = createSignal("");
  const [draft, setDraft] = createSignal<Record<string, Record<string, string>>>({});
  const [savingId, setSavingId] = createSignal("");
  const [detailTab, setDetailTab] = createSignal<DetailTab>("capabilities");
  const [justDisabled, setJustDisabled] = createSignal<Record<string, boolean>>({});
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const undoTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const selected = () => pluginSummaries().find((plugin) => plugin.id === props.pluginId);
  const hasSettings = (plugin: PluginSummary) => Boolean(plugin.settings || plugin.ui?.settings?.component);
  const settingValue = (plugin: PluginSummary, key: string): unknown =>
    draft()[plugin.id]?.[key] ?? plugin.settings?.values[key];

  let detailPluginId = "";
  createEffect(() => {
    const plugin = selected();
    if (!plugin || plugin.id === detailPluginId) return;
    detailPluginId = plugin.id;
    setDetailTab(hasSettings(plugin) ? "settings" : "capabilities");
  });

  const setSetting = (plugin: PluginSummary, key: string, value: string) => {
    setDraft((current) => ({
      ...current,
      [plugin.id]: { ...current[plugin.id], [key]: value },
    }));
  };

  const discardSettings = (plugin: PluginSummary) => {
    setDraft((current) => {
      const next = { ...current };
      delete next[plugin.id];
      return next;
    });
    setFeedback(plugin.id, "");
    setSavedFeedback(plugin.id, "");
  };

  const saveSettings = async (plugin: PluginSummary) => {
    const draftValues = draft()[plugin.id];
    if (!draftValues) return;
    const properties = plugin.settings?.schema.properties ?? {};
    const values: Record<string, unknown> = {};
    for (const [key, text] of Object.entries(draftValues)) {
      const setting = properties[key];
      if (!setting) continue;
      if (setting.type === "boolean") {
        values[key] = text === "true";
        continue;
      }
      if (setting.type !== "number") {
        values[key] = text;
        continue;
      }
      if (text.trim() === "") {
        if (setting.default !== undefined) values[key] = setting.default;
        continue;
      }
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        setFeedback(plugin.id, t("settings.plugins.settings.notANumber", { value: text }));
        return;
      }
      values[key] = parsed;
    }
    const restarting = plugin.state === "running" || plugin.state === "starting";
    setSavingId(plugin.id);
    setFeedback(plugin.id, "");
    setSavedFeedback(plugin.id, "");
    try {
      await setPluginSettings(plugin.id, values);
      discardSettings(plugin);
      await refreshPlugins();
      setSavedFeedback(
        plugin.id,
        t(restarting ? "settings.plugins.settings.savedRestarted" : "settings.plugins.settings.saved"),
      );
    } catch (error) {
      setFeedback(plugin.id, explain(error));
    } finally {
      setSavingId("");
    }
  };

  const markJustDisabled = (id: string, on: boolean) => {
    clearTimeout(undoTimers.get(id));
    undoTimers.delete(id);
    setJustDisabled((current) => {
      if (Boolean(current[id]) === on) return current;
      const next = { ...current };
      if (on) next[id] = true;
      else delete next[id];
      return next;
    });
    if (on) undoTimers.set(id, setTimeout(() => markJustDisabled(id, false), UNDO_MS));
  };

  onMount(() => void refreshPlugins());
  onCleanup(() => {
    clearTimeout(confirmTimer);
    for (const timer of undoTimers.values()) clearTimeout(timer);
    undoTimers.clear();
  });

  const run = async (id: string, action: PluginLifecycleAction) => {
    setBusyId(id);
    setConfirming("");
    clearTimeout(confirmTimer);
    setFeedback(id, "");
    markJustDisabled(id, false);
    try {
      await setPluginLifecycle(id, action);
      await refreshPlugins();
      if (action === "disable") markJustDisabled(id, true);
    } catch (error) {
      setFeedback(id, explain(error));
    } finally {
      setBusyId("");
    }
  };

  const request = (plugin: PluginSummary, action: PluginLifecycleAction) => {
    if (action !== "restart") {
      void run(plugin.id, action);
      return;
    }
    const key = `${plugin.id}:${action}`;
    if (confirming() !== key) {
      setConfirming(key);
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => setConfirming(""), 5000);
      return;
    }
    void run(plugin.id, action);
  };

  const hookSummary = (plugin: PluginSummary) => {
    const items = [
      ...(plugin.hooks?.beforeTool.length
        ? [`${t("settings.plugins.beforeTool")} (${num(plugin.hooks.beforeTool.length)})`]
        : []),
      ...(plugin.hooks?.systemPrompt ? [t("settings.plugins.systemPrompt")] : []),
    ];
    return items.length ? items.join(" · ") : t("settings.plugins.none");
  };

  const openPlugin = (id: string) => {
    location.hash = `/settings/plugins/${encodeURIComponent(id)}`;
  };

  const messages = (plugin: PluginSummary) => (
    <>
      <Show when={plugin.error}>
        <p class="mt-2 whitespace-pre-wrap break-words text-2xs leading-4 text-destructive">
          {plugin.error}
        </p>
      </Show>
      <Show when={feedback()[plugin.id]}>
        <p class="mt-2 text-2xs leading-4 text-destructive">{feedback()[plugin.id]}</p>
      </Show>
      <Show when={justDisabled()[plugin.id] && plugin.state === "disabled"}>
        <div class="mt-2 flex items-center gap-2 text-2xs leading-4 text-muted-foreground">
          <span>{t("settings.plugins.justDisabled")}</span>
          <Button
            type="button"
            variant="link"
            size="xs"
            class="text-2xs"
            disabled={busyId() === plugin.id || plugin.state === "starting" || plugin.state === "stopping"}
            onClick={() => request(plugin, "enable")}
          >
            {t("settings.plugins.undo")}
          </Button>
        </div>
      </Show>
    </>
  );

  return (
    <Group label={t("settings.section.plugins")} hint={t("settings.plugins.hint")}>
      <Show
        when={!pluginsReadFailed()}
        fallback={
          <EmptyState
            icon="plug"
            tone="danger"
            layout="inline"
            title={t("settings.plugins.loadFailed")}
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => void refreshPlugins()}>
                {t("settings.plugins.retry")}
              </Button>
            }
          />
        }
      >
        <Show
          when={pluginsLoaded()}
          fallback={
            <Card>
              <p class="py-3 text-sm text-muted-foreground">{t("settings.plugins.loading")}</p>
            </Card>
          }
        >
          <Show
            when={pluginSummaries().length > 0}
            fallback={<EmptyState icon="plug" layout="inline" title={t("settings.plugins.empty")} />}
          >
            <div class="grid items-start gap-5 @min-[1100px]/main:grid-cols-[22rem_minmax(0,1fr)] @min-[1100px]/main:gap-6">
              <nav
                aria-label={t("settings.plugins.list")}
                class={`flex flex-col gap-1 ${props.pluginId ? "hidden @min-[1100px]/main:flex" : ""}`}
              >
                <For each={pluginSummaries()}>
                  {(plugin) => {
                    const name = () => pluginDisplayName(plugin.id, plugin.name);
                    const busy = () => busyId() === plugin.id;
                    const transitional = () => plugin.state === "starting" || plugin.state === "stopping";
                    return (
                      <div>
                        <div
                          class={`flex items-center gap-2 rounded-lg border p-2.5 transition-colors ${
                            props.pluginId === plugin.id
                              ? "border-ring/30 bg-accent/60"
                              : "border-transparent hover:bg-secondary/50"
                          }`}
                        >
                          <Button
                            type="button"
                            variant="quiet"
                            aria-current={props.pluginId === plugin.id ? "true" : undefined}
                            class="h-auto min-w-0 flex-1 items-center justify-start gap-3 whitespace-normal p-0 text-left"
                            onClick={() => openPlugin(plugin.id)}
                          >
                            <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary/70 text-muted-foreground">
                              <Icon name={pluginDisplayIcon(plugin.id, plugin.icon)} class="size-4" />
                            </span>
                            <span class="min-w-0 flex-1">
                              <span class="flex items-center gap-1.5">
                                <span class="truncate text-sm font-medium text-foreground">{name()}</span>
                                <span
                                  class={`size-1.5 shrink-0 rounded-full ${STATE_TONES[plugin.state]}`}
                                  title={t(STATE_KEYS[plugin.state])}
                                />
                                <span class="sr-only">{t(STATE_KEYS[plugin.state])}</span>
                              </span>
                              <span
                                class="mt-0.5 block truncate text-2xs leading-4 text-muted-foreground"
                                title={pluginDisplaySummary(plugin.id, plugin.summary ?? plugin.description)}
                              >
                                {pluginDisplaySummary(plugin.id, plugin.summary ?? plugin.description)}
                              </span>
                            </span>
                          </Button>
                          <Switch
                            checked={plugin.state !== "disabled"}
                            disabled={busy() || transitional()}
                            aria-label={t(
                              plugin.state === "disabled" ? "settings.plugins.enable" : "settings.plugins.disable",
                              { name: name() },
                            )}
                            onChange={(next) => request(plugin, next ? "enable" : "disable")}
                          />
                        </div>
                        <div class="px-2.5 @min-[1100px]/main:hidden">{messages(plugin)}</div>
                      </div>
                    );
                  }}
                </For>
              </nav>

              <Show
                when={props.pluginId}
                fallback={
                  <div class="hidden min-h-64 items-center justify-center rounded-xl border border-dashed border-border @min-[1100px]/main:flex">
                    <EmptyState
                      icon="plug"
                      title={t("settings.plugins.select")}
                      description={t("settings.plugins.selectHint")}
                    />
                  </div>
                }
              >
                <Show
                  when={selected()?.id}
                  keyed
                  fallback={
                    <EmptyState
                      icon="plug"
                      layout="inline"
                      title={t("settings.plugins.notFound")}
                      description={t("settings.plugins.notFoundHint")}
                      action={
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => { location.hash = "/settings/plugins"; }}
                        >
                          {t("settings.plugins.back")}
                        </Button>
                      }
                    />
                  }
                >
                  {(id) => {
                    const plugin = () => selected()!;
                    const name = () => pluginDisplayName(plugin().id, plugin().name);
                    const busy = () => busyId() === plugin().id;
                    const transitional = () => plugin().state === "starting" || plugin().state === "stopping";
                    const restartConfirming = () => confirming() === `${plugin().id}:restart`;
                    return (
                      <section data-plugin-detail={id} class="min-w-0">
                        <Button
                          type="button"
                          size="sm"
                          variant="quiet"
                          class="-ml-2 mb-4 @min-[1100px]/main:hidden"
                          onClick={() => { location.hash = "/settings/plugins"; }}
                        >
                          <Icon name="arrow-left" class="size-3.5" />
                          {t("settings.plugins.back")}
                        </Button>

                        <header class="flex items-start gap-3.5">
                          <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary/70 text-foreground/80">
                            <Icon name={pluginDisplayIcon(plugin().id, plugin().icon)} class="size-5" />
                          </span>
                          <div class="min-w-0 flex-1">
                            <div class="flex items-start justify-between gap-4">
                              <div class="min-w-0">
                                <h3 class="truncate text-lg font-semibold tracking-tight text-foreground">{name()}</h3>
                                <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
                                  <span class="font-mono">v{plugin().version}</span>
                                  <span aria-hidden="true">·</span>
                                  <span class="flex items-center gap-1.5">
                                    <span class={`size-1.5 rounded-full ${STATE_TONES[plugin().state]}`} />
                                    {t(STATE_KEYS[plugin().state])}
                                  </span>
                                </div>
                              </div>
                              <Switch
                                checked={plugin().state !== "disabled"}
                                disabled={busy() || transitional()}
                                aria-label={t(
                                  plugin().state === "disabled" ? "settings.plugins.enable" : "settings.plugins.disable",
                                  { name: name() },
                                )}
                                onChange={(next) => request(plugin(), next ? "enable" : "disable")}
                              />
                            </div>
                            <Show when={pluginDisplayDescription(plugin().id, plugin().description)}>
                              <p class="mt-3 max-w-2xl text-xs leading-5 text-muted-foreground">
                                {pluginDisplayDescription(plugin().id, plugin().description)}
                              </p>
                            </Show>
                          </div>
                        </header>

                        {messages(plugin())}

                        <DetailTabs
                          value={detailTab()}
                          settings={hasSettings(plugin())}
                          onChange={setDetailTab}
                        />

                        <div id="plugin-detail-panel" role="tabpanel" class="mt-5">
                          <Show when={detailTab() === "settings"}>
                            <Show when={plugin().ui?.settings?.component}>
                              <PluginSettingsComponent
                                name={plugin().ui!.settings!.component}
                                disabled={plugin().state !== "running"}
                                onEnable={() => request(plugin(), "enable")}
                                onChanged={refreshPlugins}
                              />
                            </Show>
                            <Show when={plugin().settings}>
                              <div class={plugin().ui?.settings?.component ? "mt-6" : ""}>
                                <Show when={plugin().ui?.settings?.component}>
                                  <h4 class="mb-2 text-xs font-medium text-foreground">
                                    {t("settings.plugins.settings")}
                                  </h4>
                                </Show>
                                <Card>
                                  <For each={Object.entries(plugin().settings!.schema.properties)}>
                                    {([key, setting]) => (
                                      <Row
                                        label={pluginSettingTitle(plugin().id, key, setting.title ?? key)}
                                        hint={setting.description
                                          ? pluginSettingDescription(plugin().id, key, setting.description)
                                          : undefined}
                                      >
                                        <Show when={setting.type === "boolean"}>
                                          <Switch
                                            checked={String(settingValue(plugin(), key)) === "true"}
                                            aria-label={pluginSettingTitle(plugin().id, key, key)}
                                            onChange={(next) => setSetting(plugin(), key, next ? "true" : "false")}
                                          />
                                        </Show>
                                        <Show when={setting.type === "enum"}>
                                          <Segmented
                                            label={pluginSettingTitle(plugin().id, key, key)}
                                            value={String(settingValue(plugin(), key) ?? "")}
                                            options={(setting.enum ?? []).map((value) => ({
                                              id: value,
                                              label: pluginSettingValueLabel(plugin().id, key, value),
                                            }))}
                                            onChange={(value) => setSetting(plugin(), key, value)}
                                          />
                                        </Show>
                                        <Show when={setting.type === "string" || setting.type === "number"}>
                                          <Show
                                            when={
                                              setting.type === "number" &&
                                              setting.minimum !== undefined &&
                                              setting.maximum !== undefined
                                            }
                                            fallback={
                                              <TextFieldInput
                                                type="text"
                                                inputmode={setting.type === "number" ? "numeric" : undefined}
                                                value={String(settingValue(plugin(), key) ?? "")}
                                                onInput={(e) => setSetting(plugin(), key, e.currentTarget.value)}
                                              />
                                            }
                                          >
                                            <div class="flex h-8 w-full items-center gap-3">
                                              <RangeField
                                                min={setting.minimum}
                                                max={setting.maximum}
                                                step={setting.step ?? 1}
                                                value={String(settingValue(plugin(), key) ?? "")}
                                                aria-label={pluginSettingTitle(plugin().id, key, key)}
                                                onInput={(e) => setSetting(plugin(), key, e.currentTarget.value)}
                                              />
                                              <span class="w-14 shrink-0 text-right text-2xs text-muted-foreground">
                                                {String(settingValue(plugin(), key) ?? "")}{setting.unit}
                                              </span>
                                            </div>
                                          </Show>
                                        </Show>
                                      </Row>
                                    )}
                                  </For>
                                </Card>
                                <Show when={draft()[plugin().id] || savedFeedback()[plugin().id]}>
                                  <div class="sticky bottom-0 z-10 -mx-1 mt-3 flex justify-end gap-2 border-t border-border bg-background/95 px-1 py-3 backdrop-blur">
                                    <Show
                                      when={draft()[plugin().id]}
                                      fallback={
                                        <p role="status" class="flex items-center gap-1.5 text-xs text-emerald-500">
                                          <Icon name="check" class="size-3.5" />
                                          {savedFeedback()[plugin().id]}
                                        </p>
                                      }
                                    >
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="quiet"
                                        disabled={savingId() === plugin().id}
                                        onClick={() => discardSettings(plugin())}
                                      >
                                        {t("confirm.cancel")}
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        disabled={savingId() === plugin().id}
                                        aria-busy={savingId() === plugin().id}
                                        onClick={() => void saveSettings(plugin())}
                                      >
                                        {savingId() === plugin().id
                                          ? t("settings.plugins.settings.saving")
                                          : plugin().state === "running" || plugin().state === "starting"
                                            ? t("settings.plugins.settings.save")
                                            : t("settings.plugins.settings.saveOnly")}
                                      </Button>
                                    </Show>
                                  </div>
                                </Show>
                              </div>
                            </Show>
                          </Show>

                          <Show when={detailTab() === "capabilities"}>
                            <dl class="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-4 rounded-lg border border-border bg-card p-4 text-xs">
                              <dt class="text-muted-foreground">{t("settings.plugins.tools")}</dt>
                              <dd>
                                <Show when={plugin().tools.length > 0} fallback={t("settings.plugins.none")}>
                                  <div class="flex flex-wrap gap-1.5">
                                    <For each={plugin().tools}>
                                      {(tool) => (
                                        <code class="rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-2xs">
                                          {plugin().id}_{tool.name}
                                        </code>
                                      )}
                                    </For>
                                  </div>
                                </Show>
                              </dd>
                              <dt class="text-muted-foreground">{t("settings.plugins.resources")}</dt>
                              <dd class="break-words font-mono text-2xs leading-5">
                                {plugin().resources.length
                                  ? plugin().resources.map((resource) => resource.key).join(", ")
                                  : t("settings.plugins.none")}
                              </dd>
                              <dt class="text-muted-foreground">{t("settings.plugins.panel")}</dt>
                              <dd>
                                {plugin().panel
                                  ? `${pluginDisplayName(plugin().id, plugin().panel!.title)} (${plugin().panel!.kind})`
                                  : t("settings.plugins.none")}
                              </dd>
                              <dt class="text-muted-foreground">{t("settings.plugins.hooks")}</dt>
                              <dd>{hookSummary(plugin())}</dd>
                            </dl>
                          </Show>

                          <Show when={detailTab() === "about"}>
                            <dl class="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-lg border border-border bg-card p-4 text-xs">
                              <dt class="text-muted-foreground">{t("settings.plugins.id")}</dt>
                              <dd><code class="font-mono text-2xs">{plugin().id}</code></dd>
                              <dt class="text-muted-foreground">{t("settings.plugins.version")}</dt>
                              <dd class="font-mono text-2xs">{plugin().version}</dd>
                            </dl>
                            <Show when={plugin().state !== "disabled"}>
                              <div class="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-card p-4 @min-[560px]/main:flex-row @min-[560px]/main:items-center @min-[560px]/main:justify-between">
                                <div>
                                  <p class="text-sm font-medium text-foreground">{t("settings.plugins.restart")}</p>
                                  <p class="mt-1 max-w-xl text-2xs leading-4 text-muted-foreground">
                                    {t("settings.plugins.restartHint")}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={restartConfirming() ? "destructive" : "outline"}
                                  class="shrink-0"
                                  disabled={busy() || transitional()}
                                  onClick={() => request(plugin(), "restart")}
                                >
                                  {restartConfirming()
                                    ? t("settings.plugins.restartConfirm")
                                    : t("settings.plugins.restart")}
                                </Button>
                              </div>
                            </Show>
                          </Show>
                        </div>
                      </section>
                    );
                  }}
                </Show>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
    </Group>
  );
}

function DetailTabs(props: {
  value: DetailTab;
  settings: boolean;
  onChange: (tab: DetailTab) => void;
}) {
  const options = (): { id: DetailTab; label: string }[] => [
    ...(props.settings ? [{ id: "settings" as const, label: t("settings.plugins.settings") }] : []),
    { id: "capabilities", label: t("settings.plugins.capabilities") },
    { id: "about", label: t("settings.plugins.about") },
  ];
  const buttons = new Map<DetailTab, HTMLButtonElement>();
  return (
    <div class="mt-5 flex gap-5 border-b border-border" role="tablist" aria-label={t("settings.plugins.details")}>
      <For each={options().map((option) => option.id)}>
        {(id) => {
          const option = () => options().find((item) => item.id === id)!;
          onCleanup(() => buttons.delete(id));
          return (
            <Button
              ref={(element) => buttons.set(id, element)}
              type="button"
              variant="quiet"
              role="tab"
              id={`plugin-detail-tab-${id}`}
              aria-controls="plugin-detail-panel"
              aria-selected={props.value === id}
              tabIndex={props.value === id ? 0 : -1}
              class={`-mb-px h-auto justify-start gap-0 rounded-none border-b-2 px-0.5 pb-2.5 ${
                props.value === id
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent font-normal text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => props.onChange(id)}
              onKeyDown={(event) => {
                const items = options();
                handleRovingKey(
                  event,
                  items.findIndex((item) => item.id === id),
                  items,
                  (next) => props.onChange(next as DetailTab),
                  items.map((item) => buttons.get(item.id)),
                );
              }}
            >
              {option().label}
            </Button>
          );
        }}
      </For>
    </div>
  );
}
