/**
 * Policy editor. The effect names are words in the interface and wire values on
 * the way out: the option text is translated, `value=` stays allow / deny / ask.
 * The condition operators (glob / regex / equals) and `when` belong to the
 * backend DSL and are identical in both languages.
 */
export default {
  "policy.hint": "Choose what happens when no rule matches. Custom rules win; this is not a sandbox.",
  "policy.loading": "Loading permission policy…",

  "policy.default.label": "Default effect",
  "policy.posture.ask": "Ask each time",
  "policy.posture.allow": "Don't ask",
  "policy.posture.deny": "Deny by default",
  "policy.posture.ask.hint": "Ask before every call that no rule matches.",
  "policy.posture.allow.hint": "Allow unmatched calls, including unreadable commands; a few tools still ask until you allow them.",
  "policy.posture.deny.hint": "Deny unmatched calls without letting a session open them temporarily.",

  "policy.rules.title": "Custom rules",
  "policy.rules.count.one": "{n} rule",
  "policy.rules.count.other": "{n} rules",
  "policy.rules.emptyTitle": "No custom rules yet",
  "policy.rules.empty": "Only the default effect applies. Add a rule when a kind of tool should always be allowed or denied.",

  "policy.field.ruleId": "rule id",
  "policy.field.tool": "tool",
  "policy.field.toolHint": "bash, * or edit*",
  "policy.field.reason": "reason",
  "policy.field.reasonPlaceholder": "shown to the agent, optional",
  "policy.rule.effect.allow": "allow",
  "policy.rule.effect.deny": "deny",
  "policy.rule.effect.ask": "ask",

  "policy.conditions.title": "conditions",
  "policy.conditions.hint": "all of them have to match",
  "policy.conditions.add": "add condition",

  "policy.action.remove": "remove",
  "policy.action.clear": "Clear rules",
  "policy.action.clearing": "Clearing…",
  "policy.action.save": "Save policy",
  "policy.action.saving": "Saving…",
  "policy.action.addRule": "Add rule",

  "policy.test.title": "Verify rules",
  "policy.test.tool": "Tool",
  "policy.test.input": "Input (JSON)",
  "policy.test.hint": "Check the unsaved draft with a simulated call; no tool is executed.",
  "policy.test.run": "Run",
  "policy.test.via": " via ",

  "policy.advanced.title": "Advanced",
  "policy.advanced.hint": "Configuration file and destructive actions",
  "policy.file.title": "Configuration file",
  "policy.file.hint": "For manual editing or troubleshooting; usually there is no need to open it.",
  "policy.file.copy": "Copy path",
  "policy.file.copied": "Copied",
  "policy.danger.title": "Reset permission policy",
  "policy.danger.hint": "Remove every custom rule and restore asking each time.",
  "policy.clear.title": "Clear every rule?",
  "policy.clear.description": "This removes every custom rule and restores “Ask each time”. This cannot be undone.",
  "policy.dirty": "You have unsaved changes",

  "policy.notice.saved": "Saved — live connections pick it up immediately",
  "policy.notice.cleared": "Cleared — back to asking each time",
  "policy.err.invalidJson": "Input is not valid JSON",
} as const;
