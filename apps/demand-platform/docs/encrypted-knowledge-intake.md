# 加密知识来源提取与审阅草稿

该流程用于把 SafeNet 等企业加密保护下的 DOCX、XLSX、PPTX、TXT、Markdown、CSV、JSON、PDF 和旧 DOC 文件转换为“待人工审阅”的结构化草稿。Python 白名单读取到的是逻辑内容；工具不会尝试修改、移除或绕过落盘加密。

## 安全设计

- 必须显式提供 `--allow-write-extracted-content`，确认输出目录受公司加密和访问控制保护。
- 输出只写到指定的新文件，已存在时拒绝覆盖；控制台不输出正文或绝对路径。
- 来源SHA-256按Python读取到的逻辑文件字节计算，提取和哈希使用同一份内存快照，避免文件变化造成指纹错配。
- Office ZIP条目数、单条目和解压总体积均有限制；SafeNet锁定字节、私钥和异常容器会被拒绝。
- 常见 `password/token/api_key/secret` 赋值会在片段中替换为 `[REDACTED]`。
- 输出永远是 `REVIEW_REQUIRED`、`publishable=false`、`enabled=false`、`answer=null`，不能直接进入生产知识库。
- PDF与旧DOC只提供有限提取，必须逐段对照原文件。

## 生成草稿

```powershell
python tools/build_knowledge_draft.py `
  --source C:\approved\账号权限办理规范.docx `
  --output C:\approved\账号权限办理规范.review-draft.json `
  --source-url https://intranet.example.invalid/access-guide `
  --owner-team 权限服务组 `
  --allowed-department D-ORG `
  --classification INTERNAL `
  --prepared-by E-KB-ADMIN `
  --intake-ref KB-INTAKE-20260817-001 `
  --allow-write-extracted-content
```

校验草稿结构和片段指纹时仍使用Python：

```powershell
python tools/build_knowledge_draft.py `
  --verify-draft C:\approved\账号权限办理规范.review-draft.json
```

## 人工审阅与发布

知识Owner须对照原文填写知识编码、标题、触发语、正式答案、变更单、审阅时间和失效时间，并将 `enabled` 改为明确审批后的状态。草稿本身不能导入；应另行形成符合 `config/knowledge-catalog.example.json` 的发布目录。

若发布目录也受SafeNet保护，使用Python桥接器。它在Python内读取逻辑JSON，通过标准输入内存管道交给Node导入，不生成额外明文副本：

```powershell
python tools/import_knowledge_catalog.py `
  --file C:\approved\knowledge-catalog.json `
  --database data\demand-platform.db `
  --dry-run

python tools/import_knowledge_catalog.py `
  --file C:\approved\knowledge-catalog.json `
  --database data\demand-platform.db `
  --imported-by E-KB-ADMIN
```

凭据不得出现在来源、草稿或发布目录中。生产数据库写入前仍须执行公司正式知识审批和变更流程。
