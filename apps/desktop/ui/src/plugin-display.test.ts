import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLocale } from "./i18n";
import { pluginDisplayDescription, pluginDisplayName } from "./plugin-display";
import { pluginPanelTabs } from "./plugin-panel";
import { refreshPlugins } from "./plugin-registry";

const originalFetch = globalThis.fetch;

describe("plugin display names", () => {
  beforeEach(() => {
    setLocale("zh");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setLocale("zh");
  });

  test("localizes builtin names and descriptions", () => {
    expect(pluginDisplayName("browser", "Browser")).toBe("浏览器");
    expect(pluginDisplayName("dev", "Long-running commands")).toBe("后台进程");
    expect(pluginDisplayDescription("browser")).toContain("浏览器");
    setLocale("en");
    expect(pluginDisplayName("browser", "Browser")).toBe("Browser");
    expect(pluginDisplayName("dev", "Long-running commands")).toBe("Background Processes");
  });

  test("keeps an unknown plugin's manifest text", () => {
    expect(pluginDisplayName("other", "Other plugin")).toBe("Other plugin");
    expect(pluginDisplayDescription("other", "Manifest description")).toBe("Manifest description");
  });

  test("uses the localized name in a contributed tab", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        plugins: [
          {
            id: "browser",
            name: "Browser",
            version: "1.0.0",
            state: "running",
            provides: ["panel"],
            tools: [],
            resources: [],
            panel: { id: "browser", title: "Browser", kind: "screencast" },
          },
        ],
      })) as unknown as typeof fetch;
    await refreshPlugins();
    expect(pluginPanelTabs()[0]?.label).toBe("浏览器");
    setLocale("en");
    expect(pluginPanelTabs()[0]?.label).toBe("Browser");
  });
});
