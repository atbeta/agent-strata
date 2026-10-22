/**
 * 策略编辑器。效果名既是界面词也是传给后端的取值：界面上要翻译，`value=` 里仍是
 * allow / deny / ask。条件运算符（glob / regex / equals）和 when 是后端 DSL 的
 * 字面词，两种语言下都保持原样。
 */
export default {
  // 页头
  "policy.hint":
    "建议性权限规则 —— 命中的规则中 拒绝 > 询问 > 允许，没有命中则回退到默认效果。这不是沙箱。",

  // 规则卡字段
  "policy.field.ruleId": "规则 ID",
  "policy.field.tool": "工具",
  "policy.field.toolHint": "bash、* 或 edit*",
  "policy.field.reason": "原因",
  "policy.field.reasonPlaceholder": "给智能体看的说明，可选",

  // 效果
  "policy.rule.effect.allow": "允许",
  "policy.rule.effect.deny": "拒绝",
  "policy.rule.effect.ask": "询问",

  // 操作
  "policy.action.remove": "移除",
  "policy.action.clear": "清空",
  "policy.action.save": "保存策略",
  "policy.action.addRule": "添加规则",

  // 条件
  "policy.conditions.title": "条件",
  "policy.conditions.hint": "要全部匹配才命中",
  "policy.conditions.add": "添加条件",

  // 默认效果与计数
  "policy.default.label": "默认效果",
  "policy.rules.count.one": "{n} 条规则",
  "policy.rules.count.other": "{n} 条规则",
  "policy.rules.empty": "还没有规则，所有调用都按默认效果处理。",

  // 草稿测试
  "policy.test.title": "测试草稿",
  "policy.test.tool": "工具",
  "policy.test.input": "输入（JSON）",
  "policy.test.hint":
    "用一次模拟的工具调用测试未保存的草稿 —— bash 命令会像真实的权限检查那样被拆分并分析",
  "policy.test.run": "运行",
  "policy.test.via": "来自规则 ",

  // 提示与校验
  "policy.notice.saved": "已保存 —— 实时连接会立即生效",
  "policy.notice.cleared": "已清空 —— 全部回退为询问",
  "policy.err.invalidJson": "输入不是有效的 JSON",
} as const;
