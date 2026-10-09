/** 读会话这一屏的所有文案：思考块、工具调用卡、载荷框和 JSON 树。 */
export default {
  // 工具动词。翻译的是"显示用的那个词"，不是工具本身的名字——未知工具
  // 走的是原样回显 `call.tool`，那条路径不经过这里。Bash/Read/Write 这类
  // 词在中文界面里仍然是读者天天敲的术语，硬译反而更难认。
  "tool.verb.bash": "Bash",
  "tool.verb.read": "Read",
  "tool.verb.write": "Write",
  "tool.verb.edit": "Edit",
  "tool.verb.glob": "Glob",
  "tool.verb.search": "Search",
  "tool.verb.fetch": "Fetch",
  "tool.verb.plan": "计划",

  "tool.search.in": "在 {path} 中",
  "plan.items.one": "{n} 项",
  "plan.items.other": "{n} 项",

  // 耗时是单位，两种语言必须一模一样：`840ms`、`1.5s`、`12s`。
  "latency.ms": "{n}ms",
  "latency.s.tenth": "{n}s",
  "latency.s": "{n}s",

  "status.running": "运行中",
  "status.failed": "失败",
  "status.stopped": "已停止",

  "tool.status.denied": "已拒绝",
  "tool.status.needs_permission": "需要授权",
  "tool.output.hide": "隐藏输出",
  "tool.output.show": "显示输出",
  "tool.running": "运行中…",

  // 授权这句话按语言拼：英文是 `Denied by you`（动词在前，中间还要一个
  // 空格），中文是 `你已拒绝`（人在前，动词紧贴，中间不能有空格）。语序不
  // 通用，所以 `permission.by` 是个有两个槽位的框架，两种语言各自决定怎么
  // 排；动词和人名先分别查出来，再一起填进去。`permission.reason` 来自
  // 后端，原样透传，不翻译。
  "permission.pending": "等待授权",
  "permission.denied": "已拒绝",
  "permission.allowed": "已允许",
  "permission.by": "{actor}{verb}",
  "permission.with_reason": "{verb} — {reason}",
  "permission.actor.you": "你",
  "permission.actor.policy": "策略",
  "permission.actor.session": "本会话",

  "transcript.thinking": "思考中",
  "transcript.thought": "思考",
  "transcript.image": "图片",

  "payload.copy": "复制",
  "payload.copied": "已复制",
  "payload.empty": "无",

  "json.tree.collapse": "折叠",
  "json.tree.expand": "展开",

  // 折叠后的容器摘要。它是在描述数据而不是界面，所以两种语言逐字节相同，
  // 免得读起来不像 JSON 了。
  "json.summary.array": "[{n}]",
  "json.summary.object": "{{shown}}",
  "json.summary.object.truncated": "{{shown}, …}",
  "json.summary.object.empty": "{}",
} as const;
