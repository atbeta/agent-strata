/**
 * Shell chrome: the window caption, the sidebar and its project filter, command
 * search, the settings page, and the routes between them. The key set is fixed
 * by `../zh`; only the text here is English.
 */
export default {
  // Window caption
  "window.caption.minimize": "Minimize",
  "window.caption.maximize": "Maximize",
  "window.caption.restore": "Restore",
  "window.caption.close": "Close",

  // Projects
  "project.root": "Root",
  "project.rootHint": "filesystem root",
  "sidebar.project.label": "Project",
  "sidebar.project.all": "All projects",
  "sidebar.project.allHint": "Every directory on this connection",
  "sidebar.project.none": "No project",
  "sidebar.project.openDirectory": "Open directory",

  // Session rows
  "common.untitled": "untitled",
  "sidebar.session.actions": "Session actions",
  "sidebar.session.rename": "Rename",
  "sidebar.session.archive": "Archive",
  "sidebar.session.delete": "Delete",
  "sidebar.session.deleteArmed": "Click again to delete",
  "sidebar.sessionCount.one": "{n} session",
  "sidebar.sessionCount.other": "{n} sessions",

  // Sidebar empty state
  "sidebar.empty.inProject": "No sessions in this project yet.",
  "sidebar.empty.needBackend": "Connect a backend to see sessions.",

  // Backends
  "sidebar.backend.none": "No backend",
  "action.newSession": "New session",
  "action.connectBackend": "Connect a backend",
  "action.connect": "Connect",
  "action.connecting": "Connecting…",
  "action.closeConnect": "Close connect",
  "connect.form.name": "name",
  "connect.form.user": "user",
  "connect.form.password": "password",

  // Compare
  "sidebar.compare.pick": "Pick {n} more",
  "sidebar.compare.open": "Open",
  "sidebar.compare.openTip": "Open the comparison",
  "sidebar.compare.start": "Compare two sessions",
  "sidebar.compare.cancel": "Cancel compare",

  // Overflow menu
  "sidebar.menu.more": "More",
  "sidebar.menu.disconnect": "Disconnect {host}",

  // Routes
  "nav.backToFleet": "← fleet",
  "nav.compare": "Compare",
  "nav.policy": "Policy",

  // Fleet page
  "fleet.topbar.countAll.one": "{n} session",
  "fleet.topbar.countAll.other": "{n} sessions",
  "fleet.topbar.countInProject": "{n} in this project",
  "fleet.title.pickSession": "Pick a session",
  "fleet.hint.connected": "Sessions already on the server show up in the sidebar. New ones start with +.",
  "fleet.hint.disconnected":
    "Attach a running agent server. Sessions already on it show up as soon as the stream connects.",

  // Time
  "time.now": "now",
  "time.today": "Today",
  "time.yesterday": "Yesterday",
  "time.week": "Previous 7 days",
  "time.older": "Older",

  // Failures
  "error.serviceUnreachable": "Can't reach the strata service",
  "error.createSession": "could not create a session",

  // Command search
  "search.label": "Search",
  "search.placeholder": "Sessions and transcripts",
  "search.hint": "Search every session and its transcript.",
  "search.searching": "Searching…",
  "search.noMatches": "No matches",
  "search.results.sessions": "Sessions",
  "search.results.transcript": "Transcript",

  // Settings
  "settings.title": "Settings",
  "settings.savedHere": "Saved on this computer.",
  "settings.appearance": "Appearance",
  "settings.language": "Language",
  "settings.language.hint": "The interface language. Takes effect immediately, no restart.",
  "settings.theme": "Theme",
  "settings.theme.dark": "Dark",
  "settings.theme.darkHint": "The default shell",
  "settings.theme.light": "Light",
  "settings.theme.lightHint": "A paper surface",
  "settings.theme.system": "System",
  "settings.theme.systemHint": "Follow this computer",
  "settings.permission.title": "Permission policy",
  "settings.permission.hint": "Rules that allow, ask, or deny a tool call before it runs.",
  "settings.permission.open": "Open policy",
} as const;
