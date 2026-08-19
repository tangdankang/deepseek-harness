# 数据库Schema迁移与回滚

## 适用范围

本方案适用于当前单节点 SQLite 试点部署，用于建立发布前快照、Schema兼容门禁和可重复的隔离回滚演练。它不能替代面向3000人正式生产的高可用数据库、跨机房备份和灾难恢复方案。

## Schema迁移机制

- 当前Schema版本：`1`。
- 最低兼容版本：`1`。
- `schema_migrations`记录版本、迁移名称、SQL的SHA-256和应用时间。
- 应用启动时在事务内按顺序执行未应用迁移。
- 已发布迁移SQL、名称和校验和必须保持不可变；任何结构变化都应新增迁移版本。
- 数据库包含应用不认识的未来版本时，应用以`DATABASE_SCHEMA_TOO_NEW`拒绝启动。
- 迁移记录断档或未知时，以`DATABASE_MIGRATION_GAP`拒绝启动。
- 名称或校验和被修改时，以`DATABASE_MIGRATION_TAMPERED`拒绝启动。

## 备份清单v2

`backupDatabase`先执行完整性、外键和Schema兼容检查，再执行WAL checkpoint与`VACUUM INTO`。v2清单包含：

- 备份文件SHA-256和字节数；
- 当前、支持和最低兼容Schema版本；
- 每条迁移名称、校验和及应用时间；
- 各业务表记录数；
- checkpoint结果。

校验器继续支持v1清单。v1没有Schema证据，恢复时会标记`legacyManifest: true`；上线前应重新生成v2备份。

## 发布顺序

1. 暂停写流量和集成任务Worker，确认没有运行中的提交任务。
2. 对当前数据库执行v2备份并校验。
3. 在隔离目录执行回滚演练，要求结果为`PASS`。
4. 发布新应用；应用启动自动运行前向迁移。
5. 检查`/health/ready`、服务目录、关键员工流程和集成任务积压。
6. 恢复Worker和写流量，持续观察错误率、延迟及死信任务。

## 回滚原则

当前v1是基线迁移，不含破坏性DDL。若新版本发布失败：

1. 立即停止写流量和Worker，保存故障数据库用于审计。
2. 不在原文件上覆盖恢复；选择全新的数据库路径恢复已校验快照。
3. 使用与快照Schema兼容的应用版本启动。
4. 通过健康、服务目录和关键流程探针后再切换流量。
5. 若发布后产生了业务写入，回滚将丢失快照之后的数据；必须先由业务负责人确认RPO或执行增量补偿。

旧版应用不得直接连接包含未来Schema版本的数据库。若后续迁移包含删列、改类型或不可逆数据变换，必须采用“扩展—双写/回填—切换—清理”的多版本兼容方式，不能依靠直接降级二进制完成回滚。

## 隔离演练命令

```powershell
node scripts/run-rollback-drill.mjs `
  --database data/demand-platform.db `
  --drill-directory work/rollback-drill-YYYYMMDD-HHMMSS `
  --output-json work/rollback-report.json `
  --output-markdown work/rollback-report.md
```

所有输出路径必须不存在。演练会：

1. 生成并校验v2快照；
2. 恢复到新的隔离数据库；
3. 校验完整性、外键、Schema与表计数；
4. 用恢复库在本地随机端口启动应用；
5. 请求`/health/ready`和`/api/v1/services`；
6. 输出不含绝对路径、密钥、令牌和员工标识的报告。

## 通过门槛

- 报告结果为`PASS`；
- SHA-256、字节数和表计数与清单一致；
- `integrity_check=ok`且外键违规为0；
- Schema版本兼容；
- 两个HTTP探针均返回200；
- 演练目录、报告及日志未包含生产密钥或个人信息。
