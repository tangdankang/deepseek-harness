# 二开步骤 1：企业需求平台 Monorepo 基线验收记录

## 验收结论

步骤 1 的代码、文档和运行验证均已完成。需求平台作为私有应用纳入根 workspace 的 `apps/demand-platform/`，可以从仓库根目录独立测试和启动，且不会进入 DeepSeek Harness 的 npm 发布族。

本步骤未实现 Harness Agent 工具，未连接真实企业系统，未提交或推送 Git 变更。

## Git 与上游状态

- 当前分支：`feat/enterprise-demand-agent-platform`，跟踪 `origin/feat/enterprise-demand-agent-platform`。
- Fork 远程：`https://github.com/tangdankang/deepseek-harness.git`。
- 官方上游：`https://github.com/deepseek-ai/deepseek-harness.git`。
- 验收时 `master...upstream/master` 的左右提交数为 `0 0`。
- `pnpm-lock.yaml` 只增加 `apps/demand-platform: {}` importer。

## 迁移范围

现有需求平台源码、测试、脱敏示例配置、部署参考和应用文档已迁入 `apps/demand-platform/`。原目录 `E:\E_AI\Codex项目\AI需求平台\outputs\ai-demand-platform-mvp` 未修改或删除。

以下运行数据或敏感配置未迁入 Git：

- `.env`
- `data/`
- `work/`
- `node_modules/`
- `*.log`
- `deploy/.env.production`
- `deploy/connectors.production.json`

应用忽略规则同时覆盖 `backups/`、`*.db`、`*.db-shm` 和 `*.db-wal`。

## Workspace 与发布规则

`demand-platform@1.17.0` 被 pnpm 识别为私有 workspace 应用。共享的 `isPrivateWorkspaceApplication()` 判定将 `apps/<name>` 下、设置 `private: true` 且不使用 `@deepseek-ai/*` 名称的应用排除在 npm 发布族之外。

官方 `@deepseek-ai/*` 应用仍必须满足发布约束；将官方应用误设为私有不会被静默排除。该决定记录在 [私有 workspace 应用 Agent Note](../.agents/notes/implemented/process/2026-08-19-private-workspace-applications.md) 中。

## 测试与检查结果

| 检查 | 结果 |
|---|---|
| 原需求平台基线测试 | 129/129 通过 |
| `pnpm --filter demand-platform test` | 129/129 通过 |
| 私有应用与发布族聚焦测试 | 26/26 通过 |
| `pnpm exec tsx scripts/check-workspace-constraints.ts` | 通过 |
| `catalog:check` | 通过，脱敏示例 dry-run |
| `organization:check` | 通过，脱敏示例 dry-run |
| `knowledge:check` | 通过，脱敏示例 dry-run |
| `eval:check` | 通过，3 个示例用例有效 |
| `connectors:check` | 通过，1 个 CRM 示例连接器有效 |
| `deploy:check` | 通过，66 项静态部署检查无发现项 |
| `pnpm run lint` | 通过，0 warnings、0 errors |
| Agent Note 格式检查 | 551 个活动记录通过 |
| Markdown 换行检查 | 1880 个文件通过 |
| Markdown 链接检查 | 1920 个文件通过 |
| Agent Note 双语配对 | 已记录并通过 |
| `git diff --check` | 通过 |

完整 `doc-sync` 在自动通道中通过 27/28 项；唯一失败项是 Windows 拒绝 Node.js 创建测试符号链接。用户在具备符号链接权限的 `cmd.exe` 中单独执行文档站测试，2 个测试文件的 45/45 项全部通过，因此文档内容与环境权限两类结果已分别验证。

此前 v1.17 发布说明记录过 126 项测试，但当前取得的源码在迁移前后均实际执行 129 项测试。此基线以当前源码的 129/129 测试输出为准，不将迁入内容描述为与旧发布包逐字节一致。

## 启动验证

应用通过根目录命令 `pnpm --filter demand-platform start` 在临时端口 `18787` 成功启动。`GET /health/live` 返回进程存活，`GET /health/ready` 返回 `ready`，数据库、Outbox 和模拟连接器均处于可用状态。

就绪响应明确标识 `PILOT_SINGLE_NODE_SQLITE`、模拟连接器和演示鉴权模式。该结果只证明本地代码骨架可运行，不代表生产高可用、安全或真实企业接口验收通过。验收后服务进程已停止。

## 脱敏与权限检查

简单敏感信息扫描未发现 OpenAI 风格 `sk-` 密钥、`API_KEY` 实值或私钥标记。迁移排除目标在应用目录中均不存在。

自动执行通道曾在 Rolldown 写入 `packages/bundle/base/lib/index.js` 时收到 Windows 错误 5。人工写入测试证明目录 ACL 允许修改，随后人工和自动执行的完整 `pnpm run lint` 均成功；该事件判断为瞬时文件写入冲突或安全软件干预，不是持续权限阻塞。文档站符号链接测试则需要当前自动进程不具备的 Windows 权限，用户在授权终端中执行相同测试并取得 45/45 通过。

## 未完成项与边界

- 未接入真实 DEAP、钉钉、IAM、CRM、OA、ERP 或 TB 环境。
- 未迁入生产数据、生产凭据或生产连接器配置。
- 未实现 `packages/demand/*`、Agent Bundle 或模型可见工具。
- 未创建 Git 提交、Pull Request 或合并操作。

步骤 2 必须另行制定计划并获得明确同意，范围为只读 `demand-api-client` 及 `search_service_catalog`、`get_service_form_schema`、`get_request_status` 三个工具。
