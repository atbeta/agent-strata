import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLocale } from "./i18n";
import {
  pluginDisplayDescription,
  pluginDisplayName,
  pluginDisplaySummary,
  pluginSettingDescription,
  pluginSettingTitle,
} from "./plugin-display";

describe("plugin display names", () => {
  beforeEach(() => {
    setLocale("zh");
  });

  afterEach(() => {
    setLocale("zh");
  });

  test("localizes builtin names and descriptions", () => {
    expect(pluginDisplayName("browser", "Browser")).toBe("浏览器");
    expect(pluginDisplayName("dev", "Long-running commands")).toBe("后台进程");
    expect(pluginDisplayName("schedule", "Scheduled prompts")).toBe("定时任务");
    expect(pluginDisplayName("sessions", "Session memory")).toBe("会话记忆");
    expect(pluginDisplayName("background", "Custom background")).toBe("自定义背景");
    expect(pluginDisplayName("terminal", "Interactive terminals")).toBe("交互终端");
    expect(pluginDisplayDescription("terminal")).toContain("重新连接");
    expect(pluginSettingTitle("background", "fit", "Image fit")).toBe("填充方式");
    expect(pluginDisplayDescription("browser")).toContain("浏览器");
    expect(pluginDisplayDescription("schedule")).toContain("发送消息");
    expect(pluginDisplayDescription("sessions")).toContain("历史会话");
    expect(pluginDisplaySummary("sessions")).toBe("检索历史会话内容");
    expect(pluginSettingDescription("sessions", "scope", "Read scope")).toContain("工作区");
    setLocale("en");
    expect(pluginDisplayName("browser", "Browser")).toBe("Browser");
    expect(pluginDisplayName("dev", "Long-running commands")).toBe("Background Processes");
    expect(pluginDisplayName("schedule", "Scheduled prompts")).toBe("Scheduled Prompts");
    expect(pluginDisplayName("sessions", "Session memory")).toBe("Session Memory");
    expect(pluginDisplayName("terminal", "Interactive terminals")).toBe("Interactive Terminals");
    expect(pluginDisplayDescription("terminal")).toContain("reconnect");
    expect(pluginSettingDescription("sessions", "scope", "Read scope")).toContain("workspaces");
  });

  test("keeps an unknown plugin's manifest text", () => {
    expect(pluginDisplayName("other", "Other plugin")).toBe("Other plugin");
    expect(pluginDisplayDescription("other", "Manifest description")).toBe("Manifest description");
    expect(pluginDisplaySummary("other", "Manifest summary")).toBe("Manifest summary");
    expect(pluginSettingDescription("other", "scope", "Manifest setting")).toBe("Manifest setting");
  });

});
