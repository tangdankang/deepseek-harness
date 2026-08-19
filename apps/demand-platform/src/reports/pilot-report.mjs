function percent(value) {
  return `${(Number(value ?? 0) * 100).toFixed(1)}%`;
}

function rows(record = {}) {
  const entries = Object.entries(record);
  return entries.length ? entries.map(([key, value]) => `| ${key} | ${value} |`).join("\n") : "| 暂无数据 | 0 |";
}

export function formatPilotReport(metrics) {
  return `# AI统一需求平台试点指标周报

生成时间：${metrics.window.generatedAt}

统计窗口：最近 ${metrics.window.days} 天（自 ${metrics.window.since}）

## 核心指标

| 指标 | 数值 |
|---|---:|
| 有效交互 | ${metrics.interactions.total} |
| 使用员工（去标识计数） | ${metrics.interactions.uniqueEmployees} |
| 统一需求 | ${metrics.demands.total} |
| 下游工单 | ${metrics.demands.externalTickets} |
| 人工受理 | ${metrics.handoffs.total} |
| 员工反馈 | ${metrics.feedback?.total ?? 0} |
| 员工确认解决 | ${metrics.feedback?.resolvedCount ?? 0} |
| 平均满意度 | ${metrics.feedback?.averageRating ?? "—"} / 5 |
| 知识回答占比 | ${percent(metrics.indicators.answerRate)} |
| 服务推荐占比 | ${percent(metrics.indicators.serviceSuggestionRate)} |
| 建议转人工占比 | ${percent(metrics.indicators.handoffSuggestionRate)} |
| 需求创建/交互 | ${percent(metrics.indicators.demandCreationRate)} |
| 下游建单/需求 | ${percent(metrics.indicators.externalTicketRate)} |
| 已确认人工受理/建议转人工 | ${percent(metrics.indicators.confirmedHandoffRate)} |
| 反馈响应率 | ${percent(metrics.indicators.feedbackResponseRate)} |
| 员工确认解决率（反馈样本） | ${percent(metrics.indicators.employeeConfirmedResolutionRate)} |
| 满意评价率（4—5分） | ${percent(metrics.indicators.positiveRatingRate)} |
| 终态集成任务成功率 | ${percent(metrics.indicators.integrationTerminalSuccessRate)} |

## AI响应类型

| 类型 | 数量 |
|---|---:|
${rows(metrics.interactions.byType)}

## 需求状态

| 状态 | 数量 |
|---|---:|
${rows(metrics.demands.byStatus)}

## 服务分布

| 服务编码 | 数量 |
|---|---:|
${rows(metrics.demands.byService)}

## 人工受理状态

| 状态 | 数量 |
|---|---:|
${rows(metrics.handoffs.byStatus)}

## 集成任务状态

| 状态 | 数量 |
|---|---:|
${rows(metrics.integrations?.byStatus)}

## 反馈原因

| 原因编码 | 数量 |
|---|---:|
${rows(metrics.feedback?.byReasonCode)}

## 解释与待补指标

- “知识回答占比”仅表示 Agent 返回了有来源答案，不等同于员工确认已解决。
- 满意度和确认解决率只基于主动反馈样本，必须同时查看反馈响应率，避免把低响应样本外推到全体员工。
- 当前未纳入人工节省时长和真实业务处理时长；接入基线与真实工单时间后再计算。
- 指标只用于趋势和试点门禁，应同时抽样复核路由、答案和失败案例。
- 交互明细不保存原始问句；员工标识使用密钥化哈希进行去标识计数。
`;
}
