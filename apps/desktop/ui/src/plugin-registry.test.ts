import { beforeEach, describe, expect, test } from "bun:test";

/**
 * The registry is the only place a plugin's declared UI reaches the app.
 *
 * These cases run the pure parts: what a manifest is allowed to say, and what
 * the transcript does with a name that is not builtin. The fetch and the
 * reactive signal are exercised through `refreshPlugins` with a stubbed
 * `fetch`, which is as far as a unit test can go without mounting the app.
 */

const originalFetch = globalThis.fetch;

function servePlugins(payload: unknown) {
  globalThis.fetch = (async () =>
    Response.json(payload)) as unknown as typeof fetch;
}

describe("the plugin registry", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a running plugin's renderers are keyed by plugin and tool", async () => {
    const registry = await import("./plugin-registry");
    servePlugins({
      plugins: [
        {
          id: "browser",
          name: "Browser",
          version: "1.0.0",
          state: "running",
          provides: ["tools", "panel"],
          tools: [{ name: "navigate", description: "" }],
          resources: [],
          panel: { id: "browser", title: "Browser", kind: "screencast", icon: "globe" },
          ui: { toolRenderers: { navigate: { kind: "web", icon: "globe" } } },
        },
      ],
    });
    await registry.refreshPlugins();
    expect(registry.toolRenderer("browser_navigate")).toEqual({
      kind: "web",
      icon: "globe",
      plugin: "browser",
      tool: "navigate",
    });
    expect(registry.panelContributions()).toHaveLength(1);
    expect(registry.panelContributions()[0]!.kind).toBe("screencast");
  });

  test("a disabled plugin contributes nothing", async () => {
    const registry = await import("./plugin-registry");
    servePlugins({
      plugins: [
        {
          id: "browser",
          name: "Browser",
          version: "1.0.0",
          state: "disabled",
          provides: ["panel"],
          tools: [],
          resources: [],
          panel: { id: "browser", title: "Browser", kind: "screencast" },
        },
      ],
    });
    await registry.refreshPlugins();
    expect(registry.toolRenderer("browser_navigate")).toBeUndefined();
    expect(registry.panelContributions()).toHaveLength(0);
  });

  test("a renderer kind this build does not know falls back instead of drawing nothing", async () => {
    const registry = await import("./plugin-registry");
    servePlugins({
      plugins: [
        {
          id: "odd",
          name: "Odd",
          version: "1",
          state: "running",
          provides: ["tools"],
          tools: [],
          resources: [],
          ui: { toolRenderers: { go: { kind: "hologram", icon: "not-an-icon" } } },
        },
      ],
    });
    await registry.refreshPlugins();
    const renderer = registry.toolRenderer("odd_go");
    expect(renderer?.kind).toBe("generic");
    // An icon name the icon set does not have is dropped, not passed through
    // to a lookup that would render an empty box.
    expect(renderer?.icon).toBeUndefined();
  });

  test("a failed read keeps what was already there", async () => {
    const registry = await import("./plugin-registry");
    servePlugins({
      plugins: [
        {
          id: "keep",
          name: "Keep",
          version: "1",
          state: "running",
          provides: ["tools"],
          tools: [],
          resources: [],
          ui: { toolRenderers: { go: { kind: "read" } } },
        },
      ],
    });
    await registry.refreshPlugins();
    expect(registry.toolRenderer("keep_go")).toBeDefined();

    globalThis.fetch = (async () => {
      throw new Error("service down");
    }) as unknown as typeof fetch;
    await registry.refreshPlugins();
    // A restart that races a read must not blank the transcript's renderers.
    expect(registry.toolRenderer("keep_go")).toBeDefined();
  });
});
