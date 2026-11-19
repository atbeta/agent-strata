import { afterEach, expect, test, vi } from "vitest";
import { setLocale } from "./i18n";
import { pluginPanelTabs } from "./plugin-panel";
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
