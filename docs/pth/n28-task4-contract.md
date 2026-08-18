# N28-T4 契约：分层检索并共享给 Broker 与 KnowledgeContext

> 对应实施计划 Task 4（docs/pth/n28-role-memory-orchestration-implementation-plan.md L1107–L1584）；验证假设：H3（错误绑定不造成不可达）+ H4（fallback 授权不变）
> 上游依赖：T1（WorkerReplicaRef 等契约类型）+ T2（`TaskDispatchContext.worker` 戳记）+ T3（MemoryDirectorySnapshot）；`AgentTaskRunnerDeps.replica/verifiedReadScopeFactory` 由本 lane 自己新增（计划 Task 4 Step 7，T2 不碰 agent-task-runner）
> Gate 0 记录：N27 最终复验报告 docs/pth/v1.2-acceptance-fix-revalidation-final.md 为 ACCEPTED；复验对象 main@c2c0729（R6=4d0a38b 经 merge c2c0729 合入 main，R1–R6 全部 merged）；N28 设计/计划基线 commit 9f10082（docs-only）。本 lane 实现分支必须派生自包含 9f10082 的 main，且首条 commit 信息注明 Gate 0 已过。
> 车道：分支 lane/n28-t4-layered-retrieval，worktree .worktrees/n28-t4，串行合并顺序 T1→T2→T3→T4→T5→T6→T7。

## 1. 目标

按实施计划 Task 4「Add Layered Retrieval and Share It Between KnowledgeBroker and KnowledgeContext」的标题与 Expected：实现 `layered-knowledge-retriever`（固定四波 `[0,1,2,3]`：primary → overlap → fallback/unclassified → bounded global），以一次验证的 `VerifiedTaskReadScope` 作为唯一授权信封，并通过同一 `searchWave` 端口把分层检索结果共享给 KnowledgeBroker 与 KnowledgeContext。验证 H3（错误绑定不造成不可达，只影响效率）与 H4（fallback 授权不变）。定向测试 Expected：12/12 gold 目标在期望波次命中、decoy 不能造成提前停止、完整 signed-grant 可见性矩阵匹配生产 `isVisible` 语义。

## 2. 上游接口（Consumes）

| 接口 | 来源文件 | 上游 Task |
|---|---|---|
| `MemoryDirectorySnapshot` | `src/pth/execution/memory-directory.ts`（T3 Create） | T3 |
| `buildMemoryDirectorySnapshot()`、`assertMemoryDirectorySnapshotIntegrity()`、`responsibilitiesForWorker()`、`regionEntryIds()` | `src/pth/execution/memory-directory.ts`（T3 Create） | T3 |
| `WorkerReplicaRef` | `src/pth/contracts/cognitive-responsibility.ts`（T1 Create，经 contracts barrel 导出） | T1 |
| `TaskDispatchContext.worker?: WorkerReplicaRef` | `src/pth/contracts/tasking.ts`（T2 Modify） | T2 |
| `rankKnowledgeEntries()`、`filterKnowledgeEntriesByQueryText()` | `src/pth/execution/knowledge-ranking.ts` | 既有基线（N27 后） |
| `isVisible()` | `packages/pth-memory/src/memory-visibility.ts` | 既有基线（N27 后） |
| `ExecutionGrantService`、`ExecutionGrant`、`grantService.issue/verify` | `src/pth/execution/authorization/execution-grant-service.ts` | 既有基线（N27 后） |
| `KnowledgeBrokerDeps`、memory retrieve/search ports、`KnowledgeResult` | `src/pth/execution/knowledge-broker.ts` | 既有基线（N27 R2/R5 加固面） |
| `TaskLease`、`TaskWorkItem` | `src/pth/contracts/index.ts` | 既有基线 |

## 3. 实施范围

| 文件 | 改动 |
|---|---|
| Create: `src/pth/execution/layered-knowledge-retriever.ts` | 实现 `LayeredSearchWaveInput`/`LayeredSearchWaveResult`、`LayeredRetrievalRequest`/`LayeredRetrievalResult`、`LayeredKnowledgeRetriever`、`computeRetrievalQueryFingerprint()`、`createLayeredKnowledgeRetriever()`：先断言 Directory 完整性，再规划固定四波，每波用同一授权信封、先过滤后 limit，最后 merge/dedupe/rank 并判定 found/exhausted-empty/retrieval-incomplete/retrieval-failed 四态与 trace |
| Create: `src/pth/execution/authorization/verified-task-read-scope.ts` | 定义 `VerifiedTaskReadScope` 与 `VerifiedTaskReadScopeFactory`；`forTask()` 立即验证签名/deadline 并 mint 冻结信封；Broker 侧 `verifyBrokerGrant()` 接收未验证 grant 并执行唯一一次真实 `grantService.verify()` 后私密 mint；导出 `assertVerifiedTaskReadScope()`（仅 opaque provenance/task-lease generation/worker binding/deadline 廉价断言，不重放 HMAC/replay）；raw mint 模块私有不导出 |
| Modify: `src/pth/execution/knowledge-ranking.ts` | 导出 `knowledgeQueryTokenHits()`，`rankKnowledgeEntries()` 改为调用该公共命中实现，消除第二套命中实现；既有排序顺序不变 |
| Modify: `src/pth/execution/knowledge-broker.ts` | `KnowledgeBrokerDeps` 增加可选 `layeredRetriever`、`layeredSearchWave`、`clock`；公共 `query({grant,...})` 经注入的 verified-scope authority 一次真实验证后委托 `queryVerified(authorization, requestWithoutGrant)`；layered 路径仅在依赖注入且 Directory tenant/worker 与信封一致时启用；`KnowledgeResult` 增加 `retrievalTrace`；共享 `computeRetrievalQueryFingerprint()` 用于公共入口归一化；无 layered 注入时旧 search 分支不变 |
| Modify: `src/pth/execution/index.ts` | barrel 导出 `authorization/verified-task-read-scope.js` 与 `layered-knowledge-retriever.js`；授权模块仅导出 opaque 类型、verified authority/factory 与廉价断言，绝不导出 private raw-grant mint |
| Modify: `src/pth/runner/knowledge-context.ts` | `KnowledgeContextInput` 增加可选 `workerId`、`authorization`；provider deps 增加可选 `layeredRetriever`、`clock`、`layeredSearchWave`；layered 路径要求 verified envelope，只从 `status="found"` 构建 `KnowledgeContextEntry[]` 并暴露 `retrievalTrace` 与检索状态；冻结 `KnowledgeContextPromptRow`/`contextPromptProjection()`/`formatKnowledgeContextPromptRows()`；指纹仅在存在 `workerId` 时把 workerId 作为独立分量追加在 `roleId` 后，缺席时旧指纹逐字节不变 |
| Modify: `src/pth/runner/agent-task-runner.ts` | `AgentTaskRunnerDeps` 增加可选 `replica?: WorkerReplicaRef` 与 `verifiedReadScopeFactory?: VerifiedTaskReadScopeFactory`；每任务构建一个 verified scope，并把 scope 与 `this.deps.replica?.workerId` 传入 `KnowledgeContextProvider.build()`；invalid/expired/missing-capability scope 创建在 Context 调用 wave port 前拒绝 |
| Modify: `scripts/n28-feasibility-fixture.ts` | 每行 content 改为包含唯一可检索 token `token:<id>`；新增并冻结 `N28_GOLD_QUERIES` 12 个 gold cases（q-primary-1..4、q-overlap-1..2、q-fallback-1..2、q-global-decoy、q-misbound、q-unclassified-1..2） |
| Create: `test/pth-execution/layered-knowledge-retriever.test.ts` | 12/12 gold 在期望波次命中、trace waves 恒为 `[0,1,2,3]`、四态区分（exhausted-empty / retrieval-incomplete / retrieval-failed）、授权陷阱与 mutation 用例 |
| Create: `test/pth-execution/verified-task-read-scope.test.ts` | valid、bad signature、expired、missing capability、tenant/space/worker/generation mismatch、post-construction mutation；grant TTL 超过 lease 且 clock 越过 lease deadline 后，后续 wave/read 在 backing-read spy 前失败 |
| Modify: `test/pth-execution/knowledge-ranking.test.ts` | 加入 `knowledgeQueryTokenHits` 的 1/0 断言；refactor 后既有 ranking 顺序不变 |
| Modify: `test/pth-execution/knowledge-broker.test.ts` | 真实签名 grant（`principalId=worker:10000000-0000-4000-8000-000000000011`）+ 真实 layered retriever：global-only 命中、`retrievalTrace.globalFallback` 为 true、无 trap 条目；invalid-signature/expired-grant/missing-`memory.read` 时 `layeredSearchWave` 调用零次；覆盖 `search/get/query/retrieve` |
| Modify: `test/pth-runner/knowledge-context.test.ts` | 同一 worker/query/snapshot 下 Context 与 Broker 的 `retrievalTrace.directorySnapshotId` 与 selected IDs 一致；`n28TrapCorpus()` 上的生产 `isVisible()` 可见性矩阵；过期后调用 Context/Broker 的 backing-read 计数为零 |

## 4. 接口产出（Produces，冻结表）

| 接口 | 冻结语义 | 后续 Task 消费 |
|---|---|---|
| `VerifiedTaskReadScope` | 冻结信封：`tenantId`、`space`、`principalId`、`worker: WorkerReplicaRef`、`capabilities`、`lease(taskId,leaseId,generation)`、`grantDigest`、`deadlineAt = min(grant.deadlineAt, TaskLease.deadlineAt)`；构造后冻结，请求字段不可覆盖 | T5 Memory/Skill/state adapters；T6 working-set provider；T7 evaluator |
| `VerifiedTaskReadScopeFactory` | `forTask()` 立即 verify 并 mint；`verifyBrokerGrant()` 是对外接收未验证 grant 并做唯一一次真实 `grantService.verify()` 后调用私密 mint 的唯一入口；raw grant→branded scope mint 永不导出 | Broker（本 Task）、Context（本 Task）、T5/T6/T7 |
| `assertVerifiedTaskReadScope(scope, expected, {clock})` | 仅做廉价 opaque provenance、task/lease generation、worker binding、`deadlineAt > clock()` 断言；不得调用 `grantService.verify()`，不消耗 replay nonce | Broker/Context 每波前；T5/T6 每 backing read 前 |
| `createLayeredKnowledgeRetriever(directory, integritySource, {clock})` | 先调用 `assertMemoryDirectorySnapshotIntegrity(directory, integritySource)`，拒绝伪造 epoch/revision/content/index hash 或无效 primary owner；caller 不能以 fiat 断言快照有效 | Broker/Context（本 Task）；T5 read factory |
| `LayeredKnowledgeRetriever<T>` | `search()` 执行固定四波 `[0,1,2,3]`；每波把 exact `request.authorization` 传入 `searchWave`；per-wave output limit = `Math.max(request.limit * 2, 8)` 且封顶 20；按 entry ID merge/dedupe，记录首个返回该 ID 的 wave；四波后统一 `rankKnowledgeEntries()` 一次；最终返回至多 `request.limit` 条 | Broker/Context（本 Task）；T5/T6/T7 |
| `LayeredRetrievalRequest<T>`、`LayeredSearchWaveInput`、`LayeredSearchWaveResult<T>` | wave port 契约：`completeForQuery=true` 仅当 adapter 在 limit 前应用了 `filterKnowledgeEntriesByQueryText(...,{strict:true})` + Region 过滤 + query-sensitive ranking；`candidateCount/visibleCount/scannedCount` 诚实记录，不掩盖截断 | Broker/Context wave port；T5 read factory |
| `LayeredRetrievalResult<T>` | 四态：`found` 仅当至少一个选中结果 `knowledgeQueryTokenHits(entry, queryText) > 0`；`exhausted-empty` 仅当所有尝试波次 `completeForQuery=true` 且无命中；不完整波次且无最终命中返回 `retrieval-incomplete`；任一 wave 抛错返回 `retrieval-failed` 且结果为空；`trace` 含四波与 `selectedEntryIds` | Broker/Context；T7 evaluator |
| per-call `searchWave` port | 每波接收 exact verified envelope（非 caller tenant/space 字符串）+ Region entry IDs + query + limit；重新执行廉价品牌/截止断言，不重放 HMAC；先授权谓词/过滤/rank 后 limit | Broker/Context 共享；T5/T6 复用 |
| `PendingRetrievalTrace` | 包含四波 trace、candidate/visible/selected/scanned counts、`completeForQuery`、first-seen selected IDs、fallback reason、`queryFingerprint`、omitted counts；retriever 只产 pending trace，不分配 `traceId`/`callIndex` | T7 任务账本录入与可行性判定 |
| `computeRetrievalQueryFingerprint()` | 仅哈希规范化 query text、sorted domains、Directory ID、branded tenant/space/task/lease-generation/worker binding；排除 grant nonce、时间戳与对象迭代顺序 | Broker/Context（本 Task）；T5/T6/T7 |
| KnowledgeBroker/KnowledgeContext 可选 layered path 与 `KnowledgeResult.retrievalTrace` | 仅在 layered 依赖注入且 Directory tenant/worker 与 envelope 相等时启用；无 layered 注入时旧路径逐字节保留；`retrieval-failed` 是运行降级信号，`exhausted-empty` 是合法无答案 | AgentTaskRunner、TaskLoop/batch assembly；T7 |
| `KnowledgeContextPromptRow`、`contextPromptProjection()`、`formatKnowledgeContextPromptRows()` | 冻结 prompt/billing 投影：仅 `entryId`、`anchor`、`summary`、`evidence{sourceId,locator?}`、`meta{kind,domains}`；绝不透传任意存储 `meta` | T6 计费 `canonicalExposureChars`；T7 surface 比较 |

## 5. 关键步骤

- **Step 0**：创建 `verified-task-read-scope.ts`，定义 `VerifiedTaskReadScope`/`VerifiedTaskReadScopeFactory`/`createVerifiedTaskReadScopeFactory()`，`forTask()` 立即验证签名与 deadline 并要求 tenant/space/principal worker ID/`memory.read` capability 与服务端盖章一致；Broker 侧方法接收未验证 grant 并做唯一一次真实 verify 后私密 mint。Expected：先写 `verified-task-read-scope.test.ts`，覆盖 valid、bad signature、expired、missing capability、tenant/space/worker/generation mismatch、post-construction mutation；grant TTL 超 lease 且 clock 越过 lease deadline 后，后续每波/读在 backing-read spy 前失败；HMAC/replay 仅验一次，此后每波只做廉价 brand/binding/deadline 校验。
- **Step 1**：在 `scripts/n28-feasibility-fixture.ts` 中让每个 fixture 行 content 包含唯一 `token:<id>`，并新增冻结的 `N28_GOLD_QUERIES` 12 个 gold cases。Expected：12 个 gold cases 的 `expectedWave` 分别为 0/0/0/0/1/1/2/2/3/3/2/2，覆盖 primary、overlap、fallback、global decoy、misbound、unclassified。
- **Step 2**：在 `knowledge-ranking.ts` 导出 `knowledgeQueryTokenHits()`，并让 `rankKnowledgeEntries()` 复用该实现。Expected：运行 `npx vitest run test/pth-execution/knowledge-ranking.test.ts` 后 PASS，既有 ranking 顺序不变。
- **Step 3**：写四波 gold 与检索状态测试及低层 harness；harness 使用真实 `ExecutionGrantService` + `createVerifiedTaskReadScopeFactory`，wave adapter 先应用 Region 成员与生产 query ranking 再 limit，并显式返回 `completeForQuery`。Expected：测试断言 12/12 gold 在期望波次命中、每例 waves 恰为 `[0,1,2,3]`，并区分 `exhausted-empty`、`retrieval-incomplete`、`retrieval-failed`。
- **Step 4**：运行 `npx vitest run test/pth-execution/layered-knowledge-retriever.test.ts` 确认先红。Expected：FAIL，因为 `layered-knowledge-retriever.ts` 尚不存在。
- **Step 5**：实现确定性检索规划与严格停止语义：创建 retriever 时先断言 Directory 完整性；每波前廉价断言授权与绑定；构建 `primary/overlap/fallback+unclassified/global` 四波；每波 per-wave limit = `max(limit*2,8)` 封顶 20；merge/dedupe/rank 后按 token 命中判定四态。Expected：空 Region 波返回空 complete 结果，仅 `candidateScope="global"` 可全局扫描；无 token 命中不得继承旧「return everything」fallback；trace 计数满足 `selectedCount <= visibleCount <= candidateCount <= scannedCount`。
- **Step 6**：把可选 layered 路径接入 KnowledgeBroker，`KnowledgeBrokerDeps` 增加 `layeredRetriever?`、`layeredSearchWave`、`clock?`；公共 `query({grant,...})` 一次真实验证后委托 `queryVerified(authorization, requestWithoutGrant)`。Expected：Waves 0–2 由 retriever 的 Directory Snapshot 计算允许的 entry refs 后传入 port 再 limit，Wave 3 不传 Region IDs 做有界全局查询；不取任意 top 20 再相交；`KnowledgeResult` 返回 `retrievalTrace`；无 layered 注入时旧 search 分支不变。
- **Step 7**：把同一 retriever 接入 KnowledgeContextProvider：`KnowledgeContextInput` 增加可选 `workerId`/`authorization`，deps 增加可选 `layeredRetriever`/`clock`/`layeredSearchWave`；冻结 `KnowledgeContextPromptRow`/`contextPromptProjection()`/`formatKnowledgeContextPromptRows()`；`AgentTaskRunnerDeps` 增加可选 `replica?`/`verifiedReadScopeFactory?`，每任务构建一个 verified scope。Expected：Context 只从 `status="found"` 构建条目并暴露 trace/状态；`workerId` 缺席时旧指纹逐字节不变，存在时作为独立分量追加在 `roleId` 后；invalid/expired/missing-capability scope 在 Context 调用 wave port 前拒绝。
- **Step 8**：为 Broker 与 Context 增加回归断言：真实签名 grant + 真实 retriever 查询 `bounded global target canonical`；用 `setSpaceLookup()` 与生产 `isVisible()` 跑 `n28TrapCorpus()`。Expected：Broker 结果 `ok=true`、`global-only` 命中、`retrievalTrace.globalFallback=true`、无 `trap-` 条目；Context 与 Broker 对同一 worker/query/snapshot 的 `retrievalTrace.directorySnapshotId` 与 selected IDs 相等；invalid-signature/expired-grant/missing-`memory.read` 时 `layeredSearchWave` 调用零次；clock 越过 `deadlineAt` 后 Context/Broker 首个 wave/backing-read 计数为零。
- **Step 9**：运行完整检索套件。Expected：PASS；12/12 gold 目标命中、decoy 不能提前停止、完整 signed-grant 可见性矩阵匹配生产 `isVisible` 语义。
- **Step 10**：提交分层检索，barrel 导出 `authorization/verified-task-read-scope.js` 与 `layered-knowledge-retriever.js`，授权模块只导出 opaque 类型、verified authority/factory 与廉价断言。Expected：TaskLoop/batch assembly 从 barrel 消费，不得深入内部路径；一条 commit `feat(pth): add layered memory responsibility retrieval`。

## 6. 设计裁决与红线

1. **责任区只改变检索顺序，不改变授权**（设计 §5.1）：每一波都执行同一服务端授权谓词 `tenant == grant.scope.tenantId AND status == official AND space is visible from grant.scope.space AND requested operation ∈ grant.capabilities`；已知 entry ID 的 `get(id)` 不受责任区限制但仍须通过同一授权。
2. **固定执行全部四波**（设计 §5.2、计划 Step 5）：可行性切片固定执行 `[0,1,2,3]` 四波再统一 merge/dedupe/rank；早停优化不在本轮验收范围。零命中、低相关性、错误绑定或 `unclassified` 目标都必须进入下一波；不得因责任区硬过滤制造不可达（H3）。
3. **四态不可混**（设计 §5.2、计划 Step 5）：`found` 仅当至少一个选中结果 `knowledgeQueryTokenHits > 0`；`exhausted-empty` 仅当所有尝试波次 `completeForQuery=true` 且无命中；候选截断且完整性未知返回 `retrieval-incomplete`；目录/后端失败返回 `retrieval-failed`；三者不得都表现为空数组。无 token 命中不得继承旧 production「return everything」fallback。
4. **wave port 必须先过滤后 limit**（设计 §5.2、计划 Step 5/6）：每个 wave port 必须先应用 Region 与 `filterKnowledgeEntriesByQueryText(...,{strict:true})` 及 query-sensitive ranking，再执行 limit；`completeForQuery` 只在该顺序满足时为 true。per-wave output limit 固定为 `Math.max(request.limit * 2, 8)` 且封顶 20。
5. **VerifiedTaskReadScope 是唯一授权信封**（计划 Step 0）：`forTask()` 立即验证签名/deadline 并要求 tenant/space/principal worker ID/`memory.read` capability 与服务端盖章一致；返回冻结信封，请求字段不能覆盖；`deadlineAt` 取 verified grant deadline 与 `TaskLease.deadlineAt` 的较早值，grant 不能比 lease 活得更久。Context、Broker 与 T5 adapter 均消费该信封，任何 surface 不得自行制造 `{tenantId,space}`。
6. **一次性真实 verify + 私密 mint**（计划 Step 0/6）：raw verified grant → branded scope mint 模块私有、永不导出；Broker 的 `verifyBrokerGrant()` 是唯一对外接收未验证 grant 的入口并执行唯一一次 `grantService.verify()`。此后 `assertVerifiedTaskReadScope()` 只做廉价 opaque provenance/task-lease generation/worker binding/deadline 校验，绝不重放 HMAC/replay（replay guard 会消耗 nonce）。
7. **Directory 完整性不可绕过**（计划 Step 5）：`createLayeredKnowledgeRetriever(directory, integritySource, {clock})` 必须先调用 `assertMemoryDirectorySnapshotIntegrity(directory, integritySource)`，拒绝伪造 epoch/revision/content/index hash 或无效 primary owner；feasibility assembly 必须保留冻结的 `DirectoryEntryInput[]`，caller 不能以 fiat 断言快照有效。
8. **绑定与租户一致性**（计划 Step 5/6）：每波前断言 `request.workerId === request.authorization.worker.workerId` 且 Directory tenant 等于 `request.authorization.tenantId`；每波必须把 exact `request.authorization` 对象传给 `searchWave`。Broker/Context 仅在注入 layered 且 Directory tenant/worker 与信封相等时启用 layered 路径；注入 layered 但调用方无法提供 replica/worker 绑定时不得触发任何 wave。
9. **计数诚实，不假装有界数据库扫描**（计划 Step 5、H3）：`candidateCount` 是 Region/global 有界候选范围在 tenant/space/status 过滤前的行数，`visibleCount` 是授权谓词后、query/rank limit 前的行数，`scannedCount` 如实记录；每波 `selectedCount <= visibleCount <= candidateCount <= scannedCount`。本可行性切片验证的是有界候选接口，真实 indexed PG search 仍在范围外，报告必须如实声明。
10. **实验预算与全局约束不发明**：本 lane 不新增实验预算；全局实验预算照抄 Global Constraints：`maxRegions=3`、`maxPrimaryWeight=80`、`maxSecondaryWeight=40`（overlap + fallback）、`maxMemoryEntries=8`、`maxMemoryChars=4096`、`maxSkillIndexEntries=8`、`maxActiveSkills=4`、`maxSkillChars=8192`、`maxTools=16`。

## 7. 非目标

- 不实现生产化早停优化（设计 §5.2：提前停止的四个条件不进入本轮验收）。
- 不实现真实 indexed PG search；per-wave 上限证明的是有界候选接口，不伪装成有界数据库扫描（计划 Step 5）。
- 不移动/弱化 Broker 的授权谓词；责任区只改变检索顺序，不改变 tenant/space/status/grant 检查（计划 Step 6）。
- 不在本 lane 实现 T5 的 Memory/Skill/state adapters；`state.recallFunctions/recallInsights` 的授权/预算矩阵属于 Task 5 Step 6 与最终 vertical gate（计划 Step 8）。
- 不新增 PG 表、不做 task/schema migration、不做自动 Region 分裂、Role 自动分化、autoscaling、embeddings 或 production defaults（Global Constraints）。
- 不用评估专用检索逻辑冒充证据；必须使用生产 KnowledgeBroker、KnowledgeContextProvider、AgentTaskRunner 与 agent-loop（Global Constraints）。
- 不在 lane 内更新 README 徽章/测试总数；这些只在合并回 main 时更新（偏差纪律）。

## 8. 验收标准

### 8.1 定向测试

计划本 Task 的全部 Run 命令（逐字）：

- Step 2：`npx vitest run test/pth-execution/knowledge-ranking.test.ts`
- Step 4：`npx vitest run test/pth-execution/layered-knowledge-retriever.test.ts`
- Step 9：`npx vitest run test/pth-execution/knowledge-ranking.test.ts test/pth-execution/memory-directory.test.ts test/pth-execution/verified-task-read-scope.test.ts test/pth-execution/layered-knowledge-retriever.test.ts test/pth-execution/knowledge-broker.test.ts test/pth-runner/knowledge-context.test.ts`

关键断言点（Expected）：

- Step 2 预期 PASS：`knowledgeQueryTokenHits({id:"x",anchors:["mathematics"],content:"token:alg-01"},"token:alg-01") === 1`、`knowledgeQueryTokenHits(...,"token:alg-01") === 0`（当 content 为 `other` 时）；refactor 后既有 ranking 顺序不变。
- Step 4 预期 FAIL：因 `layered-knowledge-retriever.ts` 不存在（先红）。
- Step 9 预期 PASS：12/12 gold 目标命中且落在 `expectedWave`；每例 `trace.waves.map(w=>w.wave)` 等于 `[0,1,2,3]`；decoy 不能造成提前停止；四态区分（`exhausted-empty` / `retrieval-incomplete` / `retrieval-failed`）；完整 signed-grant 可见性矩阵匹配生产 `isVisible` 语义。

### 8.2 关闭条件对账表

| 关闭条件（计划 Expected、全局约束、本 lane focus） | 证据要求 |
|---|---|
| H3：12/12 gold 在期望波次命中，错误绑定不造成不可达 | `layered-knowledge-retriever.test.ts` 的 `recalls all 12 gold targets within the expected wave`：每个 gold `status="found"`、`expected` id 在 entries 中、命中 wave 等于 `expectedWave`、`trace.waves` 恰为 `[0,1,2,3]`；最终 evaluator H3 谓词：12 例 ran/found、gold recall=1、max `selectedCount` ≤ 20、incomplete/failed gold cases=0 |
| 四态不可混：found / exhausted-empty / retrieval-incomplete / retrieval-failed | `layered-knowledge-retriever.test.ts` 的 `distinguishes a complete no-answer from incomplete and failed retrieval`：`"no-such-token"` 默认返回 `exhausted-empty`；`completeForQuery:false` 返回 `retrieval-incomplete`；`failWave:2` 返回 `retrieval-failed` |
| 固定执行四波 `[0,1,2,3]`，per-wave 输出 limit=`max(limit*2,8)` 封顶 20，且先过滤后 limit | `recalls all 12 gold targets...` 断言每例 waves 恰为 `[0,1,2,3]`；H3 断言 max `RetrievalWaveTrace.selectedCount` ≤ 20；实现/测试中 wave port 必须在 Region + strict query + rank 之后才 `slice(0, waveLimit)` |
| **VerifiedTaskReadScope 一次性真实 verify + 私密 mint，此后每波只做廉价 brand/binding/deadline 校验；HMAC/replay 只验一次** | `verified-task-read-scope.test.ts`：bad signature/expired/missing capability/tenant/space/worker/generation mismatch 全部拒绝；`assertVerifiedTaskReadScope` 路径中验证 spy 对同一 scope 只调用一次，随后每波/每读只走廉价断言；grant TTL 超 lease 且注入 clock 越过 lease deadline 后，后续每波/读在 backing-read spy 之前失败（spy 调用数=0） |
| **无 worker 绑定的 legacy 路径 fail-closed（显式关闭条件）：不注入 layered 时旧路径逐字节保留；注入 layered 但调用方无法提供 replica/worker 绑定时不得触发任何 wave** | `knowledge-broker.test.ts` 与 `knowledge-context.test.ts`：未注入 `layeredRetriever` 时 search/context 输出与旧路径逐字节一致；注入 `layeredRetriever` 但缺失 `replica`/`workerId`/`authorization` 或绑定不匹配时，`layeredSearchWave` 调用次数必须为 0，且不得有任何 wave trace 产生 |
| 授权谓词不得被责任区改动；每波保持 tenant/space/`status=official`/grant capability（H4） | `knowledge-broker.test.ts`/`knowledge-context.test.ts`：`n28TrapCorpus()` 上生产 `isVisible()` 的公开祖先可见性、私有同空间、跨空间/租户、draft/archived 全部符合预期；Broker 结果无 `trap-` 条目；invalid-signature/expired-grant/missing-`memory.read` 时 `layeredSearchWave` 调用零次；最终 evaluator H4：32 个授权单元、14 个 Broker/Context 可见性观测全部 ran，授权泄漏/未授权 wave/backing-port 调用=0 |
| **Broker 是 N27 R2/R5 加固面：不得弱化任何已验收契约/回归测试** | merge 门必须补跑 `knowledge-broker.pg` 与 `r6-acceptance` 套件且全绿；`knowledge-broker.ts` diff 不得移除/放宽任何 N27 已验收的授权、可见性、promotion 或回归断言 |
| **KnowledgeContext 指纹扩展只在存在 `workerId` 时把 workerId 作为独立分量追加，缺席时旧指纹逐字节不变** | `knowledge-context.test.ts` 指纹用例：`workerId` 缺席时旧 fingerprint 与 N27/既有实现逐字节相同；存在时在 `roleId` 之后追加独立 workerId 分量；断言 worker principal 绝不写入 `roleId` 字段 |
| wave port 必须先过滤后 limit 并诚实声明 `completeForQuery` | `layered-knowledge-retriever.test.ts` 与 Broker/Context 测试：`completeForQuery=false` 时不得返回 `exhausted-empty`/`found` 且必须标记 `retrieval-incomplete`；trace 中每波 `selectedCount <= visibleCount <= candidateCount <= scannedCount`；`candidateCount`/`scannedCount` 为诚实观测值，不得被本内存证明封顶 |
| Directory 完整性不可绕过 | retriever 构造路径：伪造 epoch/revision/content hash/index hash 或无效 primary owner 时 `assertMemoryDirectorySnapshotIntegrity` 抛错且不暴露 `search()`；caller 不能以 fiat 断言快照有效 |
| 合并者额外 review：授权谓词不得被责任区改动；wave port 必须先过滤后 limit 并诚实声明 `completeForQuery` | 合并者逐行 diff `knowledge-broker.ts`/`knowledge-context.ts`：授权谓词无责任区条件混入；每个 wave port 的 slice 位于 Region + strict query + rank 之后；`completeForQuery` 声明与实际执行顺序一致 |

### 8.3 全量门槛

合并者合并前：`npx vitest run` 全绿（既有 9 skip 基线不变）+ `npm run lint` 全绿；真实 PG 环境不可用按 `EVALUATION-INCOMPLETE` 记录，不得冒充通过。

## 9. merge 前合并者检查清单

1. **私密 mint 不泄漏**：确认 barrel 与 `verified-task-read-scope.ts` 仅导出 opaque 类型、verified authority/factory 与廉价断言；grep 调用点确认 Broker/Context/T5 无法绕过 `verifyBrokerGrant()` 自造 `{tenantId,space}`，且没有任何 surface 能制造 branded scope。
2. **legacy fail-closed**：对比未注入 `layeredRetriever` 时 Broker/Context 旧路径输出逐字节一致；注入 layered 但缺少 `replica`/`workerId`/`authorization` 或绑定不匹配时，确认 `layeredSearchWave` 调用次数为 0，任何 wave 都不得触发。
3. **filter-before-limit 与 honest trace**：逐行检查 wave port 的 `slice` 是否位于 Region + strict query + rank 之后；核对 `completeForQuery` 声明与实际一致；确认 trace 中 `selectedCount <= visibleCount <= candidateCount <= scannedCount`，`candidateCount`/`scannedCount` 未被擅自封顶。
4. **Broker/Context 授权面不弱化**：diff 确认 `query`/`queryVerified`/Context 分层路径中的 tenant/space/`status=official`/capability/`isVisible` 谓词未受责任区影响；补跑 `knowledge-broker.pg` 与 `r6-acceptance`，任何 N27 R2/R5 已验收契约或回归不得退化。
5. **指纹与投影冻结**：确认 `workerId` 缺席时 KnowledgeContext 指纹逐字节不变，存在时仅作为独立分量追加在 `roleId` 后；确认 `contextPromptProjection` 只暴露白名单字段，未透传任意存储 `meta`。

## 10. 偏差纪律

- lane 内只动 §3 文件域；如需触及其他文件，先停 lane 报告用户裁决。
- 发现计划缺陷/步骤不可执行：停下报告，不自行改计划。
- README 徽章/测试总数只在合并回 main 时更新。
- 每 lane 一条 commit（focus 测试 + 契约内文件域）；偏差必须写进 commit body。
- 实现期不得弱化任何 N27 已验收契约、不变量或回归测试。
