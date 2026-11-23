import { describe, expect, test } from "bun:test";
import { SETTINGS_SECTIONS, settingsPath, settingsSection } from "./settings-sections";

describe("settings sections", () => {
  test("the bare settings address opens the first block", () => {
    expect(settingsPath("/settings")).toEqual({ section: undefined });
    expect(settingsSection(undefined)).toBe(SETTINGS_SECTIONS[0].id);
  });

  test("a known block has its own address", () => {
    expect(settingsPath("/settings/opencode")).toEqual({ section: "opencode" });
    expect(settingsSection("opencode")).toBe("opencode");
    expect(settingsPath("/settings/notifications")).toEqual({ section: "notifications" });
    expect(settingsSection("notifications")).toBe("notifications");
    expect(settingsSection("plugins")).toBe("plugins");
    expect(settingsSection("skills")).toBe("skills");
    expect(settingsSection("permission")).toBe("permission");
  });

  test("an id that is not registered yet still lands in settings, on the first block", () => {
    expect(settingsPath("/settings/later")).toEqual({ section: "later" });
    expect(settingsSection("later")).toBe(SETTINGS_SECTIONS[0].id);
  });

  test("a plugin detail has its own decodable address", () => {
    expect(settingsPath("/settings/plugins/memory")).toEqual({ section: "plugins", plugin: "memory" });
    expect(settingsPath("/settings/plugins/a%2Fb")).toEqual({ section: "plugins", plugin: "a/b" });
  });

  test("a skill detail has its own decodable address", () => {
    expect(settingsPath("/settings/skills/skill-key")).toEqual({ section: "skills", skill: "skill-key" });
    expect(settingsPath("/settings/skills/a%2Fb")).toEqual({ section: "skills", skill: "a/b" });
  });

  test("only plugins and skills have a detail segment", () => {
    expect(settingsPath("/settings/opencode/extra")).toBeUndefined();
    expect(settingsPath("/settings/plugins/memory/extra")).toBeUndefined();
    expect(settingsPath("/settings/skills/skill-key/extra")).toBeUndefined();
    expect(settingsPath("/session/1")).toBeUndefined();
  });
});
