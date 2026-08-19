# 试点指标与周报

平台在员工调用 AI 入口时记录以下最小统计字段：员工标识 HMAC、部门、会话编号、响应类型、消息 SHA-256、消息长度、引用数、推荐服务编码、traceId 和时间。不会在分析表中保存原始问句。员工可对本人真实会话、需求或人工事项提交结构化反馈，平台不接受自由文本反馈。

人工受理记录因履行服务需要保存员工身份和原始事项，只允许本人及受保护的运营接口访问，并应遵守公司留存与脱敏制度。

## 指标接口

```text
GET /api/v1/admin/metrics?days=7
X-Admin-Key: <运营管理密钥>
```

返回交互、去标识员工数、需求、下游工单、人工受理、集成任务、分类型/状态/服务数量及基础比率。管理密钥必须与 DEAP 工具密钥分离。`RETRY_WAIT` 和 `DEAD` 应作为试点日常告警指标。

## 生成Markdown周报

```powershell
$env:ADMIN_API_KEY='<从公司密钥系统注入>'
node scripts/generate-pilot-report.mjs `
  --endpoint http://127.0.0.1:8787 `
  --days 7 `
  --format markdown
```

命令只把报告输出到标准输出，不会自动写文件或发送消息。实际试点可由受控流水线重定向到报告存储。

员工确认解决率和满意度只基于主动反馈样本，周报同时展示反馈响应率，不能将小样本直接外推。节省时长和真实业务处理时长仍需在公司基线与下游时间字段接入后补充。

## Go / No-Go 门禁

将安全测试、关键评测、路由准确率、重复工单核验、视觉验收、回滚演练和三方签字填入 `config/pilot-gate-evidence.example.json` 的副本，然后运行：

```powershell
$env:ADMIN_API_KEY='<从公司密钥系统注入>'
node scripts/evaluate-pilot-gate.mjs `
  --endpoint http://127.0.0.1:8787 `
  --evidence approved/pilot-gate-evidence.json `
  --synthetic-report approved/synthetic-pilot.json `
  --days 7 `
  --format markdown
```

门禁结论有三种：`GO`、`NO_GO`、`NOT_READY`。缺人工证据时只能是 `NOT_READY`；任一指标或证据失败为 `NO_GO`。命令以退出码 0/2/3 分别表示 GO/NO_GO/NOT_READY，便于接入发布流水线。

合成试点使用真实 HTTP 和平台工具契约模拟多部门员工，结果用于技术预检，不进入员工满意度、答案质量和真实路由准确率统计。详细口径见 `docs/synthetic-pilot.md`。
