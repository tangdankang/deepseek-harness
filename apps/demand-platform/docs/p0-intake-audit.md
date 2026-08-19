# P0 真实接入资料包检查器

该工具用于在真实 DEAP/钉钉、业务系统、组织目录或高可用基础设施资料到达后，自动判断资料是否可由 Python 白名单读取、证据类别是否齐全、文件哈希是否一致，以及是否误把凭据放入资料包。工具只读取逻辑文件内容并计算摘要，不持久化完整明文副本。

## 使用

按资料类型复制对应模板到资料包：

- 业务系统：`config/p0-intake-manifest.example.json`；
- DEAP/钉钉：`config/p0-deap-intake-manifest.example.json`；
- 组织与身份：`config/p0-organization-intake-manifest.example.json`；
- 高可用基础设施：`config/p0-infrastructure-intake-manifest.example.json`。

填写联系人、测试网络和证据文件相对路径。真实密码、Token、API Key、Cookie、客户端密钥和私钥不得写入清单或证据文件；凭据应通过公司密钥管理或获批安全通道单独注入。

```powershell
python tools/audit_p0_intake.py `
  --folder C:\approved\P0-CRM `
  --manifest C:\approved\P0-CRM\manifest.json `
  --format markdown `
  --output C:\approved\P0-CRM\readiness-report.md
```

退出码：

- `0`：`READY`，结构化清单齐全且文件可读；
- `2`：`NOT_READY`，仍缺类别、联系人或测试网络资料；
- `3`：`REJECTED`，存在凭据声明失败、哈希不一致、不安全路径或不可读文件。

## 支持的资料包类型

### BUSINESS_SYSTEM

必需证据：鉴权规范、建单 API、查单或回调、字段映射、状态映射、幂等规则、错误码、脱敏测试数据、数据分级说明；另需业务、技术、安全、运维 Owner 和测试网络信息。

### DEAP_TENANT

必需证据：当前租户文档、Agent 配置、工具协议、身份上下文、安全权限范围、测试账号计划；另需业务、技术、安全 Owner 和租户管理员。

### ORGANIZATION_DIRECTORY

必需证据：组织树、可信身份上下文、层级继承规则、矩阵/多部门规则、同步SLA、首批服务受众和数据分级说明；另需业务、技术、安全、身份、数据和运维Owner，以及测试组织源访问方式。

### INFRASTRUCTURE

必需证据：平台标准、数据库、缓存、消息队列/调度、部署拓扑、网络网关、KMS、可观测、灾备和容量SLO；另需架构、数据库、平台、安全和运维Owner，以及测试环境网络信息。

## SafeNet 口径

Python 读取到的 Office 文件必须能作为标准 DOCX/XLSX/PPTX ZIP 容器打开，并含必要内部条目。若 Python 读取后仍出现 `E-SafeNet` 锁定标记，工具判为 `REJECTED`。报告中的 SHA-256 是 Python 白名单读取到的逻辑内容摘要，可能与未获授权程序看到的加密落盘字节不同。

## 局限

- `containsCredential=false` 是资料提供人的明确声明；工具能识别私钥标记和高风险文件名，但不能证明 Office 正文中绝对没有所有形式的凭据。
- 工具验证“资料可读且齐套”，不替代接口真实性、权限有效性、网络连通性或安全审批。
- 旧版二进制 `.doc` 只能做基本可读性检查，建议另存为 `.docx` 后提供。
