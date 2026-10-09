/**
 * The open session: header, in-session search, composer, permission prompts and
 * the files/plan rail.
 */
export default {
  // Cross-cutting, also used by other slices.
  "path.root": "Root",

  // The agent asking the reader something.
  "question.err.answer_each": "answer each question",
  "question.placeholder.custom": "or type your own",
  "question.reply": "reply",
  "question.dismiss": "dismiss",

  // A permission request sitting above the composer.
  "permission.wants_to_run": "wants to run",
  "permission.allow": "allow",
  "permission.deny": "deny",

  // Errors that reach the reader from the network layer.
  "err.service": "service {status}",
  "err.network": "network error",
  "err.abort": "abort failed",

  // Header.
  "session.untitled": "untitled session",
  "session.service_unreachable": "Can't reach the strata service.",
  "session.empty": "Empty session. Write a prompt to start.",
  "header.cost.tip": "{amount} so far — open the context ring for the breakdown",
  "header.export": "Export transcript",

  // The replay / trace toggle, which is one control with two labels.
  "trace.replay": "Replay",
  "trace.live": "Back to live",

  // In-session search. This is what windowing the transcript took away.
  "session.search.tip": "Search this session — {shortcut}",
  "session.search.label": "Search session",
  "session.search.placeholder": "Search this session",
  "session.search.counter.none": "none",
  "session.search.prev": "Previous match",
  "session.search.next": "Next match",
  "session.search.empty": "Nothing in this session matches.",
  "session.search.turn": "turn #{n}",

  // The files / plan rail.
  "rail.show": "Files and plan",
  "rail.hide": "Hide files",
  "rail.running": "Running",
  "rail.done": "Done",
  "rail.plan": "Plan",
  "rail.files.one": "1 file",
  "rail.files.other": "{n} files",
  "rail.nothing": "Nothing changed yet.",

  // How a file changed.
  "file.added": "added",
  "file.deleted": "deleted",
  "file.edited": "edited",

  // Reviewing a change, not just listing that one happened.
  "file.changes.one": "1 change",
  "file.changes.other": "{n} changes",
  "file.whole": "whole file",
  "file.region": "region",
  "file.jump": "Jump to this change",
  "file.close": "Close",
  "file.noDiff": "This change has no readable text. Usually a shell command, so there is no before and after to show.",
  "file.partial": "some changes cannot be shown, so the line counts are a lower bound",
  "file.hidden.one": "1 more change has nothing to show",
  "file.hidden.other": "{n} more changes have nothing to show",
  "file.lines": "+{add} −{del}",

  // Composer.
  "composer.queued.one": "Queued",
  "composer.queued.other": "{n} queued",
  "composer.edit": "Edit",
  "composer.remove_queued": "Remove queued message",
  "composer.placeholder.queue": "Queue a follow-up…",
  "composer.placeholder.message": "Message…",
  "composer.running": "Running",
  "composer.stopping": "Stopping…",
  "composer.stopping_aria": "Stopping",
  "composer.stop": "Stop",
  "composer.send": "Send",
  "composer.type": "Type a message",
  "composer.details": "Session details",

  // Pickers above the composer.
  "picker.model": "Model",
  "picker.effort": "Thinking effort",
  "picker.default": "Default",
  "picker.agent": "Agent",

  // The context popover.
  "info.session": "Session",
  "info.context": "Context",
  "info.context.none": "no usage reported",
  "info.context.of": "of {n}",
  "info.model": "Model",
  "info.cost": "Cost",
  "info.input": "Input",
  "info.output": "Output",
  "info.reasoning": "Reasoning",
  "info.cache_read": "Cache read",
  "info.tool_calls": "Tool calls",
  "info.tool_calls.failed": "{n} failed",
  "info.status": "Status",
  "info.backend": "Backend",
  "info.workspace": "Workspace",

  // Context label on the ring trigger.
  "context.none": "{n} tokens in context",
  "context.percent": "{percent}% of context · {n} tokens",
} as const;