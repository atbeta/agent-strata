import { t, type MessageKey } from "./i18n";

const NAME_KEYS: Record<string, MessageKey> = {
  background: "plugin.background.name",
  browser: "plugin.browser.name",
  dev: "plugin.dev.name",
  schedule: "plugin.schedule.name",
  sessions: "plugin.sessions.name",
  terminal: "plugin.terminal.name",
};

const DESCRIPTION_KEYS: Record<string, MessageKey> = {
  background: "plugin.background.description",
  browser: "plugin.browser.description",
  dev: "plugin.dev.description",
  schedule: "plugin.schedule.description",
  sessions: "plugin.sessions.description",
  terminal: "plugin.terminal.description",
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
  "background.fit": "plugin.background.fit",
  "background.opacity": "plugin.background.opacity",
  "background.blur": "plugin.background.blur",
  "background.scrim": "plugin.background.scrim",
  "sessions.scope": "plugin.sessions.scope",
};

const SETTING_DESCRIPTION_KEYS: Record<string, MessageKey> = {
  "background.fit": "plugin.background.fit.description",
  "background.opacity": "plugin.background.opacity.description",
  "background.blur": "plugin.background.blur.description",
  "background.scrim": "plugin.background.scrim.description",
  "sessions.scope": "plugin.sessions.scope.description",
};

const SETTING_VALUE_KEYS: Record<string, MessageKey> = {
  "background.fit.cover": "plugin.background.fit.cover",
  "background.fit.contain": "plugin.background.fit.contain",
  "sessions.scope.workspace": "plugin.sessions.scope.workspace",
  "sessions.scope.global": "plugin.sessions.scope.global",
};

export function pluginSettingDescription(id: string, setting: string, fallback: string): string {
  const key = SETTING_DESCRIPTION_KEYS[`${id}.${setting}`];
  return key ? t(key) : fallback;
}

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
