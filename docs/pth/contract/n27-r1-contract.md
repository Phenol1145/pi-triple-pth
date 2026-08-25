# N27-R1 契约：revision/version 正确性与 promotion CAS

> 对应复验报告 **P0-1**。
> 文件域：`packages/pth-memory/src/memory-store-pg.ts` + `src/pth/execution/knowledge-promotion.ts`。

## 1. 目标

统一 `PgMemoryStore.write` / `update` 的变更判据与 version 递增规则，消除
「写历史但不递增 version」导致 `memory_revisions(entry_id, tenant_id, revision)` 唯一键冲突
（`23505`）的缺陷；为 knowledge promotion 提供带 expected-revision 的原子 CAS 与单事务写入。

## 2. 阻塞项引用

**P0-1 原文要点：**

- `PgMemoryStore.write` 判断 status/meta-only 变化为非幂等并写入旧 revision
  （`memory-store-pg.ts#L142-L176`）；但 UPSERT 的 version 分支只比较 content 与声明的
  `meta.version`（`memory-store-pg.ts#L192-L203`）。
- 真实 PG 探针：第一次 status/meta-only mutation 写 revision=1 后当前 version 仍为 1；
  第二次 mutation 再插 revision=1 → `23505`。
- promotion 仍是 `get → canPromote → write`（`knowledge-promotion.ts#L93-L130`），没有把
  candidate revision 检查、verdict 消费、official 写入和索引事件放入同一事务。

**关闭条件原文：**

> 统一 write/update 的变更判据和 version 递增规则；为 promotion 提供
> `tenant + candidateId + expectedRevision + status=draft` CAS，并在同一事务写入不可变决定、
> official 状态、revision 与后续 outbox。

## 3. 实施范围

| 文件 | 改动 |
|---|---|
| `packages/pth-memory/src/memory-store-pg.ts` | write 的 ON CONFLICT 版本递增 CASE 改用与"是否写历史"完全一致的物化变更判据；新增 promotion CAS 原语（或等价事务方法） |
| `src/pth/execution/knowledge-promotion.ts` | `promoteKnowledgeEntry` 改用 CAS 单事务路径，删除 `get → canPromote → write` 非原子路径 |
| 测试：`packages/pth-memory/test/memory-store-pg.test.ts` | 真实 PG：status/meta-only 连续 mutation、幂等重放、version/revision 对账 |
| 测试：`test/pth-execution/knowledge-promotion.test.ts` | 真实 PG：promotion CAS、stale expectedRevision、并发 promotion、promotion 后二次 mutation |

## 4. 设计裁决要点

1. **统一变更判据（write）**：物化变更 = `content 不同` OR `status 不同`（缺省 official 归一）
   OR `effective meta 不同`（剥离系统生成键 `updatedAt` 后比较；`version` 参与声明比较但由本方法
   重写）。write 里「是否写 history」与 UPSERT 的「是否 version+1」必须使用同一判据——
   写了 history 就必然 `version = old.version + 1` 且 `meta.version = old.version + 1`。
2. **版本语义（历史行）**：`memory_revisions` 行记录**变更前的旧状态**，`revision` 字段填旧
   `version`（与现有 `update` 语义一致）。因此：首次写入 version=1 不写历史；每次物化变更
   version 递增后再写历史时 revision 必不重复；连续 N 次 mutation 得到
   `version = N+1`、`revisions = [1..N]`，不得出现 `23505`。
3. **幂等重放**：`write` 重放与旧行完全一致（content + status + declared version + effective
   meta）时不写历史、不递增 version；但**只要判据认定物化变更，就必须递增**——不允许再出现
   "status/meta-only 变化"被当成非幂等写历史却又不递增。
4. **promotion CAS 原语**：在 `PgMemoryStore` 增一个单事务方法（命名实施者定，如
   `promoteOfficial(id, tenantId, expectedRevision, promotionMeta, opts)`），在同一 PG client 内：
   `BEGIN` → `SELECT ... WHERE id=$1 AND tenant_id=$2 FOR UPDATE` → 校验
   `status='draft'` 且 `meta.version === expectedRevision` → 校验 `canPromote`（用锁内行）→
   写 `memory_revisions`（旧 revision）→ UPDATE `memory_entries` 为 official、`version+1`、
   `meta` 合并 `meta.promotion` → 写入决定/索引 outbox（若本 lane 已具备 outbox 表结构；
   与 R4 的字段叠加不得冲突）→ `COMMIT`。不满足 CAS 时抛结构化冲突错误，不静默返回。
5. **服务层**：`promoteKnowledgeEntry` 必须携带 `expectedRevision`（取自调用方读到的
   candidate revision），并把 `canPromote` 决策放在 CAS 事务内、基于锁内行重算——禁止
   "先 get 判、后 write 写"的窗口。
6. **schema 不变**：`memory_revisions` 唯一索引 `(entry_id, tenant_id, revision)` 已存在，
   本 lane 不新加列/表（outbox 表字段留给 R4）。

## 5. 非目标

- 不修 P0-3 stale verdict（verdict 严格绑定属于 R3，本 lane 只保证 promotion CAS 的
  `expectedRevision` 与当前 `meta.version` 严格相等）。
- 不改 outbox 的 claim/lease（R4）。
- 不改 raw query（R2）、不改评测与 EvidenceRef（R5）。
- 不改 `knowledge-verdicts.ts` / `task-control-service.ts` / `refiner.ts`。

## 6. 验收标准

### 6.1 定向测试（真实 PG 探针，宿主无 DB skip 不算数）

- `memory-store-pg.test.ts`：
  - `write status/meta-only mutation increments version and writes old revision`
  - `write three consecutive mutations produce distinct revisions without 23505`
  - `write idempotent replay does not write history nor increment version`
  - `write then update then archive preserves monotonic versions and revisions`
- `knowledge-promotion.test.ts`：
  - `promoteKnowledgeEntry uses atomic CAS and rejects stale expectedRevision`
  - `concurrent promotions with same expectedRevision allow exactly one winner`
  - `promotion then second status mutation does not hit revision unique violation`
  - `promotion writes meta.promotion and official revision in one transaction`

### 6.2 关闭条件对账表

| 关闭条件 | 证据 |
|---|---|
| 统一 write/update 变更判据和 version 递增规则 | 上面 `memory-store-pg.test.ts` 四例 + 复验原探针序列改为断言 `{v1:1, v2:2, v3:3, revisions:[1,2]}` 无错误 |
| `tenant + candidateId + expectedRevision + status=draft` CAS | `promoteKnowledgeEntry ... stale expectedRevision` + `concurrent promotions ... one winner` |
| 同一事务写入不可变决定、official 状态、revision 与后续 outbox | promotion 测试用可观察 hook 注入 outbox 写入失败 → 断言事务回滚（official 未写、revision 未写） |

### 6.3 全量门槛

- `npx vitest run`（连接 compose PG/Redis）全绿；`npm run lint` 全绿。
- 一条 commit；返回改动文件、测试结果、真实 PG 探针输出、偏差说明。
