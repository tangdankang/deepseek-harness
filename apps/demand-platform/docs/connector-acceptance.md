# 业务系统连接器验收

## 目的

连接器验收套件用于让OA、TB、CRM、ERP等系统Owner以同一证据格式完成接入自测。它分为不写下游的配置检查和必须显式授权的测试环境写入验收。

## 准备材料

1. 基于`deploy/connectors.production.example.json`形成目标系统配置，实际文件命名为`deploy/connectors.production.json`并禁止提交源码。
2. 基于`config/connector-acceptance-fixture.example.json`形成脱敏测试夹具。
3. 由业务Owner确认测试字段、测试账号、允许产生的工单数量和清理方式。
4. 通过公司密钥系统向配置所引用的环境变量注入凭据；不得把凭据写入JSON或命令行。

夹具必须包含一个有效请求、一个错误目标系统请求、一个复用相同幂等键但修改内容的冲突请求，以及下游所有原始状态和一个未知测试状态。

## 阶段一：只读配置检查

```powershell
node scripts/run-connector-acceptance.mjs `
  --config deploy/connectors.production.json `
  --fixture config/connector-acceptance-fixture.json `
  --output-json work/connector-static-report.json `
  --output-markdown work/connector-static-report.md
```

该模式不读取凭据、不调用下游，预期结果是`NOT_READY`。这不是失败，而是明确说明尚未获得测试环境写入证据。

## 阶段二：测试环境写入验收

获得业务Owner批准后执行：

```powershell
node scripts/run-connector-acceptance.mjs `
  --config deploy/connectors.production.json `
  --fixture config/connector-acceptance-fixture.json `
  --allow-write `
  --allow-remote-write `
  --output-json work/connector-write-report.json `
  --output-markdown work/connector-write-report.md
```

远程写入必须同时提供`--allow-write`和`--allow-remote-write`，并只允许HTTPS。写入验收共9项：配置、夹具、有效/无效校验、输入不可变、首次建单、幂等重放、同键冲突、主动查单和状态映射。

## 本地沙箱

```powershell
node scripts/run-local-connector-acceptance.mjs `
  --output-json work/local-connector-report.json `
  --output-markdown work/local-connector-report.md
```

该命令启动本地随机端口HTTP沙箱，使用运行时随机凭据执行完整验收，不连接公司系统。

## 结果判定

- `PASS`：所有适用检查通过，可进入平台端到端联调；不等于允许生产上线。
- `NOT_READY`：未执行下游写入，仍需授权和真实测试证据。
- `FAIL`：存在配置、字段、鉴权、幂等、查单、契约或状态映射问题。

## 报告安全

报告仅保存系统编码、目标类别、配置和夹具哈希、检查结论及安全错误码。它不保存目标URL、凭据、字段值、员工标识、幂等键或下游工单编号。原始调用日志仍须由公司受控日志平台按数据分级管理。

## 仍需人工验证

- 业务字段含义和必填规则；
- 测试账号权限最小化；
- 附件、评论、撤单等专用能力；
- Webhook签名、防重放、乱序和重复事件；
- 429、5xx、超时后未知结果及恢复；
- 日终对账、告警、容量、变更窗口和灾备。
