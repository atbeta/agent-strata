/**
 * 观察类界面：追踪条与详情抽屉、会话对比，以及 api 层回传给各处的状态与错误
 * 文案。事件类型、工具名、模型 id 与会话自身内容一律原样显示，不在此翻译。
 */
export default {
  // 追踪条泳道
  "trace.lane.input": "输入",
  "trace.lane.reply": "回复",
  "trace.lane.tool": "工具",

  // 标题与预览的兜底词（事件本身没带内容时）
  "trace.preview.message": "消息",
  "trace.preview.reply": "回复",
  "trace.title.tool": "工具",

  // 详情抽屉
  "trace.tab.overview": "概述",
  "trace.tab.input": "参数",
  "trace.tab.result": "结果",
  "trace.tab.time": "计时",
  "trace.action.close": "关闭",
  "trace.section.result": "结果",
  "trace.section.input": "输入",
  "trace.field.started": "开始",
  "trace.field.elapsed": "耗时",
  "trace.empty": "无",

  // 会话对比
  "compare.title": "对比两个会话",
  "compare.loading": "加载中…",
  "compare.vs": "对比",
  "compare.turn": "第 {n} 轮",
  "compare.samePrompt": "相同提问",
  "compare.totals.tools.one": "{n} 个工具",
  "compare.totals.tools.other": "{n} 个工具",
  "compare.summary.turnPairs.one": "{n} 组轮次",
  "compare.summary.turnPairs.other": "{n} 组轮次",
  "compare.summary.samePrompt.one": "{n} 条相同提问",
  "compare.summary.samePrompt.other": "{n} 条相同提问",
  "compare.delta.total": "Δ 合计：",

  // api 层：状态词与失败原因
  "api.status.active": "运行中",
  "api.status.completed": "已完成",
  "api.status.error": "错误",
  "api.status.cancelled": "已停止",
  "api.err.service": "服务返回 {status}",
} as const;
