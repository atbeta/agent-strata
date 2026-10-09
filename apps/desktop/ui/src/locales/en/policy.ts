/**
 * Policy editor. The effect names are words in the interface and wire values on
 * the way out: the option text is translated, `value=` stays allow / deny / ask.
 * The condition operators (glob / regex / equals) and `when` belong to the
 * backend DSL and are identical in both languages.
 */
export default {
  // Header
  "policy.title": "Policy editor",
  "policy.hint":
    "advisory permission rules — deny > ask > allow among matching rules, no match falls back to the default. not a sandbox.",

  // Rule fields
  "policy.field.ruleId": "rule id",
  "policy.field.tool": "tool",
  "policy.field.reason": "reason shown to the agent when this rule fires (optional)",

  // Effects
  "policy.rule.effect.allow": "allow",
  "policy.rule.effect.deny": "deny",
  "policy.rule.effect.ask": "ask",

  // Actions
  "policy.action.remove": "remove",
  "policy.action.clear": "clear",
  "policy.action.save": "save policy",
  "policy.action.addRule": "+ add rule",

  // Conditions
  "policy.conditions.hint": "when — every condition must match (input path · condition · value)",
  "policy.conditions.add": "+ condition",

  // Default effect and the rule count
  "policy.default.label": "default effect",
  "policy.rules.count.one": "{n} rule",
  "policy.rules.count.other": "{n} rules",

  // Draft tester
  "policy.test.title": "test the draft",
  "policy.test.hint":
    "runs the unsaved draft against a fake tool call — bash commands are split and analyzed like real permission checks",
  "policy.test.run": "run",
  "policy.test.via": " via ",

  // Notices and validation
  "policy.notice.saved": "saved — live connections pick it up immediately",
  "policy.notice.cleared": "cleared — everything falls back to ask",
  "policy.err.invalidJson": "input is not valid JSON",
} as const;
