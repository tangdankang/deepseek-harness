# 知识发布与版本治理

平台不会把收到的文档直接当成可信答案。每条可回答知识必须经过来源确认、业务 Owner 审阅、部门授权和版本化发布，避免过期制度或越权内容被 Agent 返回。

## 发布流程

1. 使用 `tools/audit_p0_intake.py` 检查来源文件是否能被 Python 白名单读取，并取得逻辑内容 SHA-256。
   可再使用 `tools/build_knowledge_draft.py` 生成不可直接发布的可追溯审阅草稿；详细边界见 `docs/encrypted-knowledge-intake.md`。
2. 由知识 Owner 根据原文形成结构化知识条目，填写来源、适用部门、审阅时间、失效时间和变更单号。
3. 先执行 dry-run：

```powershell
node scripts/import-knowledge-catalog.mjs `
  --file config/knowledge-catalog.example.json `
  --database data/demand-platform.db `
  --dry-run
```

4. 通过公司变更审批后正式发布：

```powershell
$env:KNOWLEDGE_IMPORT_ACTOR='approved-operator-id'
node scripts/import-knowledge-catalog.mjs `
  --file C:\approved\knowledge-catalog.json `
  --database data/demand-platform.db
```

操作人也可通过 `--imported-by` 提供。真实来源文件和人员信息应留在受控目录，不进入源码包。

## 强制规则

- 新知识从版本1开始；任何内容、权限、来源或有效期变化都必须递增1。
- 相同版本只允许完全一致的幂等重放，禁止静默覆盖；历史版本表禁止更新和删除。
- 来源必须为不含内嵌凭据的 HTTPS 地址，并提供64位 SHA-256、审阅时间和变更单号。
- 审阅时间不能来自未来；允许最多5分钟的系统时钟偏差。
- `allowedDepartments=["*"]` 表示全员；使用 `*` 时不能混入其他部门。
- 已停用或已过期知识不会参与检索；部门不匹配时也不会泄露标题、答案或引用。
- 旧版演示知识首次纳入治理时必须发布为版本2，明确保留“版本1未形成治理快照”的事实。

## 边界

当前 MVP 使用确定性关键词检索，适合高置信度 FAQ 和办理指引。未来接入向量检索或大模型 RAG 时，仍必须在召回之后执行同样的部门权限、启用状态、有效期和引用校验；模型不得绕过这些规则，也不得依据未发布文档生成正式制度答案。
