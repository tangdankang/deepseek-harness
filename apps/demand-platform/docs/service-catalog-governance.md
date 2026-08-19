# 服务目录配置与版本治理

服务项通过 JSON 配置导入，不需要修改核心代码。示例见 `config/service-catalog.example.json`。

## 校验但不写入

```powershell
node scripts/import-service-catalog.mjs --file config/service-catalog.example.json --dry-run
```

如果指定的数据库尚不存在，`--dry-run` 使用内存数据库，不会在磁盘留下空文件。要验证对现有目录的升级，请显式提供已有数据库：

```powershell
node scripts/import-service-catalog.mjs `
  --file config/service-catalog.example.json `
  --database data/demand-platform.db `
  --dry-run
```

## 正式导入

先备份数据库并完成审批，再去掉 `--dry-run`。生产环境应把该命令放入受控发布流水线，不向普通员工开放管理 API。

```powershell
node scripts/import-service-catalog.mjs `
  --file approved/service-catalog.json `
  --database data/demand-platform.db `
  --imported-by E-CATALOG-ADMIN `
  --change-ref CHG-2026-0001
```

`--imported-by` 和 `--change-ref` 均为正式写入必填项，也可分别由安全执行环境注入 `SERVICE_CATALOG_IMPORT_ACTOR`、`SERVICE_CATALOG_CHANGE_REF`。命令输出隐藏数据库绝对路径。

## 版本规则

- 新服务的 `schema.version` 必须从 1 开始。
- 已发布服务的 Schema 内容不变时可以幂等重放同一版本，元数据会更新。
- 字段有任何变化必须将版本递增 1；不允许跳版本。
- 历史 Schema 不覆盖、不删除，已有需求继续绑定创建时的版本。
- 已发布服务不得修改 `targetSystem` 或 `targetTicketType`；如需改路由，应创建新服务编码并制定迁移计划。
- `enabled: false` 用于停止新服务发现；生产停用前仍需处理在途需求并做好员工通知。
- 每次实际创建、元数据/受众变更或Schema升级都会生成新的服务修订；修订保存完整规范、SHA-256、操作人和变更单。
- 完全相同的重放返回 `REPLAY`，不重复写修订。
- 修订表通过数据库触发器禁止更新和删除；当前服务状态与修订不一致时拒绝继续发布。
- 旧服务首次纳入治理时必须先按当前Schema建立基线，不能在同一次操作中同时升级Schema。

## 员工可见范围

每个服务可配置 `audiencePolicy`：

```json
{
  "audiencePolicy": {
    "visibility": "DEPARTMENTS",
    "departmentIds": ["D-ORG"],
    "includeDescendants": true,
    "includeEmployeeIds": ["E-MATRIX-001"],
    "excludeEmployeeIds": ["E-RESTRICTED-001"]
  }
}
```

- `ALL_EMPLOYEES`：面向全员，`departmentIds` 必须为空；
- `DEPARTMENTS`：面向指定部门或明确包含的员工，必须至少配置一个入口；
- `includeDescendants: true`：指定部门及其全部下级部门可访问；正式发布前要求存在新鲜的受治理组织目录；
- `includeEmployeeIds`：用于少量跨部门兼职或临时例外；不替代正式矩阵组织建模；
- `excludeEmployeeIds`：始终优先于部门和包含名单，适合隔离冲突岗位或测试账号；
- 未配置时为兼容旧目录，默认 `ALL_EMPLOYEES`；
- 服务端在目录搜索、详情、Schema、草稿创建/更新、确认和提交时重复校验；
- 无权访问与服务不存在统一返回404，避免枚举内部服务；
- 受众策略收紧后，员工仍可查询本人历史工单，但不能继续修改或提交尚未完成的草稿。

部门编号必须来自可信身份网关注入并签名的主部门及成员部门集合，不能采用模型或员工消息中的自报部门。精确部门和部门子树会对全部可信成员部门求并集，人员排除仍拥有最高优先级。受众范围变更属于权限变更，正式导入前必须经过服务Owner和信息安全审批。

部门子树只使用最新且未过期的不可变组织快照。快照缺失、过期或员工部门不在快照中时，子树匹配默认拒绝；依赖子树的服务存在时，就绪探针同步返回503。精确部门和显式员工例外不依赖层级展开。详细发布规则见 `organization-directory-governance.md`。

## 字段约束

支持 `string`、`textarea`、`date`、`enum`、`boolean`、`array`。字段名使用 lowerCamelCase；枚举值、关键词和字段名不得重复；无效正则、长度冲突、未知类型和空字段集会在导入前被拒绝。

服务目录文件不应包含密码、Token、API Key 或私钥。系统字段映射和连接器凭据分别进入受控配置与密钥系统。
