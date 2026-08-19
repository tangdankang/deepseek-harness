# 二开步骤 1：企业需求平台 Monorepo 基线计划

## 文档定位

本文件是当前二开分支已获批准的执行计划，不是产品架构参考文档。每个开发步骤都先形成计划并在当前聊天窗口展示一致内容，得到用户明确同意后再执行。

## 目的

将现有 DeepSeek Harness fork 与“AI需求处理一站式平台”统一纳入一个 Git 仓库，同时保持两套应用可以独立启动和测试，为后续 Harness Agent 中台集成建立稳定边界。

## 当前基线

- Git 仓库：`E:\E_AI\DSHarness\deepseek-harness-dev`
- 远程仓库：`https://github.com/tangdankang/deepseek-harness.git`
- 官方上游：`https://github.com/deepseek-ai/deepseek-harness`
- 开发分支：`feat/enterprise-demand-agent-platform`
- 分支状态：已推送到 `origin`，当前工作区干净
- Harness 业务集成目标：方案 A，Harness 作为 Agent 中台
- 需求平台现有源码：`E:\E_AI\Codex项目\AI需求平台\outputs\ai-demand-platform-mvp`
- 需求平台归档方式：迁入根 workspace 的 `apps/demand-platform/`，不保留独立 Git 仓库
- 暂缺企业输入：使用明确标记的脱敏示例和模拟接口继续构建代码骨架

## 本步骤范围

### 纳入范围

- 盘点需求平台源码、测试、配置、部署参考和文档的迁移清单。
- 将可运行需求平台迁移为仓库内的 `apps/demand-platform/` workspace 应用。
- 调整根目录 workspace 配置和应用内路径，使需求平台能独立运行。
- 保留需求平台既有业务边界：身份、组织、需求、确认、连接器、审计和运营接口。
- 为后续 `packages/demand/*` Harness 集成包预留目录和文档边界，但不在本步骤实现 Agent 工具。
- 运行迁移后的需求平台专项测试和最小启动检查。

### 明确不在范围内

- 不修改 Harness 的 `agent-loop`、`session`、`llm` 或核心工具执行语义。
- 不实现 `demand-api-client`、业务 Tool、Agent Bundle 或 DEAP 实时联调。
- 不接入真实钉钉、DEAP、CRM、OA、ERP 或 TB 环境。
- 不迁移运行数据库、测试日志、`.env`、生产连接器配置、真实凭据、`node_modules` 和压缩包。
- 不删除原始 `E:\E_AI\Codex项目\AI需求平台` 文件；迁移成功前保留原目录作为只读回退副本。
- 不在本步骤创建 Pull Request 或合并到 `master`。

## 计划操作流程

1. 读取根级 `AGENTS.md`、`packages/AGENTS.md`、`apps/AGENTS.md`（如存在）和当前需求平台的应用约束，确认 workspace、命名、测试与文档要求。
2. 对需求平台执行只读盘点，确认源码入口、依赖、测试命令、运行数据目录和配置文件边界。
3. 生成迁移清单，明确每个文件是迁移、重建、忽略还是留在原目录；发现密钥或加密文件时先暂停并报告。
4. 创建 `apps/demand-platform/`，迁移源码与必要的应用文档，补充符合 Harness 仓库约定的 package 元数据。
5. 更新根级 `pnpm-workspace.yaml` 和必要的项目引用，不改变现有 Harness 包的依赖方向。
6. 在迁移后的应用目录执行原有单元测试、配置校验和最小启动检查；如安装或构建被公司策略阻断，优先区分网络、文件加密、进程权限和真实代码错误。
7. 检查 `git diff`、敏感文件、忽略规则、文档链接和 workspace 状态，形成本步骤的验证记录。
8. 只有验证通过后，才准备一个独立提交：`chore: add demand platform workspace application`；提交前会再次向用户报告，不自动提交除非用户授权。

## 需要用户提供的内容

本步骤可以先使用现有本地源码和示例配置推进，不需要真实企业凭据。进入真实联调步骤前必须提供或明确暂缺：

- 官方上游 GitHub 仓库地址已确认为 `https://github.com/deepseek-ai/deepseek-harness`。
- 需求平台已确认改造为根 workspace 的 `apps/demand-platform`，不保持独立仓库。
- 公司规定的 Node、pnpm、数据库、消息队列和部署环境版本。
- 第一批真实业务系统及其测试环境接口资料；没有时可以继续使用明确标记的模拟适配器。
- DEAP、钉钉和 IAM 测试租户资料；没有时不进行真实联调，只做契约和模拟测试。

如果用户明确暂时无法提供以上资料，可以用脱敏示例和模拟接口继续做代码骨架，但任何模拟结果都不能标记为企业生产验收通过。

## 公司权限与环境风险处理

- 文件被加密或 JSON/SQLite 变为不可读时，先确认路径是否位于公司加密目录；必要时使用 Python 白名单方式透明读取，不删除原文件。
- GitHub、包仓库或企业接口无法访问时，先记录具体地址、状态码或权限错误，区分网络策略、凭据缺失和代码错误。
- 默认执行通道出现 Windows 错误 5 时，改用 `cmd.exe` 作为父进程，再由其启动 `powershell.exe`；该路径仍失败时停止并报告 Windows 进程权限、杀毒/EDR 或 PTY 限制。
- 任何需要真实密钥、员工数据或生产写入的操作，都在执行前单独说明目标、数据和风险，并等待用户确认。

## 验收标准

- `apps/demand-platform/` 是一个可解析的 workspace 应用。
- 需求平台源码、测试和必要文档已纳入同一 Git 工作树，运行数据和敏感配置未纳入 Git。
- 原需求平台测试命令在迁移后通过，或每个失败都有明确的环境/代码归因。
- Harness 原有类型检查、构建入口和包边界没有因迁移产生未解释的破坏。
- 迁移后的应用仍可独立启动，且不要求 Agent 集成代码存在。
- 迁移清单、测试命令、失败信息和未完成项均记录在本步骤的变更说明中。

## 本步骤完成后的下一步

步骤 1 验收通过后，另行制定步骤 2 计划：实现 `packages/demand/demand-api-client`，仅接入需求平台只读 API，并增加 `search_service_catalog`、`get_service_form_schema`、`get_request_status` 三个只读工具。步骤 2 仍需单独获得用户同意后才执行。

## 用户确认

请明确回复“同意步骤 1”，或指出需要调整的范围、目录或验收标准。收到明确同意前，不执行本计划中的源码迁移和测试操作。
