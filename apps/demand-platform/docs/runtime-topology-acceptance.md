# 生产高可用运行拓扑验收

## 目的

3000人全员生产不能以清单中的 `HIGH_AVAILABILITY` 文本或一份本地测试报告作为证明。本验收器只读采样真实远程入口的 `/health/ready`，验证实际运行实例和能力声明。

## 当前版本边界

当前实现只支持 `PILOT_SINGLE_NODE_SQLITE`，健康探针明确返回：

- `deploymentModel=SINGLE_NODE_PILOT`；
- `storageBackend=SQLITE`；
- 共享会话、分布式限流、共享任务协调均为 `false`。

若把 `RUNTIME_PROFILE` 设置为 `PRODUCTION_HIGH_AVAILABILITY`，应用在启动前返回 `UNSUPPORTED_HIGH_AVAILABILITY_RUNTIME`。这避免仅改配置就把单机试点误报成生产高可用。

## 远程验收

```powershell
node scripts/run-runtime-topology-acceptance.mjs `
  --base-url https://approved-test.example `
  --samples 20 `
  --timeout-ms 5000 `
  --output-json work/runtime-topology.json
```

生产范围PASS必须同时满足：

- 目标不是localhost或回环地址；
- 至少20次样本全部返回就绪；
- 至少观察到2个不同实例，报告只保存实例ID哈希；
- 所有实例声明 `PRODUCTION_HIGH_AVAILABILITY` 和 `HIGH_AVAILABILITY`；
- 存储后端为PostgreSQL或MySQL，不接受SQLite；
- 共享会话状态、分布式限流和共享任务协调均为真。

报告不保存内部URL、主机名或原始实例ID，只保存目标和实例的SHA-256。工具不发送业务写入、不使用员工身份或业务凭据。回环环境只能得到 `NOT_READY`。

## 可信边界

健康声明必须由发布版本硬编码到已实现适配器能力，不能由普通环境变量直接切换。远程采样证明流量实际触达多个能力一致的实例，但不能单独证明数据库故障切换、跨机房灾备或会话一致性；这些仍需独立演练证据和公司基础设施Owner签字。
