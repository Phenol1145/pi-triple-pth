# N24-F1 契约：canonical provenance + capability 合并 + revision 完整化

> 对应验收报告 AB-02 / AB-03 / 6.3。

## 1. Canonical provenance（AB-02）

- **唯一 canonical 位置 = `meta.provenance`**（KnowledgeProvenance 六字段）。
- `PgMemoryStore.write` 的 official 门禁改为：
  `validateKnowledgeProvenance(entry.meta?.provenance, entry.content)`；
  `meta.provenance` 缺失 → 拒绝（不再看 meta 根字段）。
- `knowledge-provenance.ts` 增 `provenanceFromMeta(meta)`（纯函数，兼容读取）。
- `canPromote` / refiner 已用嵌套，不变。
- `scripts/seed/seed-k5-pilot.ts`：删除顶层平铺六字段，只写 `meta.provenance`（N23 偏差 2 的
  workaround 移除）。
- 测试：真实 PG 链路 `draft domain-fact（meta.provenance）→ verdicts → promote → official`
  成功；顶层平铺不再被接受（新增负向）。

## 2. Knowledge capability 组合（AB-03）

- `AgentTaskRunner` 注入 KnowledgeContext 时：
  `capabilityInject["knowledge"] = { ...(caps["knowledge"] ?? {}), context: knowledgeContext }`
  ——与角色既有 `knowledge.review` / `knowledge.promote` 合并，不覆盖。
- `runAgentTask` 侧不得再整体替换 capability 根键（只在本 runner 合并即可）。
- 测试：adversarial + context 同时存在时 `knowledge.review` 与 `knowledge.context` 都在；
  memory-keeper 同理；developer 无 review/promote 但可有 context。

## 3. update 也记 revision + promotion 幂等重放（6.3）

- `PgMemoryStore.update(id, patch, opts)`：
  - opts 增 `createdBy?` / `reason?`；
  - 单 client 事务：`SELECT … WHERE id AND tenant_id FOR UPDATE` → 旧行写
    `memory_revisions`（revision=旧 version、reason=opts.reason ?? "update"）→ 执行现有
    UPDATE（tenant 条件不变）→ COMMIT；异常 ROLLBACK 重抛；release；
  - 幂等 no-op（patch 与旧值全同）不写历史。
- `promoteKnowledgeEntry` 幂等重放：若条目已 official 且
  `meta.promotion?.promotedBy === promoterRole`，返回 `{ ok: true, id }`（replay 不重复写）；
  若 official 但无本 promoter 的 promotion 记录 → 拒绝。
- 测试：verdict/reject 的 update 产生 revision；重复 promote 幂等 ok；真实 PG 覆盖。

## 4. 约束

- worktree `.worktrees/f1` / 分支 `lane/f1-knowledge-canonical`；
- 只改本契约列出的文件与测试；不改 concepts/parallel-lanes/TODO/README；
- 全量 vitest + lint 绿后一条 commit；返回改动文件、测试结果、偏差。
