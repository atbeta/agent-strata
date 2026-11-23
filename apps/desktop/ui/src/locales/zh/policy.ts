/**
 * 策略编辑器。效果名既是界面词也是传给后端的取值：界面上要翻译，`value=` 里仍是
 * allow / deny / ask。条件运算符（glob / regex / equals）和 when 是后端 DSL 的
 * 字面词，两种语言下都保持原样。
 */
export default {
  "policy.hint": "决定未命中规则时如何处理工具调用。自定义规则优先；这不是沙箱。",
  "policy.loading": "正在读取权限策略…",

  "policy.default.label": "默认效果",
  "policy.posture.ask": "逐项确认",
  "policy.posture.allow": "不再询问",
  "policy.posture.deny": "默认拒绝",
  "policy.posture.ask.hint": "未命中规则时，每次调用前都询问。",
  "policy.posture.allow.hint": "未命中规则时尽量允许，包括看不懂的命令；个别工具仍会询问，直到为它写一条允许。",
  "policy.posture.deny.hint": "未命中规则时直接拒绝，不能在会话里临时放开。",

  "policy.rules.title": "自定义规则",
  "policy.rules.count.one": "{n} 条规则",
  "policy.rules.count.other": "{n} 条规则",
  "policy.rules.emptyTitle": "还没有自定义规则",
  "policy.rules.empty": "当前只使用默认效果。需要固定允许或拒绝某类工具时，再添加规则。",

  "policy.field.ruleId": "规则 ID",
  "policy.field.tool": "工具",
  "policy.field.toolHint": "bash、* 或 edit*",
  "policy.field.reason": "原因",
  "policy.field.reasonPlaceholder": "给智能体看的说明，可选",
  "policy.rule.effect.allow": "允许",
  "policy.rule.effect.deny": "拒绝",
  "policy.rule.effect.ask": "询问",

  "policy.conditions.title": "条件",
  "policy.conditions.hint": "要全部匹配才命中",
  "policy.conditions.add": "添加条件",

  "policy.action.remove": "移除",
  "policy.action.clear": "清空规则",
  "policy.action.clearing": "正在清空…",
  "policy.action.save": "保存策略",
  "policy.action.saving": "正在保存…",
  "policy.action.addRule": "添加规则",

  "policy.test.title": "验证规则",
  "policy.test.tool": "工具",
  "policy.test.input": "输入（JSON）",
  "policy.test.hint": "用模拟调用检查未保存的草稿，不会执行工具。",
  "policy.test.run": "运行",
  "policy.test.via": "来自规则 ",

  "policy.advanced.title": "高级设置",
  "policy.advanced.hint": "配置文件与危险操作",
  "policy.file.title": "配置文件",
  "policy.file.hint": "用于手工编辑或排查问题；通常无需打开。",
  "policy.file.copy": "复制路径",
  "policy.file.copied": "已复制",
  "policy.danger.title": "重置权限策略",
  "policy.danger.hint": "删除全部自定义规则，并恢复为逐项确认。",
  "policy.clear.title": "清空全部规则？",
  "policy.clear.description": "这会删除全部自定义规则，并将默认效果恢复为“逐项确认”。此操作无法撤销。",
  "policy.dirty": "有未保存的更改",

  "policy.notice.saved": "已保存，实时连接会立即生效",
  "policy.notice.cleared": "已清空，恢复为逐项确认",
  "policy.err.invalidJson": "输入不是有效的 JSON",
} as const;
