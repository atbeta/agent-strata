import { afterEach, expect, test, vi } from "vitest";
import { setLocale } from "./i18n";
import { isPluginPanelTab, pluginPanelTabs } from "./plugin-panel";
import { refreshPlugins } from "./plugin-registry";

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
