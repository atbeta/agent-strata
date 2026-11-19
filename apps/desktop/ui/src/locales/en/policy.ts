/**
 * Policy editor. The effect names are words in the interface and wire values on
 * the way out: the option text is translated, `value=` stays allow / deny / ask.
 * The condition operators (glob / regex / equals) and `when` belong to the
 * backend DSL and are identical in both languages.
 */
export default {
  // Header
  "policy.hint":
    "This is what happens when no rule matches. “Don’t ask” is saved and stays after a restart, including commands the checker cannot read. “Deny” cannot be opened from a session. A rule you wrote still wins. A few tools keep asking until you allow that tool. Not a sandbox.",

  // Rule fields
  "policy.field.ruleId": "rule id",
  "policy.field.tool": "tool",
  "policy.field.toolHint": "bash, * or edit*",
  "policy.field.reason": "reason",
  "policy.field.reasonPlaceholder": "shown to the agent, optional",

  // Effects
  "policy.rule.effect.allow": "allow",
  "policy.rule.effect.deny": "deny",
  "policy.rule.effect.ask": "ask",

  // Actions
  "policy.action.remove": "remove",
  "policy.action.clear": "clear",
  "policy.action.save": "save policy",
  "policy.action.addRule": "add rule",

  // Conditions
  "policy.conditions.title": "conditions",
  "policy.conditions.hint": "all of them have to match",
  "policy.conditions.add": "add condition",

  // Default effect and the rule count
  "policy.default.label": "default effect",
  "policy.posture.ask": "Ask each time",
  "policy.posture.allow": "Don't ask",
  "policy.posture.deny": "Deny by default",
  "policy.rules.count.one": "{n} rule",
  "policy.rules.count.other": "{n} rules",
  "policy.rules.empty": "No rules yet. Calls nobody wrote a rule for follow the posture above; a rule you wrote still wins.",

  // Draft tester
  "policy.test.title": "test the draft",
  "policy.test.tool": "Tool",
  "policy.test.input": "Input (JSON)",
  "policy.test.hint":
    "runs the unsaved draft against a fake tool call — bash commands are split and analyzed like real permission checks",
  "policy.test.run": "run",
  "policy.test.via": " via ",

  // Notices and validation
  "policy.notice.saved": "saved — live connections pick it up immediately",
  "policy.notice.cleared": "cleared — back to asking each time",
  "policy.err.invalidJson": "input is not valid JSON",
} as const;
