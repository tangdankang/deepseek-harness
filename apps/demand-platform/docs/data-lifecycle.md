# 数据生命周期治理

本模块提供受控的数据清理能力。默认命令只做预演，不删除数据；生产保留期限必须由公司法务、信息安全、数据责任部门共同批准后再替换示例策略。

## 默认示例策略

`config/data-lifecycle-policy.example.json` 当前启用以下技术性短期数据清理：

- 员工认证会话：7天；
- 运营会话：7天；
- 已消费的一次性身份票据：7天；
- 已完成的 DEAP 工具调用跟踪：90天。

员工与 AI 的交互统计、员工评价、Webhook 事件虽提供了规则，但默认禁用。未取得正式书面策略前不得启用。

需求、外部工单、集成任务、人工接管、审计事件、服务目录、知识条目、生命周期执行记录、保留冻结和数据库迁移记录不在工具的自动删除白名单内。

## 预演

```powershell
$env:LIFECYCLE_HASH_SECRET='独立的长随机密钥'
node scripts/run-data-lifecycle.mjs `
  --database data/demand-platform.db `
  --policy config/data-lifecycle-policy.example.json `
  --actor-id DATA-STEWARD-001 `
  --output-json work/lifecycle-dry-run.json `
  --output-markdown work/lifecycle-dry-run.md
```

预演仅统计符合条件的记录，不写生命周期执行记录，也不删除数据。报告只包含操作者 HMAC 哈希，不包含原始身份或数据库绝对路径。

## 正式执行

正式执行同时要求：当前数据库的近期可验证备份、`--execute`、`--allow-delete`、有效变更单号和操作者身份。任一条件缺失即拒绝执行。

```powershell
node scripts/backup-database.mjs `
  --database data/demand-platform.db `
  --output backups/demand-platform-before-lifecycle.db

node scripts/run-data-lifecycle.mjs `
  --database data/demand-platform.db `
  --policy config/data-lifecycle-policy.example.json `
  --actor-id DATA-STEWARD-001 `
  --backup backups/demand-platform-before-lifecycle.db `
  --execute `
  --allow-delete `
  --approved-change-ref CHG-2026-0001 `
  --output-json work/lifecycle-execute.json `
  --output-markdown work/lifecycle-execute.md
```

执行时会在事务内重新计算候选记录，删除数必须与计划数一致，并写入 `data_lifecycle_runs`。完成后执行 SQLite 完整性和外键检查。

## 保留冻结

在法律保全、调查、审计、安全事件或业务保留期间，可冻结某张白名单表或全部白名单表：

```powershell
node scripts/manage-data-retention-hold.mjs `
  --database data/demand-platform.db `
  --action create `
  --scope ALL `
  --reason-code LEGAL_HOLD `
  --change-ref LEGAL-2026-0001 `
  --actor-id DATA-STEWARD-001 `
  --allow-hold-change
```

解除冻结需要冻结编号、新变更单号和同样的显式授权：

```powershell
node scripts/manage-data-retention-hold.mjs `
  --database data/demand-platform.db `
  --action release `
  --hold-id HOLD-编号 `
  --change-ref LEGAL-2026-0002 `
  --actor-id DATA-STEWARD-001 `
  --allow-hold-change
```

## 生产职责

- 数据责任部门批准数据分类、保留期限、冻结与销毁规则；
- 信息安全批准密钥托管、权限分离、日志和备份门禁；
- 法务确认法定保留、诉讼保全和跨境限制；
- 运维只通过变更流程执行，先预演、复核，再备份和正式执行；
- 审计人员定期复核执行记录、冻结状态、备份证据和完整性结果。
