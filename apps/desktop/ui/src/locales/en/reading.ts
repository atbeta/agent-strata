/** Every string the reading pane owns: thinking blocks, tool cards, payloads, JSON trees. */
export default {
  // Tool verbs. What gets translated is the word on screen, not the tool name:
  // an unknown tool falls back to the raw `call.tool` and never reaches here.
  // Bash/Read/Write stay as typed in both languages — a literal gloss of a
  // command the reader just ran is harder to recognise, not easier.
  "tool.verb.bash": "Bash",
  "tool.verb.read": "Read",
  "tool.verb.write": "Write",
  "tool.verb.edit": "Edit",
  "tool.verb.glob": "Glob",
  "tool.verb.search": "Search",
  "tool.verb.fetch": "Fetch",
  "tool.verb.plan": "Plan",

  "tool.search.in": "in {path}",
  "plan.items.one": "{n} item",
  "plan.items.other": "{n} items",

  // Durations are units, so both languages are byte-identical: `840ms`, `1.5s`, `12s`.
  "latency.ms": "{n}ms",
  "latency.s.tenth": "{n}s",
  "latency.s": "{n}s",

  "status.running": "Running",
  "status.failed": "Failed",
  "status.stopped": "Stopped",

  "tool.status.denied": "Denied",
  "tool.status.needs_permission": "Needs permission",
  "tool.output.hide": "Hide output",
  "tool.output.show": "Show output",
  "tool.running": "Running…",

  // The permission sentence is assembled per language: English puts the actor
  // after the verb with a space (`Denied by you`), Chinese puts it first and
  // tight (`你已拒绝`). Word order does not survive the split, so `permission.by`
  // is a two-slot frame each language fills its own way. `permission.reason`
  // arrives from the backend and is passed through verbatim.
  "permission.pending": "Waiting for permission",
  "permission.denied": "Denied",
  "permission.allowed": "Allowed",
  "permission.by": "{verb} by {actor}",
  "permission.with_reason": "{verb} — {reason}",
  "permission.actor.you": "you",
  "permission.actor.policy": "policy",
  "permission.actor.session": "the session",

  "transcript.thinking": "Thinking",
  "transcript.thought": "Thought",
  "transcript.image": "image",

  "payload.copy": "Copy",
  "payload.copied": "Copied",
  "payload.empty": "None",

  "json.tree.collapse": "Collapse",
  "json.tree.expand": "Expand",

  // Collapsed-container sketches. These describe data rather than chrome, so the
  // two languages are byte-identical and the preview still reads as JSON.
  "json.summary.array": "[{n}]",
  "json.summary.object": "{{shown}}",
  "json.summary.object.truncated": "{{shown}, …}",
  "json.summary.object.empty": "{}",
} as const;
