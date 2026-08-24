# N28-T3 契约：确定性内存 MemoryDirectory（重叠 + unclassified 覆盖）

> 对应实施计划 Task 3（docs/pth/plan/n28-role-memory-orchestration-implementation-plan.md L637–L1104）；验证假设：H2：Region 可重叠且不复制正文；四类记忆全覆盖；ownerless 禁止
> 上游依赖：T1（MemoryRegion/MemoryResponsibility/ResponsibilityCapacity）
> Gate 0 记录：N27 最终复验报告 docs/pth/report/v1.2-acceptance-fix-revalidation-final.md 为 ACCEPTED；复验对象 main@c2c0729（R6=4d0a38b 经 merge c2c0729 合入 main，R1–R6 全部 merged）；N28 设计/计划基线 commit 9f10082（docs-only）。本 lane 实现分支必须派生自包含 9f10082 的 main，且首条 commit 信息注明 Gate 0 已过。
> 车道：分支 lane/n28-t3-memory-directory，worktree .worktrees/n28-t3，串行合并顺序 T1→T2→T3→T4→T5→T6→T7。

## 1. 目标

按计划 Task 3 标题与 Expected，本 lane 构建确定性内存 `MemoryDirectory`：Region 可重叠，跨域条目可命中多个 Region 但正文只保存一份；100 条授权 fixture 覆盖 setting/wiki/skill/log 四类，每条 official 条目要么命中声明 Region、要么进入显式 `region:unclassified`，ownerless Region 禁止。重排输入产生相同 snapshotId，content 修订后 snapshotId 与 corpusFingerprint 改变；entry revision/content hash/index hash/epoch 校验 fail-closed。

## 2. 上游接口（Consumes）

- `MemoryRegion` — `src/pth/contracts/index.ts` — 上游 Task 1（冻结产出）。
- `MemoryResponsibility` — `src/pth/contracts/index.ts` — 上游 Task 1（冻结产出）。
- `ResponsibilityCapacity`、`checkResponsibilityCapacity()` — `src/pth/contracts/index.ts` — 上游 Task 1（冻结产出）。
- `MemoryType` — `src/pth/contracts/index.ts` — 上游 Task 1（冻结产出）。
- `WorkerReplicaRef`（active `WorkerReplicaRef[]`）— `src/pth/contracts/index.ts` — 上游 Task 1（冻结产出）；运行实例形态由 Task 2 提供。
- 顶层 tenant identity 与显式 repository revision/classification projection：围绕既有 `KnowledgeMemoryEntry` 形状传入 `DirectoryEntryInput`（`entry.tenantId` + 正整数 `revision` + `memoryType`）— `src/pth/execution/knowledge-broker.ts` 的既有 `KnowledgeMemoryEntry`（本 lane Step 1 增补可选顶层 `tenantId?: string`）；真实 store adapter 为未来工作，本 lane 以冻结 fixture projection 显式传入。

## 3. 实施范围

| 文件 | 改动 |
|---|---|
| Create: `src/pth/execution/memory-type-classifier.ts` | 新建规范化分类投影边界，导出 `MemoryTypeClassifier` 与 `classifyFeasibilityMemoryType()`；冻结可行性映射（wiki/setting/skill/log），未知 kind 返回 `undefined` |
| Create: `src/pth/execution/memory-directory.ts` | 新建确定性内存 Directory：`MemoryDirectorySnapshot`、`buildMemoryDirectorySnapshot()`、`assertMemoryDirectorySnapshotIntegrity()`、`assertMemoryDirectoryResponsibilityCapacity()`、`responsibilitiesForWorker()`、`membershipsForEntry()`、`regionEntryIds()` |
| Modify: `src/pth/execution/knowledge-broker.ts` | `KnowledgeMemoryEntry` 增加可选顶层 `tenantId?: string`；Broker adapter 保留 repository 返回的顶层 tenant，不镜像进 `meta` |
| Modify: `src/pth/execution/index.ts` | 增加 `export * from "./memory-directory.js";` |
| Create: `scripts/n28-feasibility-fixture.ts` | 生成恰好 100 条 authorized official entries + 7 行 authorization/visibility 探针矩阵；冻结 `N28_ROLE`/`N28_ROLE_LOAD_POLICIES`/`N28_DOMAIN_IDS`/`N28_WORKERS`/`N28_REGIONS`/`N28_RESPONSIBILITIES` 与 `n28TrapCorpus()` |
| Create: `test/pth-execution/memory-directory.test.ts` | 7 个定向测试：重叠不复制、四类覆盖与 unclassified、确定性、责任容量、fail-closed 拒绝、完整性校验、新 official 进 unclassified |
| Create: `test/pth-execution/memory-type-classifier.test.ts` | 四类映射、未知 kind、`MemoryRegion.selector.memoryTypes` 查询 |

## 4. 接口产出（Produces，冻结表）

- `MemoryTypeClassifier` + `classifyFeasibilityMemoryType()`（`src/pth/execution/memory-type-classifier.ts`）— 冻结语义：`domain-fact|domain-method|pth-wiki → wiki`，`system-setting|role-definition|config → setting`，`skill|skill-index → skill`，`task-insight|episodic-log → log`；未知 kind 返回 `undefined`，Directory 构建 fail-closed 直到 repository adapter 提供 approved mapping。消费方：本 lane fixture `n28DirectoryInputs()`，并经 fixture 被 Task 4/Task 7 复用；生产化 store adapter 为后续工作。
- `MemoryDirectorySnapshot`（含 `RegionMembership`、`DirectoryEntryInput`，`src/pth/execution/memory-directory.ts`）— 冻结语义：**本文件独家拥有设计 §4.1 的这三个类型**（T1 contracts 不得重复定义）；单 tenant、不可变、确定排序；成员关系只保存 `tenantId/entryId/entryRevision/contentHash/indexHash/regionIds[]`，不保存正文；`unclassifiedEntryIds` 为 coverage 信号。消费方：Task 4（`createLayeredKnowledgeRetriever` 的输入与完整性源）、Task 6（Working Set 组装时做责任容量断言）。
- `buildMemoryDirectorySnapshot()` — 冻结语义：相同输入（含重排）→ 相同 `snapshotId`、memberships 与 Region weight；content 修订 → `snapshotId`/`corpusFingerprint` 改变；所有非法输入 fail-closed（见 §6）。消费方：Task 4（retriever 组装）、Task 6、Task 7（经 fixture）。
- `assertMemoryDirectorySnapshotIntegrity()` — 冻结语义：用 source entries 重建 snapshot，逐项比较 `snapshotId`/`corpusFingerprint`/JSON；任何篡改抛 `memory directory snapshot integrity mismatch`。消费方：Task 4（retriever 构造时先校验，L1424–L1427）。
- `assertMemoryDirectoryResponsibilityCapacity()` — 冻结语义：对每个 worker 调 `checkResponsibilityCapacity`，不通过即 fail-closed。消费方：Task 6（Working Set 组装，L2291）。
- `responsibilitiesForWorker()` — 冻结语义：返回某 worker 的全部责任绑定。消费方：Task 4（按 worker 构建 Region waves，L1431）。
- `membershipsForEntry()` — 冻结语义：返回某 entry 命中的 `regionIds[]`。消费方：本 lane 定向测试；后续任务按同一冻结 API 读取成员关系。
- `regionEntryIds()` — 冻结语义：返回某 Region 命中的 entryIds。消费方：Task 4（检索 harness 构造 regionSet，L1248/L1341）。

## 5. 关键步骤

与计划 L637–L1104 逐步骤对齐；任何冲突以计划步骤为规范。

- **Step 1**：`KnowledgeMemoryEntry` 增补可选顶层 `tenantId?: string`，Broker adapter 保留 repository 顶层 tenant 且不镜像进 `meta`；新建 `memory-type-classifier.ts`（冻结映射见 §4）并配套 classifier 测试；新建 `scripts/n28-feasibility-fixture.ts` 生成恰好 100 条 authorized official entries + 7 行探针矩阵。Expected：fixture 与分类器可用，`n28DirectoryInputs` 对未知 kind 抛错。
- **Step 2**：编写失败的重叠、覆盖与确定性测试（7 个 `MemoryDirectory` 用例，断言点见 §8.1）。Expected：测试先于实现存在并冻结本 lane 行为。
- **Step 3**：运行 `npx vitest run test/pth-execution/memory-directory.test.ts`。Expected：FAIL because `memory-directory.ts` does not exist。
- **Step 4**：实现 selector 匹配、重叠 membership 与稳定 snapshot hashing：`matches()` 组间 AND/组内 OR、`stable()` 确定性排序、`deepFreeze()` 冻结输出、builder 的 fail-closed 校验与 `estimatedWeight` 重算、完整性/容量断言。Expected：实现与 Step 2 冻结测试一致，不自行放宽任何抛错条件。
- **Step 5**：在 `src/pth/execution/index.ts` 导出 `memory-directory.js`，运行 `npx vitest run test/pth-execution/memory-type-classifier.test.ts test/pth-execution/memory-directory.test.ts test/pth-contracts/cognitive-responsibility.test.ts`。Expected：PASS；membership count is exactly 100 and reordered inputs share a snapshot ID。
- **Step 6**：按计划 `git add` 七个文件域并 `git commit -m "feat(pth): add overlapping memory directory snapshot"`。Expected：本 lane 一条 commit，只含 §3 文件域；偏差写入 commit body。

## 6. 设计裁决与红线

1. **重叠不复制正文**：一条 entry 可命中多个 Region（如 `alg-40` 命中 `region:algebra` 与 `region:numerical`），membership 只存 `regionIds[]` 与哈希，正文只保存一份；为重叠而复制正文是 No-Go（设计 §4.1、H2 No-Go）。
2. **单 tenant 不可变快照**：每个 Directory Snapshot 只属于一个 tenant，按 `tenantId + epoch` 工作；输入相同则 snapshotId、成员关系和 Region weight 完全相同；快照深层冻结（设计 §4.1）。
3. **分类投影是唯一真相**：`memoryType` 由 Knowledge 边界的规范化分类投影提供，不另造 kind→四类记忆的第二套真相；可行性 mapping 冻结且穷尽，未知 kind 返回 `undefined`，Directory fail-closed（计划 Step 1）。
4. **四类记忆全覆盖，silent omission 禁止**：任何 official 条目未命中声明 Region 必须进入虚拟 `region:unclassified` 并产生 coverage 信号；该 Region 必须显式出现在 `regions[]`、`mode:"unclassified"` 且空 selector（计划 Step 4、设计 §2.2/§4.1）。
5. **ownerless 禁止**：`region:unclassified` 与所有非虚拟 Region 都必须至少有一个 primary owner；责任指向无效 worker、重复绑定或 epoch 不匹配均拒绝（计划 Step 4、设计 §4.1）。
6. **selector 语义冻结为组间 AND、组内 OR**：`domains` 只读 `meta.domains` 中经 Catalog 验证的 DomainId，`memoryTypes` 读 `DirectoryEntryInput.memoryType`，`kinds` 读 entry.kind，anchor 条件只读 anchors；空 selector 非法，只有 `region:unclassified` 可以没有 selector（设计 §2.2）。
7. **身份与版本 fail-closed**：`tenantId` 来自 repository 顶层租户字段（不得复制进 `meta`），`revision` 为正整数（禁止 `meta.version ?? 1` 补造）；跨 tenant 条目、duplicate worker/region/responsibility、stale epoch、invalid revision、unknown selector domain 均抛错（计划 Step 4、设计 §4.1）。
8. **完整性校验 fail-closed**：membership 携带 `entryRevision`、`contentHash`、`indexHash`；`assertMemoryDirectorySnapshotIntegrity` 通过重建比较 snapshotId/corpusFingerprint/JSON，伪造 epoch/revision/content hash/index hash 必须抛 `/integrity mismatch/`（计划 Step 2/Step 4）。
9. **estimatedWeight 由 builder 重算**：`regionWeight = entryCount + ceil(totalContentChars / 4096) + selectorClauseCount`，输入权重仅校验非负有限；该公式只用于可行性容量门验证，不宣称生产成本模型（设计 §4.2）。
10. **实验预算数值照抄设计**：`maxRegions=3`、`maxPrimaryWeight=80`、`maxSecondaryWeight=40`（overlap + fallback）、`maxMemoryEntries=8`、`maxMemoryChars=4096`、`maxSkillIndexEntries=8`、`maxActiveSkills=4`、`maxSkillChars=8192`、`maxTools=16`；任何超限 fail-closed，不静默扩大上限（设计 §0/§4.2、计划 Global Constraints）。

## 7. 非目标

- 不建 PostgreSQL Region、Responsibility 或 membership 表；不做 membership transactional outbox 和重启恢复（设计 §1.2）。
- 不做自动发现、拆分、合并或迁移 Region；不做自动创建、合并、退役 Role Definition（设计 §1.2）。
- 不做 embedding、向量库或真实语义检索精度优化（设计 §1.2）。
- 不修改 N26 Source/Intake/Verification/Promotion 状态机（设计 §1.2）。
- 不把实验阈值直接宣布为生产默认值（设计 §1.2）。
- 不实现真实 store adapter 与 durable projection；本 lane 只交付内存确定性 Directory，分类投影以冻结 fixture 与 repository 显式传入为边界（计划 Step 1）。
- 不弱化任何 N27 已验收契约、不变量或回归测试（计划 Global Constraints）。

## 8. 验收标准

### 8.1 定向测试

计划中本 Task 的全部 Run 命令（vitest/tsc）：

- Step 3：`npx vitest run test/pth-execution/memory-directory.test.ts` — Expected：FAIL because `memory-directory.ts` does not exist。
- Step 5：`npx vitest run test/pth-execution/memory-type-classifier.test.ts test/pth-execution/memory-directory.test.ts test/pth-contracts/cognitive-responsibility.test.ts` — Expected：PASS；membership count is exactly 100 and reordered inputs share a snapshot ID。

关键断言点（Step 2 冻结用例）：

- `references one cross-domain entry from multiple regions without copying it`：`alg-40` 的 `regionIds` 等于 `["region:algebra","region:numerical"]`，且 corpus 中该 entry 仅 1 条（不复制正文）。
- `classifies every entry or records it as unclassified`：`memberships` 长度 100；`unclassifiedEntryIds` 等于 `["unclassified-only"]`；`regions` 中存在 `region:unclassified`；`memoryType` 集合等于 `["setting","wiki","skill","log"]`。
- `produces the same snapshot for reordered input and a different one for a content revision`：重排输入 `snapshotId` 相同、memberships 相同；`memberships[0].regionIds` 已冻结（push 抛错）；content 修订后 `snapshotId` 与 `corpusFingerprint` 均改变。
- `keeps both same-role replicas inside the fixed responsibility capacity`：`assertMemoryDirectoryResponsibilityCapacity` 不抛错；每个 worker `checkResponsibilityCapacity` 返回 `{ok:true}`；`maxRegions:0` 时抛 `/capacity exceeded/`。
- `rejects cross-tenant entries, duplicate bindings, stale epochs and ownerless regions`：跨 tenant 抛 `/tenant/`；重复 responsibility 抛 `/duplicate responsibility/`；epoch=0 抛 `/epoch/`；移除 `region:global-holdout` 责任抛 `/primary owner/`；责任指向未知 worker 抛 `/unknown worker/`；revision=0 抛 `/revision/`；selector domain 不在 catalog 抛 `/unknown selector domain/`。
- `rejects a forged revision, content hash, index hash or epoch before retrieval`：伪造 epoch=2、`contentHash`、`entryRevision`、`indexHash` 均抛 `/integrity mismatch/`。
- `places a newly promoted but unmatched official entry into unclassified on the next immutable snapshot`：before 100 条、after 101 条；`membershipsForEntry(after,"new-official")` 等于 `["region:unclassified"]`；before/after `snapshotId` 不同。
- classifier 测试：四类映射、未知 kind 返回 `undefined`、`MemoryRegion.selector.memoryTypes` 查询行为。

### 8.2 关闭条件对账表

> 特别注意（必须逐条满足）：100 条 fixture 覆盖 setting/wiki/skill/log 四类；region:unclassified 必须显式存在且有 primary owner；重排输入 snapshotId 不变、content 修订后改变；entry revision/content hash/index hash/epoch 校验 fail-closed；selector 语义=组间 AND、组内 OR，空 selector 非法；estimatedWeight 由 builder 重算（entryCount+ceil(chars/4096)+clauseCount）。合并者额外 review：membership 不得复制正文；跨 tenant 条目拒绝；重复 worker/region/responsibility 拒绝。

| 关闭条件 | 证据要求 |
|---|---|
| 100 条授权 fixture 覆盖 setting/wiki/skill/log 四类且全部属于声明 Region 或 `unclassified` | `classifies every entry or records it as unclassified`：`memberships` 计数为 100、`unclassifiedEntryIds=["unclassified-only"]`、四类 `memoryType` 集合齐全 |
| Region 可重叠且不复制正文 | `references one cross-domain entry from multiple regions without copying it`：`alg-40` 同时命中两个 Region 且 corpus 计数为 1；合并者 review membership 不含正文 |
| `region:unclassified` 显式存在且有 primary owner | 该测试断言 `regions` 中存在 `region:unclassified`；`rejects ... ownerless regions` 中移除 `region:global-holdout` primary 抛 `/primary owner/`；合并者 review `N28_RESPONSIBILITIES` 中 curator 对 `region:unclassified` 的 primary 绑定 |
| 重排输入 snapshotId 不变、content 修订后改变 | `produces the same snapshot for reordered input and a different one for a content revision`：重排后 `snapshotId`/memberships 相同，修订后 `snapshotId`/`corpusFingerprint` 不同 |
| entry revision/content hash/index hash/epoch 校验 fail-closed | `rejects a forged revision, content hash, index hash or epoch before retrieval` 四类篡改均抛 `/integrity mismatch/`；`rejects cross-tenant entries ...` 中 epoch=0 抛 `/epoch/`、revision=0 抛 `/revision/` |
| selector 语义=组间 AND、组内 OR，空 selector 非法 | Step 4 `matches()` 实现逐组 AND/组内 OR；builder 对 selector 空且非 unclassified 抛 `empty selector`；classifier 测试覆盖 `selector.memoryTypes` 查询 |
| estimatedWeight 由 builder 重算（entryCount+ceil(chars/4096)+clauseCount） | Step 5 vitest PASS 中 `keeps both same-role replicas inside the fixed responsibility capacity` 通过（间接证明重算非 0）；合并者 review Step 4 的 `regions` 重算代码不信任输入权重 |
| 合并者额外 review：跨 tenant 条目拒绝；重复 worker/region/responsibility 拒绝 | `rejects cross-tenant entries, duplicate bindings, stale epochs and ownerless regions` 抛 `/tenant/`、`/duplicate responsibility/`、`/unknown worker/`；builder 对 duplicate worker/region 分别抛错 |
| 不弱化 N27 已验收契约与回归测试 | Step 5 附带跑 `test/pth-contracts/cognitive-responsibility.test.ts`（T1 冻结契约）PASS；全量门槛见 §8.3 |

### 8.3 全量门槛

合并者合并前：`npx vitest run` 全绿（既有 9 skip 基线不变）+ `npm run lint` 全绿；真实 PG 环境不可用按 EVALUATION-INCOMPLETE 记录，不得冒充通过。

## 9. merge 前合并者检查清单

1. 100 条 fixture 覆盖 setting/wiki/skill/log 四类；每条 authorized official entry 要么命中声明 Region、要么进入 `region:unclassified`，不存在静默无区域。
2. `region:unclassified` 必须显式存在、`mode:"unclassified"` 且有 primary owner；所有非虚拟 Region 同样必须有 primary owner。
3. 重排输入 snapshotId 不变、content 修订后改变；entry revision/content hash/index hash/epoch 任一项被篡改时 `assertMemoryDirectorySnapshotIntegrity` fail-closed（`/integrity mismatch/`）。
4. selector 语义=组间 AND、组内 OR，空 selector 非法（`region:unclassified` 除外）；`domains` 只读 Catalog 验证的 `meta.domains`，不得用 anchor 冒充 DomainId。
5. estimatedWeight 由 builder 重算（entryCount+ceil(chars/4096)+clauseCount），不得信任输入权重；membership 不得复制正文；跨 tenant 条目、重复 worker/region/responsibility 拒绝。

## 10. 偏差纪律

- lane 内只动 §3 文件域；如需触及其他文件，先停 lane 报告用户裁决。
- 发现计划缺陷/步骤不可执行：停下报告，不自行改计划。
- README 徽章/测试总数只在合并回 main 时更新。
- 每 lane 一条 commit（focus 测试 + 契约内文件域）；偏差必须写进 commit body。
- 实现期不得弱化任何 N27 已验收契约、不变量或回归测试。
