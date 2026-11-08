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
