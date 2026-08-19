# SQLite 试点数据库备份、校验与恢复

本流程只适用于单主机 PoC/小规模试点的 SQLite 数据库，不是 3000 人全员生产高可用数据库方案。

## 在线备份

备份命令会先执行数据库完整性检查和 WAL 完整检查点，再用 SQLite `VACUUM INTO` 生成一致性副本；目标文件和清单只允许新建，不覆盖已有备份。

```powershell
node scripts/backup-database.mjs `
  --database data/demand-platform.db `
  --output backups/demand-platform-20260813T220000Z.db
```

同时生成 `<备份文件>.manifest.json`，包含格式版本、创建时间、字节数、SHA-256、各业务表记录数和检查点结果。备份成功后应将数据库与清单一起复制到受控的异地介质；复制完成后再次校验。

## 校验

```powershell
node scripts/verify-database-backup.mjs `
  --backup backups/demand-platform-20260813T220000Z.db
```

校验同时检查：

- 清单格式；
- 文件 SHA-256 和字节数；
- SQLite `PRAGMA integrity_check`；
- 每张业务表的记录数。

文件或清单缺失、哈希被篡改、数据库损坏或表计数不一致时命令失败。仅有“备份命令退出 0”不等于可恢复，必须保留校验日志和定期恢复演练证据。

## 恢复演练

恢复只能写入不存在的新目标，目标数据库、`-wal` 或 `-shm` 任一已存在都会拒绝覆盖：

```powershell
node scripts/restore-database.mjs `
  --backup backups/demand-platform-20260813T220000Z.db `
  --target restore-test/demand-platform.db
```

恢复前先校验备份，复制后再次执行数据库完整性和表计数检查；恢复后检查失败会删除不完整目标。演练完成后，应启动隔离的 API/工作进程，抽查需求、工单、人工受理、审计和 Outbox 状态，再由运维记录 RPO/RTO。

## 建议试点策略

- 每日全量备份；关键配置发布前额外备份；
- 至少保留 7 个日备份和 4 个周备份，最终周期以公司制度为准；
- 备份加密、访问控制、异地复制和删除策略由公司备份平台实施；
- 每周自动校验，试点前与每月至少一次隔离恢复演练；
- 监控源卷和备份卷空间、备份时长、最近成功时间、哈希校验和恢复结果；
- 恢复后先保持写入关闭，完成 Outbox/下游工单对账，再恢复自动提交。

全员生产应迁移到公司批准的高可用关系数据库，并采用数据库原生备份、时间点恢复、跨可用区复制和经批准的灾备方案。
