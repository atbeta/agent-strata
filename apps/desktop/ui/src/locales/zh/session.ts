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

  // A permission request sitting above the composer.
  "permission.wants_to_run": "请求执行",
  "permission.allow": "允许",
  "permission.deny": "拒绝",

  // Errors that reach the reader from the network layer.
  "err.service": "服务返回 {status}",
  "err.network": "网络错误",
  "err.abort": "中止失败",

  // Header.
  "session.untitled": "未命名会话",
  "session.service_unreachable": "无法连接到 strata 服务。",
  "session.empty": "空会话。写一条消息开始。",
  "header.cost.tip": "已花费 {amount} — 打开上下文环查看明细",
  "header.export": "导出会话记录",

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

  // The files / plan rail.
  "rail.show": "文件与计划",
  "rail.hide": "隐藏文件",
  "rail.running": "运行中",
  "rail.done": "完成",
  "rail.plan": "计划",
  "rail.files.one": "1 个文件",
  "rail.files.other": "{n} 个文件",
  "rail.nothing": "尚无改动。",

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
  "composer.details": "会话详情",

  // Pickers above the composer.
  "picker.model": "模型",
  "picker.effort": "思考强度",
  "picker.default": "默认",
  "picker.agent": "智能体",

  // The context popover.
  "info.session": "会话",
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

  // Context label on the ring trigger.
  "context.none": "上下文中 {n} tokens",
  "context.percent": "上下文 {percent}% · {n} tokens",
} as const;