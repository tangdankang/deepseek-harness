# 审计完整性与防篡改链

Schema v3为每条 `audit_events` 记录建立HMAC-SHA256链。哈希覆盖审计编号、案件编号、操作者类型与标识、动作、结果、已脱敏详情、Trace ID、时间、上一条哈希、密钥版本和链模式。事件与链记录在同一个数据库事务中写入或回滚。

## 生产配置

```text
AUDIT_CHAIN_SECRET=<独立、至少32位、由公司密钥系统注入的随机值>
AUDIT_CHAIN_KEY_VERSION=1
AUDIT_CHAIN_ALLOW_LEGACY_BACKFILL=false
```

审计密钥不得与身份、确认、Webhook、工具、运营或分析密钥复用。数据库和报告不保存该密钥。

当前版本不自动执行密钥轮换。未经专门迁移方案，不得修改既有数据库对应的密钥或版本，否则应用会把它识别为完整性失败并拒绝启动。

## 启动行为

- 新数据库创建不可变 `audit_chain_state`，后续禁止删除或更新；
- 每条新审计使用 `LIVE` 模式链接；
- 审计事件和链数量不一致、上一条哈希断裂、内容哈希不匹配、密钥错误或版本不一致时拒绝启动；
- 删除审计事件受外键约束阻止；
- 初始化状态受数据库触发器保护。

## 旧数据一次性锚定

从v1.4及更早版本升级时，既有审计没有历史HMAC证据，只能在升级时以 `LEGACY_BACKFILL` 模式建立“从此刻开始”的锚点，不能证明锚定前从未被修改。

生产默认禁止自动锚定。推荐流程：

1. 冻结写入窗口，完成数据库备份、哈希和恢复验证；
2. 由安全、运维和数据责任人批准变更单；
3. 使用CLI的双重授权执行一次锚定；
4. 把报告和链头提交到公司SIEM/WORM/变更系统；
5. 确认 `AUDIT_CHAIN_ALLOW_LEGACY_BACKFILL=false` 后重新启动；
6. 再次执行只读完整性校验。

```powershell
$env:AUDIT_CHAIN_SECRET='由公司密钥系统注入'
node scripts/verify-audit-chain.mjs `
  --database data/demand-platform.db `
  --allow-legacy-anchor `
  --approved-change-ref CHG-2026-0001 `
  --output-json work/audit-integrity.json `
  --output-markdown work/audit-integrity.md
```

锚定完成后，日常只读校验不再提供 `--allow-legacy-anchor`。

## 运营校验

具有 `VIEW_AUDIT` 权限的运营身份可调用：

```text
GET /api/v1/admin/audit-integrity
```

接口先校验现有链，成功后把本次 `VERIFY_AUDIT_CHAIN` 操作写入链，再校验并返回最新结果。报告仅包含计数、链头、密钥版本和异常位置，不包含审计正文、操作者身份或密钥。

## 告警与处置

出现以下任一错误时停止发布和审计清理，隔离数据库副本并启动安全事件流程：

- `AUDIT_CHAIN_TAMPERED`；
- `AUDIT_CHAIN_INCOMPLETE`；
- `AUDIT_CHAIN_STATE_MISSING`；
- `AUDIT_CHAIN_KEY_VERSION_MISMATCH`；
- `AUDIT_CHAIN_LEGACY_ANCHOR_REQUIRED` 出现在非批准升级窗口。

不要通过重新计算哈希“修复”生产链。应保留现场，比较已验证备份、外部链头和集中日志，再决定恢复或事件调查。

## 安全边界

数据库内HMAC链能检测事件内容、顺序、缺链和错误密钥，但不能单独对抗同时控制数据库文件、应用密钥和程序代码的攻击者，也不能证明旧记录在首次锚定前未被修改。正式生产必须定期把最新链头和报告哈希发送到独立SIEM、WORM存储或公司变更系统，并验证备份恢复后的链头一致性。
