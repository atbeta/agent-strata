import { afterEach, expect, test, vi } from "vitest";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { setLocale } from "./i18n";
import { PluginPanel, isPluginPanelTab, pluginPanelTabs } from "./plugin-panel";
import { refreshPlugins, type PanelContribution } from "./plugin-registry";

vi.mock("./terminal", () => ({
  TerminalPane: () => {
    const el = document.createElement("div");
    el.dataset.pane = "terminal";
    return el;
  },
}));

vi.mock("./schedules-panel", () => ({
  SchedulesPanel: () => {
    const el = document.createElement("div");
    el.dataset.pane = "schedules";
    return el;
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("zh");
});

test("a contributed tab uses the plugin's localized name", async () => {
  setLocale("zh");
  vi.stubGlobal("fetch", async () =>
    Response.json({
      plugins: [
        {
          id: "schedule",
          name: "Scheduled prompts",
          version: "1.0.0",
          state: "running",
          provides: ["panel"],
          tools: [],
          resources: [],
          panel: { id: "schedules", title: "Schedules", kind: "component" },
        },
      ],
    }),
  );
  await refreshPlugins();
  expect(pluginPanelTabs()[0]?.label).toBe("定时任务");
  setLocale("en");
  expect(pluginPanelTabs()[0]?.label).toBe("Scheduled Prompts");
});

test("the native terminal component is offered while its plugin is running", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      plugins: [{
        id: "terminal",
        name: "Interactive terminals",
        version: "1.0.0",
        state: "running",
        provides: ["tools", "resources", "panel"],
        tools: [],
        resources: [],
        panel: { id: "terminal", title: "Terminal", kind: "component", icon: "terminal" },
      }],
    }),
  );
  await refreshPlugins();
  expect(isPluginPanelTab("plugin:terminal")).toBe(true);
  expect(pluginPanelTabs()[0]?.label).toBe("交互终端");
  setLocale("en");
  expect(pluginPanelTabs()[0]?.label).toBe("Interactive Terminals");
});

const schedulePanel: PanelContribution = {
  plugin: "schedule",
  id: "schedules",
  title: "Schedules",
  kind: "component",
};
const terminalPanel: PanelContribution = {
  plugin: "terminal",
  id: "terminal",
  title: "Terminal",
  kind: "component",
  icon: "terminal",
};

function HeldPanel(props: { panel: PanelContribution }) {
  // The rail's Show only asks whether a plugin panel exists. Both of these
  // are present, so this parent stays mounted across the switch.
  return (
    <Show when={props.panel}>
      {(panel) => <PluginPanel panel={panel()} sessionId={() => "session-1"} />}
    </Show>
  );
}

test("moving between two plugin panels draws the one just chosen", () => {
  const [panel, setPanel] = createSignal<PanelContribution>(schedulePanel);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = render(() => <HeldPanel panel={panel()} />, host);
  try {
    expect(host.querySelector("[data-pane]")?.getAttribute("data-pane")).toBe("schedules");
    setPanel(terminalPanel);
    expect(host.querySelector("[data-pane]")?.getAttribute("data-pane")).toBe("terminal");
    setPanel(schedulePanel);
    expect(host.querySelector("[data-pane]")?.getAttribute("data-pane")).toBe("schedules");
  } finally {
    dispose();
    host.remove();
  }
});
