# 参考部署

[English](README.md) | 中文

`compose.pilot.example.yml` 只用于公司测试/小规模试点的单主机参考部署，不是3000人生产高可用架构。它启动一个API进程和一个Outbox工作进程，共享本机Docker卷中的SQLite WAL数据库。

## 使用前

1. 将 `.env.production.example` 复制为 `.env.production`，使用公司密钥系统注入各用途互不相同的随机密钥；不要提交该文件。
2. 将 `node:24-bookworm-slim` 在公司制品库中完成漏洞扫描并锁定不可变digest，再通过 `NODE_IMAGE`构建参数使用内部镜像。
3. 在API前部署公司网关/TLS/WAF，只有可信身份网关可注入员工身份签名。
4. 确认卷是单主机本地持久卷，不使用不支持SQLite锁语义的共享网络文件系统。
5. 配置每日备份、异地复制、完整性校验、恢复演练和磁盘容量告警。
6. 仅允许公司监控采集器携带独立 `METRICS_API_KEY` 访问 `/internal/metrics`，并在正式阈值评审后导入 `prometheus-alerts.example.yml`。

示例：

```powershell
Set-Location deploy
Copy-Item .env.production.example .env.production
# 使用密钥系统或安全编辑方式填值
docker compose -f compose.pilot.example.yml config
docker compose -f compose.pilot.example.yml up -d --build
```

当前工作环境未安装Docker/Podman，因此没有声称镜像已实际构建。发布前必须在公司CI中执行镜像构建、镜像扫描、容器启动和健康检查。

## 生产演进

全员生产不建议直接复制该Compose：

- 将SQLite与直连SQL重构到公司批准的高可用关系数据库；
- 将本地Outbox轮询迁移或桥接到公司消息队列/任务平台；
- API无状态多副本，工作进程独立伸缩；
- 接入统一SSO/RBAC、KMS、网关限流、日志、指标、告警和SIEM；
- 附件进入对象存储及病毒/内容安全扫描；
- 经容量、故障、备份恢复和回滚演练后再全员发布。

具体目标形态由公司P0-07基础设施输入决定，避免提前绑定不存在的平台。
