# N24-F2 契约：复合租户身份 + TenantScope fail-closed + raw query 门禁（AB-01）

## 1. 复合身份迁移（pth-memory）

`MEMORY_SCHEMA_SQL` 追加幂等迁移（顺序执行）：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_entries_tenant_id_id ON memory_entries(tenant_id, id);
ALTER TABLE memory_entries DROP CONSTRAINT IF EXISTS memory_entries_pkey;
ALTER TABLE memory_entries ADD PRIMARY KEY (tenant_id, id);
```

`PgMemoryStore` 全部 SQL 按 `(tenant_id, id)` 复合身份改写：

- `write`：`SELECT … WHERE id=$1 AND tenant_id=$2 FOR UPDATE`；
  `INSERT … ON CONFLICT (tenant_id, id) DO UPDATE`；
  同 id 不同 tenant 可并存（新增负向/并发测试）；
- `incrementAggregate`：`ON CONFLICT (tenant_id, id) DO UPDATE WHERE tenant_id=EXCLUDED.tenant_id`；
- 其余方法已 tenant 过滤，保持不变。

## 2. TenantScope fail-closed（requireTenant）

- `PgMemoryStore` 构造 opts 增 `requireTenant?: boolean`（缺省 false，兼容包测试）；
- `requireTenant=true` 时：`write` 必须 `entry.tenantId`、`get/update/retrieve/listIds/
  bumpHitCount/incrementAggregate/revisionHistory/restoreRevision` 必须显式 `opts.tenantId`，
  缺失抛 `memory: tenantId required（TenantScope fail-closed）`；
- `createDataWorld(pool, routing?, disciplineResolver?, opts?)` 透传
  `{ requireTenant: true }`；assembly 与 batch-process 的**全部 src/pth 内部调用点**
  改为显式传 tenant（系统通道用 `DEFAULT_TENANT_ID`）；以 tsc 全绿 + 全量测试为界。

## 3. raw query 门禁（bridge + broker）

- `KnowledgeBroker.authorize`：
  - `query` op 额外要求 `grant.capabilities.includes("memory.query")`，否则 403；
  - `retrieve/search/get` 保持 `memory.read`；
- `kernel-manager.ts` 签发 sandbox grant 时把角色能力映射：
  `memory → ["memory.read"]`（**不** 授予 memory.query）；其它能力原样；
- `pth-gateway-facade`：
  - `bridgeQuery(sql, tenantId?)`：增加 tenantId 参数；
  - `bridgeRetrieve(anchors, kinds, tenantId)`：固定 `status:["official"]` + tenantId；
  - `bridgeGet(id, tenantId)`：tenantId + 非 official 返回 null；
- `routes-kernel.ts` memory-bridge：
  - op=query 仅 `auth.role === "platform-admin"`，否则 403；
  - retrieve/get 把 `auth.tenantId` 传入 facade（space 过滤仍走既有 auth.space 路径）；
- 测试：tenant-agent query 403；broker 无 memory.query 403、有 memory.query 可用；
  bridge retrieve 不回 draft/archived；跨 tenant bridge 读取隔离。

## 4. 测试与约束

- 真实 PG：同 id 两 tenant 并存、并发写、requireTenant 缺失抛错、复合 PK 迁移后旧行可读；
- 全量 vitest + lint 绿；worktree `.worktrees/f2` / `lane/f2-tenant-identity`；
- 只改契约列出的文件与内部调用点；不改 concepts/parallel-lanes/TODO/README；
- 一条 commit，返回偏差。
