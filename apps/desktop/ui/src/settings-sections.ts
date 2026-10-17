import type { MessageKey } from "./locales/zh";

/**
 * Settings blocks, in the order the page shows them.
 * `#/settings` opens the first. `#/settings/<id>` opens that block.
 * A block added later is one entry here, a panel in settings.tsx, and its label
 * in both locales. An id the table does not know yet still opens settings, on
 * the first block, and the address is left as it is.
 */
export const SETTINGS_SECTIONS = [
  { id: "interface", label: "settings.section.interface" },
  { id: "opencode", label: "settings.section.opencode" },
  { id: "permission", label: "settings.section.permission" },
  { id: "about", label: "settings.section.about" },
] as const satisfies readonly { id: string; label: MessageKey }[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export function settingsPath(hashPath: string): { section: string | undefined } | undefined {
  const match = /^\/settings(?:\/([^/]+))?$/.exec(hashPath);
  if (!match) return undefined;
  return { section: match[1] };
}

export function settingsSection(segment: string | undefined): SettingsSectionId {
  const found = SETTINGS_SECTIONS.find((section) => section.id === segment);
  return found?.id ?? SETTINGS_SECTIONS[0].id;
}
