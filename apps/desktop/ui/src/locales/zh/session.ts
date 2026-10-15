/**
 * The open session: header, in-session search, composer, permission prompts and
 * the files/plan rail.
 */
export default {
  // Cross-cutting, also used by other slices.
  "path.root": "根目录",

  // The agent asking the reader something.
  "question.err.answer_each": "请回答每一个问题",
  "question.placeholder.custom": "或输入自定义回答",
  "question.reply": "回复",
  "question.dismiss": "忽略",

  // A prompt whose payload is malformed. The agent still holds its turn and
  // still expects an answer, so this cannot be a silent drop — it has to be
  // visible, and it has to be dismissible so it cannot pin the dock open.
  "question.unreadable": "这条提问读不出来。",
  "question.unreadable_hint":
    "服务返回的这条提问缺少内容，无法作答。可以先忽略它，再让会话继续。",

  // How a session is doing, as the sidebar and the fleet list both draw it.
  // Three dictionaries used to say the same two words three ways — 待处理 /
  // Needs you here, 进行中 / Running there, 运行中 / running in the API layer —
  // so one list could call the same session 待处理 and the next one 进行中 for
  // states that are not the same. These five are the whole vocabulary now.
  "session.status.needsInput": "待处理",
  "session.status.running": "进行中",
  "session.status.failed": "失败",
  "session.status.stopped": "已停止",
  "session.status.done": "已完成",
  "session.status.idle": "空闲",

  // A permission request sitting above the composer.
  "permission.wants_to_run": "等待确认",
  "permission.allow": "允许",
  "permission.once": "仅此一次",
  "permission.always": "始终允许",
  "permission.deny": "拒绝",

  // Errors that reach the reader from the network layer.
  "err.service": "服务返回 {status}",
  "err.network": "网络错误",
  "err.send": "没能发出去，输入还在",
  "err.abort": "中止失败",

  // Header.
  "session.untitled": "未命名会话",
  "session.child.open": "打开子会话",
  "session.child.back": "返回上级会话",
  "session.service_unreachable": "无法连接到 strata 服务。",
  "session.retry": "重试",
  "session.service_unreachable_hint": "服务就绪后会自动重试，也可以手动重试一次。",
  // A prompt that will not load is worse than one that is visibly absent: the
  // agent is still waiting for an answer nobody can see, and the session reads
  // as stuck rather than broken. The name has to say which thing failed.
  "prompt.load_failed": "没能加载待处理的提问。",
  "prompt.load_failed_hint": "服务正在等你的回答。重新加载一次；如果这里本来就是空的，那说明这条会话没有待处理的提问。",
  "session.empty": "空会话。写一条消息开始。",
  "session.empty_hint": "这个会话还没有任何对话。",
  "header.cost.tip": "已花费 {amount} — 打开上下文环查看明细",
  "header.export": "导出会话记录",
  "header.branch.tip": "当前 Git 分支：{branch}",
  "header.tools": "MCP",
  "header.more": "更多会话操作",
  "mcp.title": "MCP",
  "mcp.empty": "没有 MCP 服务器",
  "mcp.connect": "连接",
  "mcp.disconnect": "断开",
  "mcp.connecting": "正在连接",
  "mcp.disconnecting": "正在断开",
  "mcp.unchanged": "状态没有变化",
  "mcp.status.connected": "已连接",
  "mcp.status.disabled": "已停用",
  "mcp.status.failed": "失败",
  "mcp.status.needs_auth": "需要登录",
  "mcp.status.needs_client_registration": "需要注册",
  "mcp.add": "添加服务器",
  "mcp.add.name": "名称",
  "mcp.add.command": "本地命令",
  "mcp.add.url": "远程地址",
  "mcp.add.command.placeholder": "npx -y 包名",
  "mcp.add.url.placeholder": "https://",
  "mcp.add.submit": "添加",
  "mcp.add.adding": "正在添加",
  "mcp.add.hint": "添加后会出现在这次 OpenCode 的运行里。",
  "mcp.add.failed": "没能添加这台服务器",
  "mcp.auth": "登录",
  "mcp.auth.open": "打开登录页",
  "mcp.auth.hint": "打开链接完成登录，再把授权码粘贴回来。",
  "mcp.auth.code": "授权码",
  "mcp.auth.confirm": "确认",
  "mcp.auth.cancel": "取消",
  "mcp.auth.failed": "登录没有完成",

  // The replay / trace toggle, which is one control with two labels.
  "trace.replay": "回放",
  "trace.live": "回到实时",

  // In-session search. This is what windowing the transcript took away.
  "session.search.tip": "搜索当前会话 — {shortcut}",
  "session.search.label": "搜索会话",
  "session.search.placeholder": "搜索当前会话",
  "session.search.counter.none": "无",
  "session.search.prev": "上一个匹配",
  "session.search.next": "下一个匹配",
  "session.search.empty": "当前会话没有匹配内容。",
  "session.search.turn": "第 {n} 轮",

  // The changes / files side panel, and the plan strip under the composer.
  "panel.show": "改动与文件",
  // Not "隐藏侧栏" — the sidebar has its own toggle two buttons away, and a
  // tooltip that names the wrong control sends the user to close the wrong one.
  "panel.hide": "隐藏改动与文件",
  "panel.changes": "改动",
  "panel.files": "文件",
  "rail.resize": "调整侧栏宽度",
  "rail.nothing": "尚无改动。",
  "plan.title": "计划",
  "plan.progress": "{done}/{total}",
  "plan.done": "全部完成",
  "files.pick": "选择一个文件查看。",
  "files.loading": "正在读取。",
  "files.listErr": "这一层没有读出来。",
  "files.readErr": "文件内容没有读出来。",
  "files.binary": "这是二进制文件，用编辑器打开。",
  "files.truncated": "只显示了开头一部分。",
  "files.vscode": "用 VS Code 打开",
  "status.branch": "分支 {branch}",
  "status.noBranch": "不在 Git 仓库中",
  "status.lsp": "LSP {n}",
  "status.lspErr": "LSP {n} 个异常",
  "status.mcp": "MCP {on}/{n}",
  "terminal.show": "终端",
  "terminal.hide": "隐藏终端",
  "terminal.new": "新建终端",
  "terminal.close": "关闭终端",
  "terminal.closed": "终端已断开",
  "terminal.failed": "终端打不开",
  "review.session": "本会话",
  "review.git": "未提交",
  "review.unified": "统一",
  "review.split": "并排",
  "review.layout": "排布方式",
  "review.loading": "正在读取改动。",
  "review.empty": "OpenCode 没有报告这个会话的改动。",
  "review.empty.git": "工作区是干净的，没有未提交的改动。",
  "review.comment": "把这一行放进输入框",
  "review.cite": "`{file}` 第 {line} 行：\n",
  "review.cite.removed": "`{file}` 已删除的第 {line} 行：\n",

  // How a file changed.
  "file.added": "新增",
  "file.deleted": "删除",
  "file.edited": "修改",

  // Reviewing a change, not just listing that one happened.
  "file.changes.one": "1 次",
  "file.changes.other": "{n} 次",
  "file.whole": "整文件",
  "file.region": "局部修改",
  "file.jump": "跳到这处改动",
  "file.close": "关闭",
  "file.noDiff": "这处改动没有可显示的内容。多数情况下是 shell 命令改的，我们看不到前后文本。",
  "file.partial": "有改动无法显示，行数是下限",
  "file.hidden.one": "另有 1 处改动没有可显示的内容",
  "file.hidden.other": "另有 {n} 处改动没有可显示的内容",
  "file.lines": "+{add} −{del}",

  // Composer.
  "composer.queued.one": "已排队",
  "composer.queued.other": "{n} 条排队",
  "composer.edit": "编辑",
  "composer.remove_queued": "移除排队消息",
  "composer.placeholder.queue": "添加后续消息…",
  "composer.placeholder.message": "输入消息…",
  "composer.running": "运行中",
  "composer.stopping": "停止中…",
  "composer.stopping_aria": "停止中",
  "composer.stop": "停止",
  "composer.send": "发送",
  "composer.type": "输入消息",
  "composer.queue": "加入队列",
  "composer.queue.tip": "加入队列——本轮结束后发送（Enter）",
  "composer.more": "更多选项",
  "composer.details": "会话详情",
  "composer.menu.files": "文件",
  "composer.menu.commands": "命令",
  "composer.menu.search_files": "输入文件名搜索",
  "composer.menu.no_match": "没有匹配项",
  "composer.menu.source.mcp": "MCP",
  "composer.menu.source.skill": "技能",
  "composer.attach": "添加图片或 PDF",
  "composer.attach.remove": "移除 {name}",
  "composer.attach.bad_type": "{name}：只支持图片和 PDF",
  "composer.attach.too_big": "{name} 超过 5 MB",
  "composer.attach.unreadable": "{name} 无法作为图片读取",
  "composer.attach.too_many": "最多 {n} 个附件",
  "composer.attachments.one": "1 个附件",
  "composer.attachments.other": "{n} 个附件",

  // Pickers above the composer.
  "picker.model": "模型",
  "picker.effort": "思考强度",
  "picker.default": "默认",
  "picker.agent": "智能体",
  "picker.agent.tip": "智能体（Tab 切换）",

  // The context popover.
  "info.session": "会话",
  "info.group.usage": "用量",
  "info.group.identity": "归属",
  "info.context": "上下文",
  "info.context.none": "未报告用量",
  "info.context.of": "共 {n}",
  "info.model": "模型",
  "info.cost": "花费",
  "info.input": "输入",
  "info.output": "输出",
  "info.reasoning": "推理",
  "info.cache_read": "缓存读取",
  "info.tool_calls": "工具调用",
  "info.tool_calls.failed": "{n} 个失败",
  "info.status": "状态",
  "info.backend": "后端",
  "info.workspace": "工作区",
  "info.id": "会话 ID",
  "info.id.copy": "复制会话 ID",

  // Context label on the ring trigger.
  "context.none": "上下文中 {n} tokens",
  "context.percent": "上下文 {percent}% · {n} tokens",

  // Actions on a user message, and the restore / compaction chrome around them.
  "message.copy": "复制",
  "message.copied": "已复制",
  "message.edit": "编辑",
  "message.revert": "撤回",
  "message.fork": "分叉",
  "message.restore": "恢复",
  "message.reverted": "已撤回",
  "message.compacted": "对话已压缩",

  // The prompt outline on the transcript's left edge.
  "nav.outline": "提问导航，共 {n} 条",
  "nav.turn": "第 {n} 轮",
  "nav.reverted": "已回退",
  "nav.latest": "返回最新",
  "nav.attach": "附件",
} as const;
