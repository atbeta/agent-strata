import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { apiFetch } from "./api";
import { panelContributions, type PanelContribution } from "./plugin-registry";
import { pluginDisplayName } from "./plugin-display";
import { SchedulesPanel } from "./schedules-panel";
import { t } from "./i18n";

/**
 * Panels a plugin contributes, as tabs beside the builtin ones.
 *
 * The kinds are deliberately few and each one is a component here. A plugin
 * cannot ship a component — that would be arbitrary code in this window — it
 * picks a shape from this table and fills it with data over its own routes.
 *
 * A frame-panel kind (`screencast`) used to be here: frames on the plugin's
 * event stream, pointer and key input back through its private route. It went
 * to `local/browser-plugin` with its only tenant, so this build draws data
 * panels and refuses to offer a tab it cannot draw.
 */
export function pluginPanelTab(panel: PanelContribution): string {
  return `plugin:${panel.plugin}`;
}

/** The tab ids a session's rail should offer, given what is running. */
export function pluginPanelTabs(): { id: string; label: string; panel: PanelContribution }[] {
  return panelContributions().map((panel) => ({
    id: pluginPanelTab(panel),
    label: pluginDisplayName(panel.plugin, panel.title),
    panel,
  }));
}

/** The panel a tab id names, when it names one. */
export function panelForTab(tab: string): PanelContribution | undefined {
  if (!tab.startsWith("plugin:")) return undefined;
  const plugin = tab.slice("plugin:".length);
  return panelContributions().find((p) => p.plugin === plugin);
}

/**
 * The panels this build can draw as components.
 *
 * A plugin cannot ship a component into this window - that would be arbitrary
 * code here - so a panel is either a shape the app knows how to draw, or a
 * component the app blesses for one capability. This table is where a
 * capability gets its shape; a panel that names a component here and is not
 * in it is not offered at all, because a tab that pointed at nothing would
 * be blank.
 */
const COMPONENTS: Record<string, Component<{ sessionId: () => string }>> = {
  "schedule:schedules": SchedulesPanel,
};

/** The component a panel is drawn with, when the app has one for it. */
function panelComponent(panel: PanelContribution): Component<{ sessionId: () => string }> | undefined {
  return COMPONENTS[`${panel.plugin}:${panel.id}`];
}

/** Whether a tab id is a plugin panel this build can draw. */
export function isPluginPanelTab(tab: string): boolean {
  const panel = panelForTab(tab);
  if (!panel) return false;
  // `component` is a compile-time registration: a panel that names one this
  // build does not have would be blank, so it is not offered at all.
  // `iframe` is third-party-only.
  if (panel.kind === "component") return panelComponent(panel) !== undefined;
  return panel.kind === "logs" || panel.kind === "status";
}

/**
 * A plugin's panel.
 *
 * Data panels are the only kind this build draws: they read a resource the
 * plugin already serves (`logs`, `status`). The frame-panel kind that streamed
 * live pages lives on `local/browser-plugin` with the browser plugin itself —
 * it is a platform capability, but shipping a renderer nothing uses and that
 * can wedge a rail is not.
 */
export function PluginPanel(props: { panel: PanelContribution; sessionId: () => string }) {
  const Component = panelComponent(props.panel);
  if (Component) return <Component sessionId={props.sessionId} />;
  return <DataPanel panel={props.panel} sessionId={props.sessionId} />;
}

function DataPanel(props: { panel: PanelContribution; sessionId: () => string }) {
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal<string>();
  const refresh = () => {
    const resource = props.panel.resource ?? (props.panel.kind === "logs" ? "console" : "tabs");
    void fetchResource(props.panel.plugin, resource, props.sessionId())
      .then((body) => {
        setText(body);
        setError(undefined);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 4_000);
    onCleanup(() => clearInterval(timer));
  });
  return (
    <div class="min-h-0 flex-1 overflow-auto p-3">
      <Show when={!error()} fallback={<p class="text-xs text-destructive">{error()}</p>}>
        <pre class="whitespace-pre-wrap break-words font-mono text-2xs text-muted-foreground">{text()}</pre>
      </Show>
    </div>
  );
}

async function fetchResource(plugin: string, key: string, sessionId: string): Promise<string> {
  const res = await apiFetch(
    `/plugins/${encodeURIComponent(plugin)}/resources/${encodeURIComponent(key)}?session=${encodeURIComponent(sessionId)}`,
  );
  if (!res.ok) throw new Error(t("api.err.service", { status: res.status }));
  return res.text();
}

