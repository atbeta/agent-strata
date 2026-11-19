import { t, type MessageKey } from "./i18n";

const NAME_KEYS: Record<string, MessageKey> = {
  browser: "plugin.browser.name",
  dev: "plugin.dev.name",
};

const DESCRIPTION_KEYS: Record<string, MessageKey> = {
  browser: "plugin.browser.description",
  dev: "plugin.dev.description",
};

export function pluginDisplayName(id: string, fallback: string): string {
  const key = NAME_KEYS[id];
  return key ? t(key) : fallback;
}

export function pluginDisplayDescription(id: string, fallback = ""): string {
  const key = DESCRIPTION_KEYS[id];
  return key ? t(key) : fallback;
}

const SETTING_KEYS: Record<string, MessageKey> = {
  "sessions.scope": "plugin.sessions.scope",
};

const SETTING_VALUE_KEYS: Record<string, MessageKey> = {
  "sessions.scope.workspace": "plugin.sessions.scope.workspace",
  "sessions.scope.global": "plugin.sessions.scope.global",
};

/** A setting's own label, in the app's words where it has them. */
export function pluginSettingTitle(id: string, setting: string, fallback: string): string {
  const key = SETTING_KEYS[`${id}.${setting}`];
  return key ? t(key) : fallback;
}

/** One of a setting's values, in the app's words where it has them. */
export function pluginSettingValueLabel(id: string, setting: string, value: string): string {
  const key = SETTING_VALUE_KEYS[`${id}.${setting}.${value}`];
  return key ? t(key) : value;
}
