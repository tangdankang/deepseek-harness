# 生产就绪总门禁

本门禁把分散的工程、真实接入、试点、安全和组织审批证据汇总为一个可复验结论。空白或缺证据返回 `NOT_READY`，任何失败、篡改、过期或范围不符返回 `NO_GO`，全部通过才返回 `GO`。

`GO` 不会自动发布，也不能绕过公司变更系统。

## 必需证据

| 证据 | 最大时效 | 生产范围要求 |
|---|---:|---|
| 发布包自动验证 | 7天 | 验证PASS，密钥扫描0命中 |
| 运行拓扑验收 | 30天 | 远程只读采样至少20次，观察至少2实例、HA数据库和分布式状态能力 |
| DEAP工具联调 | 30天 | `FULL_WRITE`、远程目标、13工具无缺失 |
| 身份生命周期联调 | 30天 | `FULL_WRITE`、远程目标，覆盖停用、撤销、双通道阻断、重放、乱序和恢复，且使用已确认的专用测试员工 |
| 业务连接器验收 | 30天 | 远程目标、真实写入、无失败和跳过 |
| 员工试点 | 14天 | `REAL_EMPLOYEE`、门禁GO、无缺失 |
| 容量验证 | 30天 | 远程等价环境、开放式模型、非本地组合进程 |
| 安全评估 | 90天 | 控制Owner签署的JSON证明 |
| 备份恢复 | 30天 | 控制Owner签署的JSON证明 |
| 灾备切换 | 180天 | 控制Owner签署的JSON证明 |
| 监控告警 | 90天 | 控制Owner签署的JSON证明 |
| 数据治理 | 365天 | 控制Owner签署的JSON证明 |
| 变更与回退 | 30天 | 控制Owner签署的JSON证明 |

此外必须由业务、信息安全、运维和数据保护四个相互独立的审批人放行，审批必须绑定同一个变更单号。

## 目录结构

复制 `config/production-readiness-manifest.example.json` 到独立证据目录，证据只能使用该目录内的相对路径：

```text
production-readiness-CHG-2026-0001/
  manifest.json
  release-verification.json
  runtime-topology.json
  deap-conformance.json
  identity-lifecycle-conformance.json
  connector-acceptance.json
  real-pilot-gate.json
  remote-capacity.json
  security-attestation.json
  backup-restore-attestation.json
  disaster-recovery-attestation.json
  monitoring-attestation.json
  data-governance-attestation.json
  change-rollback-attestation.json
```

每项证据描述包含：

```json
{
  "artifact": "deap-conformance.json",
  "sha256": "64位SHA-256大写十六进制",
  "capturedAt": "2026-08-17T08:00:00.000Z",
  "result": "PASS",
  "environment": "PRODUCTION"
}
```

人工控制证明必须是UTF-8 JSON：

```json
{
  "reportType": "PRODUCTION_MANUAL_ATTESTATION",
  "result": "PASS",
  "controlOwnerHash": "控制Owner身份的64位SHA-256/HMAC哈希",
  "summary": "说明验证范围、结果和阻断项关闭情况。"
}
```

真实姓名、员工号、内部地址、密钥和业务正文不进入门禁报告；原始审批记录继续保留在公司OA/变更系统中。

## 执行

```powershell
node scripts/evaluate-production-readiness.mjs `
  --manifest C:\approved\production-readiness-CHG-2026-0001\manifest.json `
  --output-json work\production-readiness.json `
  --output-markdown work\production-readiness.md
```

退出码：`0=GO`、`2=NO_GO`、`3=NOT_READY`、`1=命令或清单读取失败`。

输出文件采用只新建不覆盖模式，避免覆盖既有审批证据。

## 安全约束

- 证据路径不得为绝对路径、越出清单目录或通过符号链接指向目录外；
- 每个控制项必须使用独立证据文件；
- 文件哈希、证据时间、目标环境和内部报告字段必须一致；
- 本地、回环、合成、跳过写入的报告不能通过生产门禁；
- 业务、安全、运维、数据保护审批人不得复用；
- 证据包只存证明材料，不存密码、Token、Cookie、API Key、私钥或业务敏感正文。
