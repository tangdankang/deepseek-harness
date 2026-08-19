# AI 需求处理一站式平台：新对话接续说明

## 使用方式

本文件供新的 Codex 对话恢复项目上下文。新会话不能依赖旧聊天记录或侧边栏中其他任务的内容，必须先读取本文件、仓库根级 `AGENTS.md` 和当前步骤计划，再决定任何操作。

新会话的第一轮只应核对 Git 状态、复述下一步骤计划并等待用户批准。未经批准不得开始步骤 2 开发。

## 项目目标

在 DeepSeek Harness fork 上二次开发公司级“AI 驱动的需求处理一站式平台”。采用方案 A：Harness 作为 Agent 中台，需求平台负责服务目录、动态表单、需求确认、幂等建单、连接器、状态回传、审计和运营接口，Harness 通过插件和工具调用需求平台能力。

需求平台不保持独立仓库，作为根 workspace 的 `apps/demand-platform/` 与 Harness 一起进行 Git 管理。暂缺的企业系统、组织数据和生产接口使用明确标记的脱敏示例和模拟适配器，不得把模拟结果描述为生产验收通过。

## 用户协作规则

1. 每个合理大小的开发步骤必须先在 `project-plans/` 创建计划，写明目的、范围、操作流程、所需输入、风险和验收标准。
2. 计划内容必须同时在当前聊天窗口展示，并与 Markdown 文件一致；得到用户对该步骤的明确同意后才能实施。
3. 需要真实企业资料时应明确提出；用户暂时无法提供时，可以用脱敏示例和模拟接口搭建代码骨架。
4. 遇到安装、网络、进程、文件或接口异常时，优先判断公司策略限制，不得绕过公司安全控制。
5. 遇到 SafeNet 等企业文件加密时，使用 Python 标准库和项目白名单逻辑进行透明读取，不删除或解密覆盖原文件。
6. 默认执行通道出现 Windows 错误 5 时，使用 `cmd.exe` 作为父进程，再由其启动所需程序；该路径仍失败时停止并报告。
7. 不提交密钥、生产数据、员工信息、`.env`、数据库或真实生产连接器配置。
8. 用户曾在旧聊天中发送 API Key，该值已暴露，不能写入本文件、代码、Git、日志或后续提示词；真实联调前必须要求用户提供已轮换的新密钥，并仅保存在本地忽略文件或凭据服务中。

## Git 与目录

- 工作目录：`E:\E_AI\DSHarness\deepseek-harness-dev`
- Fork：`https://github.com/tangdankang/deepseek-harness.git`
- 官方上游：`https://github.com/deepseek-ai/deepseek-harness.git`
- 开发分支：`feat/enterprise-demand-agent-platform`
- 原需求平台只读回退目录：`E:\E_AI\Codex项目\AI需求平台\outputs\ai-demand-platform-mvp`
- Monorepo 应用目录：`apps/demand-platform/`

`origin` 指向用户 fork，`upstream` 指向官方仓库。步骤 1 验收时本地 `master` 与 `upstream/master` 的左右提交数为 `0 0`。

## 仓库架构约束

DeepSeek Harness 基于 Cordis，所有行为通过插件、服务、事件和可逆 effect 组合。修改 `packages/` 前必须完整阅读 `docs/architecture.md` 和适用的 `AGENTS.md`。

新能力优先放在扩展点和完整能力角色中，不直接修改 `agent-loop`。任何模型可见输入必须可由 session log 重建。非平凡变更必须包含 Agent Note；用户可见行为还要按仓库规则增加真实可运行示例和 keyless snapshot。

## 步骤 1 已完成内容

步骤 1 将需求平台迁入根 workspace，并保留独立测试和启动能力。详细计划和证据位于：

- [步骤 1 基线计划](step-01-monorepo-baseline.md)
- [步骤 1 验收记录](step-01-monorepo-baseline-results.md)
- [步骤 1 收尾与接续计划](step-01-closeout-and-handoff-plan.md)
- [私有 workspace 应用 Agent Note](../.agents/notes/implemented/process/2026-08-19-private-workspace-applications.md)

迁移排除了 `.env`、`data/`、`work/`、`node_modules/`、日志、数据库、生产环境文件和真实连接器配置。原需求平台目录未修改或删除。

`scripts/workspace-manifest-policy.ts` 定义私有 workspace 应用：位于 `apps/<name>`、设置 `private: true` 且不使用 `@deepseek-ai/*` 名称。此类应用参与 pnpm workspace，但不进入官方 npm 发布族。官方 `@deepseek-ai/*` 应用即使误设为私有也仍由约束检查拒绝，不能静默漏发。

## 步骤 1 验证证据

- 原需求平台基线测试：129/129 通过。
- 迁移后 `pnpm --filter demand-platform test`：129/129 通过。
- 发布规则聚焦测试：26/26 通过。
- workspace 约束检查通过。
- 服务目录、组织目录、知识目录和 Agent Eval 示例检查通过。
- 连接器生产示例静态校验通过。
- 部署参考 66 项静态检查通过。
- 应用在临时端口成功启动，`/health/live` 和 `/health/ready` 返回成功，随后已停止。
- 完整 `pnpm run lint` 通过，0 warnings、0 errors。
- Agent Note 格式、双语配对、Markdown 换行、链接和 `git diff --check` 通过。
- 完整 `doc-sync` 的 27 个普通门禁在自动通道通过；唯一需要 Windows 符号链接权限的文档站测试由用户在授权终端运行，45/45 通过。
- 敏感信息扫描未发现迁入的 API Key、私钥、生产 `.env` 或真实连接器配置。

旧发布说明曾记录 126 项测试，但当前取得的源码在迁移前后均实际运行 129 项。后续以当前源码和 129/129 输出作为基线。

## 环境经验

Codex 默认 PowerShell 进程曾被 Windows 以错误 5 拒绝创建。通过 `cmd.exe` 作为父进程可以稳定运行命令和启动 PowerShell。

Rolldown 曾一次在写入 `packages/bundle/base/lib/index.js` 时收到错误 5。目录 ACL 和手工写入测试正常，随后用户手工运行及 Codex 通过 `cmd.exe` 自动运行完整 lint 均成功。该问题不是持续 ACL 阻塞；再次发生时先记录进程、目标文件和 EDR 状态，不循环重试或绕过安全软件。

文档站测试会调用 Node.js `symlinkSync()` 验证仓库外图片路径。自动进程缺少 Windows 符号链接权限时会返回 `EPERM`；用户在具备权限的 `cmd.exe` 中运行 `pnpm exec vitest run scripts/project-doc-site.spec.ts scripts/verify-doc-site-fragments.spec.ts` 已取得 45/45 通过。

## 当前边界

- 没有真实 DEAP、钉钉、IAM、CRM、OA、ERP 或 TB 联调。
- 没有生产数据库、消息队列、组织目录或部署环境参数。
- 当前应用就绪响应明确标识单机 SQLite、模拟连接器和演示鉴权，只是本地代码骨架。
- 没有实现 `packages/demand/*`、Harness Agent Bundle 或需求平台模型工具。
- 没有创建 Pull Request 或合并到 `master`。

## 建议的步骤 2

步骤 2 尚未获得开发批准。新会话应先创建并展示步骤 2 计划，建议范围如下：

- 创建 `packages/demand/demand-api-client`，作为 Harness 到需求平台 HTTP API 的只读客户端。
- 定义脱敏的请求、响应、错误分类、超时和身份上下文接口。
- 增加三个只读模型工具：`search_service_catalog`、`get_service_form_schema`、`get_request_status`。
- 使用模拟服务和 keyless runnable example 验证工具输出；不接入真实企业系统，不实现建单写操作。
- 按 Harness 能力角色设计 Service Definition、Provider 和 Consumer，并补齐 Agent Note、单元测试、集成测试及 snapshot 支持。

步骤 2 的目录、包名、工具 UI render intent、身份传递和 session log 事件必须在计划中明确，不能先写代码再补设计。

## 新会话首轮检查

```bat
cd /d E:\E_AI\DSHarness\deepseek-harness-dev
git status --short --branch
git remote -v
git log -1 --oneline
```

随后读取：

```text
AGENTS.md
docs/architecture.md
project-plans/NEW-CONVERSATION-HANDOFF.md
project-plans/step-01-monorepo-baseline-results.md
```

建议用户在新对话中的开场指令：

```text
请先完整阅读 project-plans/NEW-CONVERSATION-HANDOFF.md、根级 AGENTS.md 和 docs/architecture.md，核对当前 Git 状态。不要立即开发；先依据接续说明生成步骤 2 计划文件，并在聊天中展示完全一致的计划，等待我批准。
```
