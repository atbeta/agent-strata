import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Switch } from "@/components/ui/switch";
import {
  setPluginLifecycle,
  type PluginLifecycleAction,
  type PluginSummary,
} from "./api";
import { explain, fadeKeyed } from "./errors";
import { num, t, type MessageKey } from "./i18n";
import { pluginDisplayDescription, pluginDisplayName } from "./plugin-display";
import {
  pluginSummaries,
  pluginsLoaded,
  pluginsReadFailed,
  refreshPlugins,
} from "./plugin-registry";
import { Card, Group } from "./settings-blocks";

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

/** How long the undo line stays after a disable. */
const UNDO_MS = 10_000;

export function PluginSettings() {
  const [busyId, setBusyId] = createSignal("");
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  const [feedback, setFeedback] = fadeKeyed();
  const [confirming, setConfirming] = createSignal("");
  /**
   * Plugins disabled a moment ago, so the reader can take it back.
   *
   * A switch states a fact about the present, not a request to be confirmed.
   * It used to ask twice, and the second ask was invisible: the switch is
   * driven by the service's state, so the first click moved nothing at all and
   * the confirmation was a line of text under a control that had not budged.
   * Disabling is now immediate, and a mistake is undone from the line that
   * reports it — the same place the reader is already looking.
   */
  const [justDisabled, setJustDisabled] = createSignal<Record<string, boolean>>({});
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const undoTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    // Any attempt settles the question the undo line was asking.
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
    // Only restart asks twice: it throws away the running instance and
    // whatever it was in the middle of. Turning a switch on or off is not
    // that kind of act, and the reader is looking right at the result.
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
            <Card class="px-0">
              <For each={pluginSummaries()}>
                {(plugin) => {
                  const name = () => pluginDisplayName(plugin.id, plugin.name);
                  const busy = () => busyId() === plugin.id;
                  const transitional = () => plugin.state === "starting" || plugin.state === "stopping";
                  const restartConfirming = () => confirming() === `${plugin.id}:restart`;
                  return (
                    <div class="px-4 py-3">
                      <div class="flex flex-col gap-3 @min-[560px]/main:flex-row @min-[560px]/main:items-center @min-[560px]/main:justify-between">
                        <div class="min-w-0">
                          <div class="flex min-w-0 items-baseline gap-2">
                            <span class="truncate text-sm font-medium text-foreground">{name()}</span>
                            <span class="shrink-0 font-mono text-2xs text-muted-foreground">v{plugin.version}</span>
                          </div>
                          <div class="mt-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
                            <span class={`size-1.5 shrink-0 rounded-full ${STATE_TONES[plugin.state]}`} />
                            {t(STATE_KEYS[plugin.state])}
                          </div>
                        </div>
                        <div class="flex shrink-0 flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="quiet"
                            onClick={() =>
                              setExpanded((current) => ({ ...current, [plugin.id]: !current[plugin.id] }))
                            }
                          >
                            {expanded()[plugin.id]
                              ? t("settings.plugins.collapse")
                              : t("settings.plugins.details")}
                          </Button>
                          <Show when={plugin.state !== "disabled"}>
                            <Button
                              type="button"
                              size="sm"
                              variant={restartConfirming() ? "destructive" : "outline"}
                              disabled={busy() || transitional()}
                              onClick={() => request(plugin, "restart")}
                            >
                              {restartConfirming()
                                ? t("settings.plugins.restartConfirm")
                                : t("settings.plugins.restart")}
                            </Button>
                          </Show>
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
                      </div>
                      <Show when={restartConfirming()}>
                        <p class="mt-2 text-2xs leading-4 text-muted-foreground">
                          {t("settings.plugins.restartHint")}
                        </p>
                      </Show>
                      <Show when={justDisabled()[plugin.id] && plugin.state === "disabled"}>
                        <div class="mt-2 flex items-center gap-2 text-2xs leading-4 text-muted-foreground">
                          <span>{t("settings.plugins.justDisabled")}</span>
                          <Button
                            type="button"
                            variant="link"
                            size="xs"
                            class="text-2xs"
                            disabled={busy() || transitional()}
                            onClick={() => request(plugin, "enable")}
                          >
                            {t("settings.plugins.undo")}
                          </Button>
                        </div>
                      </Show>
                      <Show when={plugin.error}>
                        <p class="mt-2 whitespace-pre-wrap break-words text-2xs leading-4 text-destructive">
                          {plugin.error}
                        </p>
                      </Show>
                      <Show when={feedback()[plugin.id]}>
                        <p class="mt-2 text-2xs leading-4 text-destructive">{feedback()[plugin.id]}</p>
                      </Show>
                      <Show when={expanded()[plugin.id]}>
                        <div class="mt-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
                          <Show when={pluginDisplayDescription(plugin.id, plugin.description)}>
                            <p class="leading-5 text-muted-foreground">
                              {pluginDisplayDescription(plugin.id, plugin.description)}
                            </p>
                          </Show>
                          <dl class="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
                            <dt class="text-muted-foreground">{t("settings.plugins.id")}</dt>
                            <dd><code class="font-mono text-2xs">{plugin.id}</code></dd>
                            <dt class="text-muted-foreground">{t("settings.plugins.tools")}</dt>
                            <dd>
                              <Show when={plugin.tools.length > 0} fallback={t("settings.plugins.none")}>
                                <div class="flex flex-wrap gap-1">
                                  <For each={plugin.tools}>
                                    {(tool) => (
                                      <code class="rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-2xs">
                                        {plugin.id}_{tool.name}
                                      </code>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </dd>
                            <dt class="text-muted-foreground">{t("settings.plugins.resources")}</dt>
                            <dd class="break-words font-mono text-2xs">
                              {plugin.resources.length
                                ? plugin.resources.map((resource) => resource.key).join(", ")
                                : t("settings.plugins.none")}
                            </dd>
                            <dt class="text-muted-foreground">{t("settings.plugins.panel")}</dt>
                            <dd>
                              {plugin.panel
                                ? `${pluginDisplayName(plugin.id, plugin.panel.title)} (${plugin.panel.kind})`
                                : t("settings.plugins.none")}
                            </dd>
                            <dt class="text-muted-foreground">{t("settings.plugins.hooks")}</dt>
                            <dd>{hookSummary(plugin)}</dd>
                          </dl>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </Card>
          </Show>
        </Show>
      </Show>
    </Group>
  );
}
