import { describe, expect, test } from "bun:test";
import type { PluginContext } from "@agent-strata/plugin-sdk";
import { createTerminalPlugin } from "../src/index";

describe("terminal socket upgrade", () => {
  test("an unknown session is a quiet 404, not a 500 with the resolver error", async () => {
    const plugin = createTerminalPlugin({ workspaceOf: () => "/work" });
    const context: PluginContext = {
      pluginId: "terminal",
      resolveSession: () => {
        throw new Error("sensitive resolver detail");
      },
      dataDir: "/tmp",
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      emit() {},
    };
    await plugin.initialize(context);
    const response = await plugin.upgrade!(
      new Request("http://localhost/plugins/terminal/terminals/pty_1/connect?session=unknown"),
      "/terminals/pty_1/connect",
    );
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(404);
    expect(await (response as Response).text()).not.toContain("sensitive resolver detail");
    await plugin.shutdown();
  });
});
