import type { Event } from "@opencode-ai/sdk/v2";
import { SHELL_PERMS } from "./model";

type PermissionAsked = Extract<Event, { type: "permission.asked" }>["properties"];
type QuestionAsked = Extract<Event, { type: "question.asked" }>["properties"];

export function permissionInput(p: PermissionAsked): Record<string, unknown> {
  const input: Record<string, unknown> = { ...p.metadata, patterns: p.patterns };
  if (SHELL_PERMS.has(p.permission)) input.command = p.patterns.join("\n");
  return input;
}

export function permissionRequest(p: PermissionAsked) {
  return {
    request_id: p.id,
    call_id: p.tool?.callID,
    tool: p.permission,
    input: permissionInput(p),
  };
}

export function questionRequest(p: QuestionAsked) {
  return {
    request_id: p.id,
    questions: p.questions.map((q) => ({
      question: q.question,
      header: q.header,
      options: q.options.map((o) => ({ label: o.label, description: o.description })),
      multiple: q.multiple,
      custom: q.custom,
    })),
  };
}
