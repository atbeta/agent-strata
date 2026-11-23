import type { ManagedSkill, SkillSource } from "./api";
import { t, type MessageKey } from "./i18n";

export const SKILL_SOURCE_LABEL: Record<SkillSource, MessageKey> = {
  "opencode-global": "skills.source.global",
  "opencode-project": "skills.source.project",
  claude: "skills.source.claude",
  agents: "skills.source.agents",
  custom: "skills.source.custom",
  http: "skills.source.http",
  console: "skills.source.console",
  builtin: "skills.source.builtin",
  unknown: "skills.source.unknown",
};

export function skillStatusLabel(status: ManagedSkill["status"]): string {
  return t(`skills.status.${status}`);
}

export function skillReadonlyLabel(skill: ManagedSkill): string {
  if (!skill.readonlyReason) return t("skills.readonly.custom");
  return t(`skills.readonly.${skill.readonlyReason}`);
}

export function skillSupportPath(skill: ManagedSkill, file: string): string {
  return `${skill.location.replace(/[\\/]SKILL\.md$/, "")}/${file}`;
}
