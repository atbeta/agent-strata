/**
 * Shell chrome: the window caption, the sidebar and its project filter, command
 * search, the settings page, and the routes between them. Nothing in here
 * describes a session's own content — titles, paths, model ids and event text
 * come from the backends and are shown as they arrive.
 */
export default {
  // Window caption
  "window.caption.minimize": "最小化",
  "window.caption.maximize": "最大化",
  "window.caption.restore": "还原",
  "window.caption.close": "关闭",

  // Projects
  "project.root": "根目录",
  "project.rootHint": "文件系统根目录",
  "sidebar.project.label": "项目",
  "sidebar.project.all": "全部项目",
  "sidebar.project.allHint": "此连接上的全部目录",
  "sidebar.project.none": "无项目",
  "sidebar.project.openDirectory": "打开目录",

  // Session rows
  "common.untitled": "未命名",
  "sidebar.session.actions": "会话操作",
  "sidebar.session.rename": "重命名",
  "sidebar.session.archive": "归档",
  "sidebar.session.delete": "删除",
  "sidebar.session.deleteArmed": "再次点击以删除",
  "sidebar.sessionCount.one": "{n} 个会话",
  "sidebar.sessionCount.other": "{n} 个会话",

  // Sidebar empty state
  "sidebar.empty.inProject": "此项目中还没有会话。",
  "sidebar.empty.needBackend": "连接后端后即可看到会话。",

  // Backends
  "sidebar.backend.none": "未连接后端",
  "action.newSession": "新建会话",
  "action.connectBackend": "连接后端",
  "action.connect": "连接",
  "action.connecting": "连接中…",
  "action.closeConnect": "关闭连接",
  "connect.form.name": "名称",
  "connect.form.user": "用户名",
  "connect.form.password": "密码",
  "connect.kind.opencode": "OpenCode 服务",
  "connect.kind.acp": "ACP 代理",
  "connect.form.command": "启动命令，如 opencode acp",
  "sidebar.backend.newTarget": "新会话",

  // Compare
  "sidebar.compare.pick": "还需选择 {n} 个会话",
  "sidebar.compare.open": "打开对比",
  "sidebar.compare.openTip": "打开对比视图",
  "sidebar.compare.start": "对比两个会话",
  "sidebar.compare.cancel": "取消对比",

  // Overflow menu
  "sidebar.menu.more": "更多",
  "sidebar.menu.disconnect": "断开 {host}",

  // Routes
  "nav.backToFleet": "← 会话列表",
  "nav.compare": "对比",
  "nav.policy": "策略",

  // Fleet page
  "fleet.topbar.countAll.one": "{n} 个会话",
  "fleet.topbar.countAll.other": "{n} 个会话",
  "fleet.topbar.countInProject": "本项目 {n} 个会话",
  "fleet.title.pickSession": "选择一个会话",
  "fleet.hint.connected": "服务器上已有的会话会显示在侧边栏。新会话以 + 开始。",
  "fleet.hint.disconnected": "接入正在运行的代理服务器。服务器上的会话会在数据流连接后立即显示。",

  // Time
  "time.now": "刚刚",
  "time.today": "今天",
  "time.yesterday": "昨天",
  "time.week": "7 天内",
  "time.older": "更早",

  // Failures
  "error.serviceUnreachable": "无法连接到 strata 服务",
  "error.createSession": "无法创建会话",

  // Command search
  "search.label": "搜索",
  "search.placeholder": "会话与会话记录",
  "search.hint": "搜索所有会话及其记录。",
  "search.searching": "搜索中…",
  "search.noMatches": "没有匹配结果",
  "search.results.sessions": "会话",
  "search.results.transcript": "会话记录",

  // Settings
  "settings.title": "设置",
  "settings.savedHere": "保存在此电脑上。",
  "settings.appearance": "外观",
  "settings.language": "语言",
  "settings.language.hint": "界面语言。切换后立即生效，无需重启。",
  "settings.theme": "主题",
  "settings.theme.dark": "深色",
  "settings.theme.darkHint": "默认界面",
  "settings.theme.light": "浅色",
  "settings.theme.lightHint": "纸质界面",
  "settings.theme.system": "跟随系统",
  "settings.theme.systemHint": "跟随本机设置",
  "settings.permission.title": "权限策略",
  "settings.permission.hint": "在工具调用运行前，允许、询问或拒绝它的规则。",
  "settings.permission.open": "打开策略",
} as const;
