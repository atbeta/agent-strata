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
    expect(settingsSection("permission")).toBe("permission");
  });

  test("an id that is not registered yet still lands in settings, on the first block", () => {
    expect(settingsPath("/settings/later")).toEqual({ section: "later" });
    expect(settingsSection("later")).toBe(SETTINGS_SECTIONS[0].id);
  });

  test("anything deeper than one block is not the settings page", () => {
    expect(settingsPath("/settings/opencode/extra")).toBeUndefined();
    expect(settingsPath("/session/1")).toBeUndefined();
  });
});
