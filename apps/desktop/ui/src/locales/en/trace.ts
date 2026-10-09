/**
 * Observation surfaces: the trace strip and drawer, the compare view, and the
 * status/error strings the api layer hands back to every screen. Event types,
 * tool names, model ids and a session's own content stay verbatim.
 */
export default {
  // Trace strip lanes
  "trace.lane.input": "Input",
  "trace.lane.reply": "Reply",
  "trace.lane.tool": "Tool",

  // Fallback words for a title or preview the event did not carry
  "trace.preview.message": "Message",
  "trace.preview.reply": "Reply",
  "trace.title.tool": "Tool",

  // Trace drawer
  "trace.tab.overview": "Overview",
  "trace.tab.input": "Parameters",
  "trace.tab.result": "Result",
  "trace.tab.time": "Timing",
  "trace.action.close": "Close",
  "trace.section.result": "Result",
  "trace.section.input": "Input",
  "trace.field.started": "Started",
  "trace.field.elapsed": "Elapsed",
  "trace.empty": "None",

  // Compare
  "compare.title": "Compare two sessions",
  "compare.loading": "Loading…",
  "compare.vs": "vs",
  "compare.turn": "Turn {n}",
  "compare.samePrompt": "Same prompt",
  "compare.totals.tools.one": "{n} tool",
  "compare.totals.tools.other": "{n} tools",
  "compare.summary.turnPairs.one": "{n} turn pair",
  "compare.summary.turnPairs.other": "{n} turn pairs",
  "compare.summary.samePrompt.one": "{n} same-prompt",
  "compare.summary.samePrompt.other": "{n} same-prompt",
  "compare.delta.total": "Δ total:",

  // api layer: status words and the reason a call failed
  "api.status.active": "running",
  "api.status.completed": "done",
  "api.status.error": "error",
  "api.status.cancelled": "stopped",
  "api.err.service": "service returned {status}",
} as const;
