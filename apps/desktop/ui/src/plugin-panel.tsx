import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { apiFetch } from "./api";
import { panelContributions, type PanelContribution } from "./plugin-registry";
import { pluginDisplayName } from "./plugin-display";
import { SchedulesPanel } from "./schedules-panel";
import { TerminalPane } from "./terminal";
import type { SchedulesController } from "./use-schedules";
import { t } from "./i18n";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Panels a plugin contributes, beside the builtin ones in the rail launcher.
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
interface PluginComponentProps {
  sessionId: () => string;
  schedules?: SchedulesController;
}

const COMPONENTS: Record<string, Component<PluginComponentProps>> = {
  "schedule:schedules": (props) => (
    <SchedulesPanel sessionId={props.sessionId} controller={props.schedules!} />
  ),
  "terminal:terminal": (props) => <TerminalPane sessionId={props.sessionId()} layout="panel" />,
};

/** The component a panel is drawn with, when the app has one for it. */
function panelComponent(panel: PanelContribution): Component<PluginComponentProps> | undefined {
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
export function PluginPanel(props: PluginComponentProps & { panel: PanelContribution }) {
  // The rail leaves this mounted while the reader moves between plugin tabs.
  // Both tabs are present, so the rail's own check — which only asks whether
  // a panel exists — never swaps the body, and the component chosen on the
  // first render would stay on screen. The key is the panel's identity: a
  // registry refresh that rebuilds the same panel does not tear it down.
  return (
    <Show when={`${props.panel.plugin}:${props.panel.id}`} keyed>
      {(id) => {
        const Component = panelComponent(props.panel);
        return (
          <div data-plugin-panel={id} class="flex min-h-0 flex-1 flex-col">
            {Component ? (
              <Component sessionId={props.sessionId} schedules={props.schedules} />
            ) : (
              <DataPanel panel={props.panel} sessionId={props.sessionId} />
            )}
          </div>
        );
      }}
    </Show>
  );
}

function DataPanel(props: { panel: PanelContribution; sessionId: () => string }) {
  const [text, setText] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const refresh = () => {
    const resource = props.panel.resource ?? (props.panel.kind === "logs" ? "console" : "tabs");
    void fetchResource(props.panel.plugin, resource, props.sessionId())
      .then((body) => {
        setText(body);
        setError(undefined);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoaded(true));
  };
  onMount(() => {
    refresh();
    const timer = setInterval(refresh, 4_000);
    onCleanup(() => clearInterval(timer));
  });
  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-auto">
      <Show when={loaded()} fallback={<EmptyState icon="plug" class="flex-1" title={t("panel.plugin.waiting")} />}>
        <Show
          when={!error()}
          fallback={
            <EmptyState
              icon="alert"
              tone="danger"
              class="flex-1"
              title={t("panel.plugin.crashed")}
              description={error()}
              action={<Button variant="outline" size="sm" onClick={refresh}>{t("panel.plugin.retry")}</Button>}
            />
          }
        >
          <Show
            when={text().trim().length > 0}
            fallback={<EmptyState icon="plug" class="flex-1" title={t("panel.plugin.empty")} />}
          >
            <pre class="whitespace-pre-wrap break-words p-3 font-mono text-2xs text-muted-foreground">{text()}</pre>
          </Show>
        </Show>
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

