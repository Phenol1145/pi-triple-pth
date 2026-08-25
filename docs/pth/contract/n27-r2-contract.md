# N27-R2 契约：raw query 数据面租户隔离

> 对应复验报告 **P0-2**。
> 文件域：`src/pth/application/gateway/pth-gateway-facade.ts` + `src/pth/execution/knowledge-broker.ts`。

## 1. 目标

让 raw SQL（`bridgeQuery` / broker `query` op）从"仅入口授权"升级为**数据面强制**
tenant/status/space 隔离：服务端注入或强制谓词，调用方 SQL 不能读到其租户/空间之外、
非 official 或非当前 policy 允许的行。

## 2. 阻塞项引用

**P0-2 原文要点：**

- Gateway 已限制 tenant-agent 调用 raw query，但 facade 明确忽略 tenant
  （`pth-gateway-facade.ts#L83-L85`）；Broker 直接执行 caller SQL，只做事后 space 过滤
  （`knowledge-broker.ts#L112-L142`）。
- `platform-admin` 是"谁可以调用"的授权问题，不是"返回哪些租户数据"的隔离证明。

**关闭条件原文：**

> raw query 必须走受限查询 AST/视图/行级策略之一，由服务端强制 tenant、status 和 space 条件；
> 增加跨租户真实 PG 负向测试。若决定 platform-admin 可跨租户，必须另行裁决并要求显式目标租户
> 与审计，不能依赖隐式全局查询。

## 3. 实施范围

| 文件 | 改动 |
|---|---|
| `src/pth/execution/knowledge-broker.ts` | `op === "query"` 不再直通 `dataWorld.queryReadOnly(callerSQL)`；改为受限查询入口（AST/视图/RLS 之一，见 §4） |
| `src/pth/application/gateway/pth-gateway-facade.ts` | `bridgeQuery(sql, tenantId?)` 不再忽略 tenant；把调用方 tenant 传透给受限查询入口；platform-admin 跨租户路径按 §4.4 裁决约束 |
| `src/pth/gateway/routes-kernel.ts`（如需要） | 路由层把 auth 的 tenant/role 明确传入 facade，不再只传 SQL 字符串 |
| 测试：`test/pth-execution/knowledge-broker.test.ts` + 真实 PG 探针 | 跨租户/跨 status/跨 space 负向 + 多语句/非 SELECT 拒绝 |

## 4. 设计裁决要点

1. **三选一，选型理由留给实施者，但必须满足本约束集**：
   - （a）受限查询 AST：只允许 `SELECT <列白名单> FROM memory_entries[/skills 视图] WHERE ...`，
     服务端解析后追加 `tenant_id = $n AND status = 'official' AND <space 谓词>`；拒绝 JOIN/子查询/DDL/多语句。
   - （b）视图 + 参数化：创建 `memory_entries_visible` 视图，查询只能打该视图，视图定义内置
     tenant/status/space 谓词（tenant 经事务局部 GUC 或参数化函数注入）。
   - （c）PG 行级安全策略（RLS）：`SET LOCAL` 事务级参数 + `USING` 策略强制 tenant/status/space；
     所有 raw 查询必须在该事务内执行。
   - **无论选哪种**：调用方原文 SQL 都不得直接拼进 `queryReadOnly`；space 谓词必须与
     `isVisible(meta, space)` 语义一致（public/space/private 与 grant space 的关系）。
2. **默认 fail-closed**：解析/匹配失败、多语句、非 SELECT、缺 tenant、缺 grant 能力
   （保留 `memory.query` 门禁）一律 403/400，不执行 SQL。
3. **数据面三层强制**：tenant（来自 grant/路由，不可自报）、status（raw query 只回
   `status='official'`，诊断需要 draft 时必须有显式 audit 的额外参数）、space（服务端谓词，
   不得只靠 JS post-filter——`isVisible` 逻辑可抽为 SQL 可表达的谓词或与 JS 过滤同一函数
   双跑对账）。
4. **platform-admin 跨租户**：本 lane 默认 **deny**（admin 也按自身租户查询）。若实施者认为
   必须保留跨租户诊断：必须显式传目标 `tenantId` + 独立审计事件（谁、何时、查了哪个租户、
   SQL 原文）且默认关闭；不得保留 `bridgeQuery(sql, _tenantId?)` 忽略 tenant 的隐式全局路径。
   这属于本契约允许的裁决，但必须在 PR 描述与测试中说明。
5. **retrieve/search/get 不动**：常规知识访问已 tenant-bound；本 lane 只收口 raw query。

## 5. 非目标

- 不改 `memory_entries` 表结构 / 不加 RLS 之外的策略表（若选 RLS，迁移只允许加策略）。
- 不改 retrieve/search/get 的可见性逻辑（除非抽公共谓词复用）。
- 不做 N26 的 fetch/use 双阶段信任策略。

## 6. 验收标准

### 6.1 定向测试（真实 PG，双租户 seed）

- `raw query cannot read other tenant rows`：tenant A 的 raw query 对 tenant B 的
  `memory_entries` 返回 0 行。
- `raw query cannot read draft or archived rows`：同 tenant 下 draft/archived 不可见。
- `raw query cannot read other space rows`：构造同 tenant、space=other 的条目，raw query 不可见。
- `raw query rejects multi-statement and non-select`：`"SELECT 1; DROP ..."` 与 `UPDATE` 被拒。
- `raw query without memory.query capability is 403`（保留 F2 门禁回归）。
- `platform-admin cross-tenant path requires explicit target tenant and audit`（若实现该裁决）：
  不传目标 tenant 时 deny；传入时写审计。

### 6.2 关闭条件对账表

| 关闭条件 | 证据 |
|---|---|
| raw query 走受限查询 AST/视图/行级策略之一 | 实现选用方案 + 上面前四例 |
| 服务端强制 tenant、status、space | 每层一个真实 PG 负向测试（6.1 前四例） |
| 跨租户真实 PG 负向测试 | `raw query cannot read other tenant rows` |
| platform-admin 跨租户须显式目标租户 + 审计 | 6.1 最后一例（若不实现跨租户，PR 明确"已 deny"并说明） |

### 6.3 全量门槛

- `npx vitest run`（连接 compose PG/Redis）全绿；`npm run lint` 全绿。
- 一条 commit；返回改动文件、选型理由、测试结果、真实 PG 探针输出、偏差说明。
