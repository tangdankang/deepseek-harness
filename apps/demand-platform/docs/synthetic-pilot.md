# 多员工合成试点

合成试点在真实 HTTP 边界模拟 20–500 名员工和至少两个部门，用于在真人试点前验证并发、身份隔离、写入幂等和基础延迟。报告不保存员工编号、业务字段、密钥、确认令牌或目标地址。

## 只读模式

默认模拟 50 名员工并发调用员工上下文、服务目录和知识检索，不产生需求、工单、人工事项或反馈：

```powershell
$env:TOOL_API_KEY='<公司安全通道注入>'
$env:IDENTITY_HMAC_SECRET='<公司安全通道注入>'
node scripts\run-synthetic-pilot.mjs `
  --base-url https://test-ai-demand.example.internal `
  --employees 50 --concurrency 10 `
  --departments D-PILOT-A,D-PILOT-B `
  --output-json work\synthetic-readonly.json `
  --output-markdown work\synthetic-readonly.md
```

## 全量模式

全量模式会真实创建测试需求、下游工单、人工受理和反馈。必须明确提供 `--allow-write`、服务编号、脱敏字段文件；远程环境还需 `--allow-remote-write`。

```powershell
node scripts\run-synthetic-pilot.mjs `
  --base-url https://test-ai-demand.example.internal `
  --allow-write --allow-remote-write `
  --employees 50 --write-employees 20 --concurrency 10 `
  --service-code CRM_ACCOUNT_CHANGE `
  --fields-file approved\synthetic-fields.json `
  --thresholds-file config\synthetic-pilot-thresholds.example.json `
  --output-json approved\synthetic-pilot.json `
  --output-markdown approved\synthetic-pilot.md
```

## 默认技术门槛

| 项目 | 默认值 |
|---|---:|
| HTTP错误率 | 0 |
| 总体P95 | ≤2000ms |
| 跨员工越权拒绝率 | 100% |
| 同幂等键重放确认率 | 100% |
| 重复下游工单发现 | 0 |

每个写入员工都会创建一条需求，使用同一业务幂等键重复提交，核对返回同一工单；再由另一名员工查询该需求，必须返回资源不可见；最后创建人工事项并提交结构化反馈。

## 纳入 Go/No-Go

门禁脚本读取报告而不是相信手工布尔值：

```powershell
node scripts\evaluate-pilot-gate.mjs `
  --endpoint https://test-ai-demand.example.internal `
  --evidence approved\pilot-gate-evidence.json `
  --synthetic-report approved\synthetic-pilot.json
```

报告至少需要 20 名员工、2 个部门、10 名写入员工和 100 次 HTTP 调用，全部技术断言通过。合成试点不能证明答案正确、路由准确、员工满意、钉钉视觉体验或真实下游容量，也不能替代真人试点、回滚演练和业务/安全/运维签字。
