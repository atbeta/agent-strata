// What a plugin contributes to the UI, as the UI understands it.
//
// A plugin cannot ship code into this window. It ships a manifest, and this
// module is the other half of the contract: a small, fixed vocabulary of tool
// renderers and panel kinds that the UI already knows how to draw. Choosing
// from that vocabulary is the plugin's whole influence over the interface, and
// the fallback for "nothing declared" is the generic tool row that has always
// existed.
//
// The registry is keyed by plugin and tool, refreshed when the service says
// the set changed. A plugin that disappears leaves its entries stale for one
// round trip at most, and a renderer it named that this build does not have
// falls through instead of drawing an empty box.

import { createSignal } from "solid-js";
import { listPlugins, type PluginSummary } from "./api";

/** The renderers the transcript knows how to draw. */
export type ToolRenderKind =
  | "terminal"
  | "web"
  | "read"
  | "edit"
  | "search"
  | "todo"
  | "task"
  | "image"
  | "generic";

const RENDER_KINDS: readonly ToolRenderKind[] = [
  "terminal",
  "web",
  "read",
  "edit",
  "search",
  "todo",
  "task",
  "image",
  "generic",
];

/** The icon names `icons.tsx` can draw; anything else falls back. */
const ICONS = new Set([
  "terminal",
  "page",
  "pencil",
  "folder",
  "search",
  "globe",
  "list",
  "fork",
  "wrench",
  "image",
  "message",
  "code",
]);

export interface ToolRenderer {
  kind: ToolRenderKind;
  icon?: string;
  plugin: string;
  tool: string;
}

const [renderers, setRenderers] = createSignal<Record<string, ToolRenderer>>({});
const [panels, setPanels] = createSignal<PanelContribution[]>([]);
const [plugins, setPlugins] = createSignal<PluginSummary[]>([]);
const [allPlugins, setAllPlugins] = createSignal<PluginSummary[]>([]);
const [loaded, setLoaded] = createSignal(false);
const [readFailed, setReadFailed] = createSignal(false);
const [version, setVersion] = createSignal(0);

export interface PanelContribution {
  plugin: string;
  id: string;
  title: string;
  kind: "logs" | "status" | "component";
  icon?: string;
}

/**
 * Load the registry.
 *
 * Called once at startup and again whenever the service broadcasts
 * `plugins.changed`. A failed read keeps the previous registry rather than
 * emptying it: a plugin that is still running should not lose its renderer
 * because one request raced a restart.
 */
export async function refreshPlugins(): Promise<void> {
  let list: PluginSummary[];
  try {
    list = await listPlugins();
  } catch {
    setReadFailed(true);
    return;
  }
  const nextRenderers: Record<string, ToolRenderer> = {};
  const nextPanels: PanelContribution[] = [];
  for (const plugin of list) {
    if (plugin.state !== "running") continue;
    for (const [tool, declared] of Object.entries(plugin.ui?.toolRenderers ?? {})) {
      const kind = (RENDER_KINDS as readonly string[]).includes(declared.kind)
        ? (declared.kind as ToolRenderKind)
        : "generic";
      nextRenderers[`${plugin.id}/${tool}`] = {
        kind,
        icon: declared.icon && ICONS.has(declared.icon) ? declared.icon : undefined,
        plugin: plugin.id,
        tool,
      };
    }
    if (plugin.panel) {
      nextPanels.push({
        plugin: plugin.id,
        id: plugin.panel.id,
        title: plugin.panel.title,
        kind: plugin.panel.kind,
        icon: plugin.panel.icon && ICONS.has(plugin.panel.icon) ? plugin.panel.icon : undefined,
      });
    }
  }
  setRenderers(nextRenderers);
  setPanels(nextPanels);
  setPlugins(list.filter((p) => p.state === "running"));
  setAllPlugins(list);
  setLoaded(true);
  setReadFailed(false);
  setVersion((n) => n + 1);
}

/** A renderer for one tool, when its plugin declared one. */
export function toolRenderer(tool: string): ToolRenderer | undefined {
  const at = tool.indexOf("_");
  if (at <= 0) return undefined;
  const plugin = tool.slice(0, at);
  const name = tool.slice(at + 1);
  return renderers()[`${plugin}/${name}`];
}

/** The plugin that owns a tool name, if any running plugin does. */
export function pluginOfTool(tool: string): string | undefined {
  return toolRenderer(tool)?.plugin;
}

export function panelContributions(): PanelContribution[] {
  return panels();
}

export function runningPlugins(): PluginSummary[] {
  return plugins();
}

export function pluginSummaries(): PluginSummary[] {
  return allPlugins();
}

export function pluginsLoaded(): boolean {
  return loaded();
}

export function pluginsReadFailed(): boolean {
  return readFailed();
}

/** A counter the transcript can read to know the registry changed under it. */
export function registryVersion(): number {
  return version();
}

