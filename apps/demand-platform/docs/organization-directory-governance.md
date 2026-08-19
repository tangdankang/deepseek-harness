# 组织目录与部门层级授权治理

组织目录用于把钉钉/HR中的部门树转换成平台可复验的授权快照。平台不主动抓取尚未确认的租户接口；企业同步任务生成整包JSON后，通过受控命令发布。

## 快照格式

示例见 `config/organization-directory.example.json`。每个快照包含连续正整数版本、来源系统、生成/失效时间，以及1至10000个部门。部门必须引用同包内父部门，不允许孤儿、自引用、重复编号或循环。

快照有效期最长90天。建议企业每日同步，并把有效期控制在7天内；同步失败必须在到期前告警。

## 发布

```powershell
# 结构、层级和版本预检，不写数据库
node scripts/import-organization-directory.mjs `
  --file approved/organization-directory.json `
  --database data/demand-platform.db `
  --dry-run

# 正式发布
node scripts/import-organization-directory.mjs `
  --file approved/organization-directory.json `
  --database data/demand-platform.db `
  --imported-by E-ORG-SYNC `
  --change-ref CHG-2026-0001
```

正式发布也可通过 `ORGANIZATION_IMPORT_ACTOR` 和 `ORGANIZATION_CHANGE_REF` 注入操作人及变更单。凭据不进入快照。命令输出只包含文件名、版本、部门数和哈希，不输出部门清单或数据库绝对路径。

## 不可变与防回退

- 首版必须是1，以后只能递增1；
- 相同内容和版本为幂等 `REPLAY`，不产生新记录；
- 同版本不同内容、跳版本和回退均拒绝；
- 每版保存完整规范JSON和SHA-256；
- 数据库触发器禁止更新或删除历史快照；
- 运行时读取快照时复核SHA-256；
- 正式发布拒绝已过期或生成时间明显位于未来的快照。

## 授权优先级

1. `excludeEmployeeIds` 命中：拒绝；
2. `ALL_EMPLOYEES`：允许；
3. `includeEmployeeIds` 命中：允许；
4. 员工可信主部门精确命中 `departmentIds`：允许；
5. 启用 `includeDescendants` 且新鲜快照证明其位于指定部门子树：允许；
6. 其他情况：拒绝。

无权访问与服务不存在统一返回404。组织快照缺失或过期时，精确部门仍可使用，但所有依赖子树展开的匹配默认拒绝；只要有启用服务依赖子树，就绪探针返回503，阻止带缺陷实例接收流量。

## 企业接入边界

可信身份上下文支持一个主部门和最多20个经过v2签名的正式成员部门。服务目录与知识检索对全部成员部门执行授权；不能从员工聊天文本推断组织身份。若公司矩阵关系超过20个、包含动态角色或需要有效期，仍须结合真实IAM字段扩展独立角色/属性策略。真实部门编号、停用规则、矩阵组织和同步频率须由IAM/HR与信息安全共同确认。
