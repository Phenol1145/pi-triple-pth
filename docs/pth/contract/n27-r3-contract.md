# N27-R3 契约：verification binding + VerificationPlan + Domain subset 一致性

> 对应复验报告 **P0-3、P1-1、P1-2**。
> 文件域：`src/pth/execution/{knowledge-verdicts,knowledge-promotion}.ts`、
> `src/pth/tasking/{task-control-service,task-work-item-reader}.ts`、
> `src/pth/kernel/storage/schema.ts`、`src/pth/application/gateway/pth-gateway-facade.ts`、
> `src/pth/gateway/routes-kernel.ts`。
> 依赖：**R1 已合并**（共用 `knowledge-promotion.ts` 的 CAS 路径）。

## 1. 目标

1. 修复 stale verdict 可晋升新版本的漏洞（P0-3）：verdict 严格绑定不可变 candidate revision。
2. 引入持久 `VerificationPlan`，把 required domains、candidate revision、eligible principals/roles、
   separation rule、execution/grant、evidence requirement 与 quorum 落库（P1-2）。
3. 把 service 层授权从"可选 opts"改为强制（P1-2）。
4. 修复 delegate 显式 domains 子集不裁剪 binding 导致 claim 丢弃整个 binding（P1-1）。

## 2. 阻塞项引用

**P0-3 原文要点：** F3 分契约要求 `candidateRevision === entry.meta.version`；实现只拒绝大于
当前 version 的 verdict（`knowledge-verdicts.ts#L171-L186`）。现有测试名为"不等于拒绝"，
实际只测试 future revision，没有测试 stale lower revision。

**P0-3 关闭条件原文：**

> Review/Verification 必须绑定不可变 candidate revision；内容、证据、Domain 或 effect 变化后
> 旧决定失效。多 reviewer 场景不能靠每次 append 都修改 candidate version 来表达，应把
> candidate content revision 与 review-row version 分开。

**P1-1 原文要点：** delegate 接受 domains 子集，但仍原样写入父 binding
（`task-control-service.ts#L100-L117`）。父 binding 含 A、B，子任务只保留 A，claim reader 会因
binding 含 B 而丢弃整个 binding（`task-work-item-reader.ts#L47-L55`）。

**P1-1 关闭条件原文：**

> 需要按选中 domains 重新构造 matches/primaryDomain，保留 catalog/resolver version，并增加
> `publish(A,B) → delegate(A) → claim` 组合断言。

**P1-2 原文要点：** HTTP role gate 和 worker principal 解决了"明显匿名调用"，但没有持久
VerificationPlan 去绑定：required domains、candidate revision、eligible principals/roles 与
separation rule、execution/grant、evidence requirement 与 quorum。`recordKnowledgeVerdict` 的
server opts 仍可选，service 本身没有 grant/RBAC（`knowledge-promotion.ts#L24-L38`）。授权不能只
存在于某一个 HTTP adapter。

**P1-2 关闭条件原文：**

> 持久 VerificationPlan，service 层授权，严格 revision 绑定；修复 Domain subset binding。

## 3. 实施范围

| 文件 | 改动 |
|---|---|
| `src/pth/kernel/storage/schema.ts` | 新增 `knowledge_verification_plans` 表（或等价 plans + verdict rows 两表），见 §4.1 |
| `src/pth/execution/knowledge-verdicts.ts` | `canPromote` 改为读取持久 plan/verdict rows（不再信任 `meta.verdicts` 自报数组）；`validateKnowledgeVerdict` 增加 planId/checkId/candidateRevision/candidateHash 绑定 |
| `src/pth/execution/knowledge-promotion.ts` | `recordKnowledgeVerdict`/`promoteKnowledgeEntry` 增加强制 service 授权上下文；verdict 落 plan 表而非 append `meta.verdicts`；promotion 用 R1 CAS + 严格 candidate revision |
| `src/pth/tasking/task-control-service.ts` | delegate 显式子集时按选中 domains 重构造 `domainBinding.matches` + `primaryDomain` |
| `src/pth/tasking/task-work-item-reader.ts` | 如需：保持 fail-closed 校验，补组合测试 |
| `src/pth/application/gateway/pth-gateway-facade.ts` + `src/pth/gateway/routes-kernel.ts` | 把 auth（principalId/executionId/role/tenantId）作为强制 service 上下文传入；worker 路径同样强制 |
| 测试 | `test/pth-execution/knowledge-verdicts.test.ts`、`test/pth-execution/knowledge-promotion.test.ts`、`test/pth-tasking/task-control-service.test.ts`（或已有 tasking 测试） |

## 4. 设计裁决要点

### 4.1 持久 VerificationPlan（最小形状）

- 表 `knowledge_verification_plans`：`id`、`tenant_id`、`candidate_id`、`candidate_revision`
  （= candidate content revision，建计划时快照）、`candidate_hash`（覆盖 content+domains+evidence，
  实现函数放 `knowledge-verdicts.ts`）、`required_domains`（jsonb 数组）、`checks`（jsonb：
  `{checkId, kind: domain|adversarial, domainId?, quorum, eligiblePrincipals, separationFrom}`）、
  `source_bindings_digest`（本轮可为空串，R5 接入 EvidenceRef 后填实）、`status`
  （`open|satisfied|rejected|invalidated`）、`row_version`、时间戳。
- verdicts 不再 append 到 `entry.meta.verdicts`；新增 `knowledge_verdict_rows`（或 plan 内
  jsonb 但必须有 row 级 version）：每条 verdict 必须绑定 `planId + checkId +
  candidateRevision + candidateHash + principalId + executionId`。同 check 同 principal 幂等，
  不同 payload 同 key 是 conflict（不覆盖）。
- `canPromote(entry)` 的输入改为 `entry + plan + verdict rows`：plan.status=satisfied、
  每条 check quorum 独立满足、所有 verdict 的 candidateRevision/candidateHash 与 plan 一致、
  separation 满足、无 reject。旧 `meta.verdicts` 数组只作历史显示，**不再参与晋升判定**。

### 4.2 candidate content revision 与 review row version 分离

- `meta.version` 继续作为 **candidate content revision**：只有 content / domains / evidence /
  effect 的物化变更才递增（R1 语义）；追加 verdict 不再写 `memory_entries`（或写也不递增
  version——实施者二选一，但必须保证 verdict append 不改 candidate content revision）。
- verdict 行的顺序用独立 `row_version`（或 created 序列）表达，与 candidate revision 无关。
- `recordKnowledgeVerdict` 必须显式携带 `expectedCandidateRevision`，服务端与 plan 的
  `candidate_revision` 比对，不相等（无论未来还是 stale）一律拒绝；不再接受
  "以当前 entry.meta.version 盖章"。

### 4.3 service 层强制授权

- `recordKnowledgeVerdict` / `promoteKnowledgeEntry` 增加必填
  `auth: { principalId, executionId, roleId?, grantId? }`（无缺省、无可选 opts）。
  HTTP 路由从 auth 注入；worker 路径从 worker principal/execution 注入。
- `recordKnowledgeVerdict` 只接受 `planId + checkId`：服务端按 plan 的 `eligiblePrincipals` +
  `separationFrom`（producer / other-verifier / promoter）校验后落库；domain check 校验
  `domainId` 与 plan 一致；adversarial 校验 kind 与 principal 分离。
- `promoteKnowledgeEntry` 只接受 `planId + expectedCandidateRevision`；R1 CAS 单事务内重读
  plan/verdict 确认 satisfied，并在同一事务写 official + 决定 + 索引 outbox。

### 4.4 Domain subset binding（P1-1）

- delegate 在 `input.domains` 为真子集时：以父 `domainBinding.matches` 为源，只保留
  `domainId ∈ childDomains` 的 matches；`primaryDomain` 取保留集中父 primary 顺序的第一个；
  保留 `catalogVersion`/`resolverVersion` 与父一致；若保留集为空 → 报错（不产出空 binding）。
- claim reader 的校验逻辑不变（fail-closed），但必须通过组合断言证明不会丢弃合法子集 binding。

## 5. 非目标

- 不实现 N26 完整 VerificationPlan（source bindings、asOf、conflict resolution 不在本 lane）。
- 不改 outbox（R4）、不改评测/EvidenceRef 链（R5）。
- 不改变 HTTP 路由已有 platform-admin 门（R3 在其上加 service 层授权，不撤销路由门）。

## 6. 验收标准

### 6.1 定向测试（真实 PG）

- `knowledge-verdicts.test.ts`：
  - `canPromote rejects verdict with stale candidateRevision even when lower than current version`
  - `canPromote rejects verdict whose candidateHash differs from plan`
  - `canPromote requires plan.status=satisfied and per-check quorum`
  - `verdict rows have independent row_version; append verdict does not bump candidate meta.version`
- `knowledge-promotion.test.ts`：
  - `recordKnowledgeVerdict without auth context is rejected`
  - `recordKnowledgeVerdict binds planId/checkId and rejects stale expectedCandidateRevision`
  - `promoteKnowledgeEntry requires planId and expectedCandidateRevision (CAS)`
  - `concurrent verdicts on same check are idempotent; different payload same key is conflict`
  - `promotion reads verdict rows only from plan table, not meta.verdicts`
- `task-control-service.test.ts`（或 tasking 组合）：
  - `publish(A,B) → delegate(A) → claim keeps binding with only A`
  - `delegate(subset) preserves catalogVersion/resolverVersion and primaryDomain order`
  - `delegate(empty subset or overreach) rejected`

### 6.2 关闭条件对账表

| 关闭条件 | 证据 |
|---|---|
| Review/Verification 绑定不可变 candidate revision | 6.1 前两例 + `recordKnowledgeVerdict ... stale` |
| 内容/证据/Domain/effect 变化后旧决定失效 | plan 的 candidateHash 覆盖 content+domains+evidence；`canPromote rejects ... hash differs` |
| candidate content revision 与 review-row version 分离 | `append verdict does not bump candidate meta.version` |
| 持久 VerificationPlan 绑定六要素 | schema 落库 + `requires plan.status=satisfied and per-check quorum` |
| service 层授权强制 | `recordKnowledgeVerdict without auth context is rejected` |
| Domain subset 重构造 matches/primaryDomain + 组合断言 | 6.1 tasking 三例 |

### 6.3 全量门槛

- `npx vitest run`（连接 compose PG/Redis）全绿；`npm run lint` 全绿。
- 一条 commit；返回改动文件、测试结果、真实 PG 探针输出、偏差说明。
