# N28-T5 契约：单任务统一 Cognitive Budget（Memory/Skill/Tool 三面）

> 对应实施计划 Task 5（docs/pth/n28-role-memory-orchestration-implementation-plan.md L1588–L1983）；验证假设：H5：统一预算是硬上限、确定性、规范化投影计费
> 上游依赖：T4（VerifiedTaskReadScope / layered retriever / queryVerified）
> Gate 0 记录：N27 最终复验报告 docs/pth/v1.2-acceptance-fix-revalidation-final.md 为 ACCEPTED；复验对象 main@c2c0729（R6=4d0a38b 经 merge c2c0729 合入 main，R1–R6 全部 merged）；N28 设计/计划基线 commit 9f10082（docs-only）。本 lane 实现分支必须派生自包含 9f10082 的 main，且首条 commit 信息注明 Gate 0 已过。
> 车道：分支 lane/n28-t5-cognitive-budget，worktree .worktrees/n28-t5，串行合并顺序 T1→T2→T3→T4→T5→T6→T7。

## 1. 目标

按计划 Task 5「Enforce One Task-Scoped Cognitive Budget Across Memory, Skill and Tool Surfaces」实施：为单次任务强制统一 Cognitive Budget，把初始 KnowledgeContext、运行期 Memory 展开、Skill 两级展开和静态+ToolReg 工具面纳入同一本账。实现单调任务账本，六个预算轴（memory entries/chars、skill index/active/chars、tools）全部为硬上限，并用规范化投影计费保证确定性。冻结 `AuthorizedTaskReadFactory` 作为 Memory 读取唯一所有者，产出确定性 `snapshot()` 与预算化 capability facade；Step 6 定向测试必须 PASS，且任一 memory 方法使用独立账本时测试必须失败。

## 2. 上游接口（Consumes）

| 接口全名 | 来源文件 | 上游 Task |
|---|---|---|
| `CognitiveBudget` | `src/pth/contracts/cognitive-responsibility.ts`（经 `src/pth/contracts/index.ts` 导出） | Task 1 |
| `WorkerReplicaRef` | `src/pth/contracts/cognitive-responsibility.ts`（经 `src/pth/contracts/index.ts` 导出） | Task 1 |
| `PendingRetrievalTrace` / `RetrievalTrace` | `src/pth/contracts/cognitive-responsibility.ts` | Task 1 |
| `TaskWorkingSetPolicy` / `TaskWorkingSet` 类型 | `src/pth/contracts/cognitive-responsibility.ts` | Task 1 |
| layered retrieval output（`LayeredKnowledgeRetriever` / `searchWave` 端口产出） | `src/pth/execution/layered-knowledge-retriever.ts`；经 `KnowledgeBroker.queryVerified` 消费 | Task 4 |
| `SkillSummary` / `MemoryEntry`（Skill 摘要与全文投影） | `@away_from/pth-memory` 包类型；生产 `skills.forScope` 沿用现有 `listSkills`/`getSkill` 形状 | 既有 pth-memory surface（N27 已验收），本 Task 冻结读取边界 |
| tool schema names（canonical Tool schema names，static + ToolReg） | 现有 agent-loop / ToolReg 工具面；计划在本 Task 未新增来源文件，由调用方传入 ledger | T1 冻结 `maxTools` 语义，T6 接线时冻结具体 union |

## 3. 实施范围

| 文件（Create/Modify 逐字列全） | 改动 |
|---|---|
| Create: `src/pth/kernel/execution/cognitive-budget.ts` | 实现 `CognitiveBudgetLedger`（六轴硬上限、单调正差额计费、确定性 trace/snapshot）与 `canonicalExposureChars`；导出 `CognitiveBudgetExceededError` |
| Create: `src/pth/runner/authorized-task-reads.ts` | 定义并实现 `AuthorizedTaskReads`、`AuthorizedTaskReadFactory`、`createAuthorizedTaskReadFactory()`、`expandTaskReadGrantCapabilities()`；冻结操作→capability 映射；工厂为 Memory 读取唯一所有者 |
| Create: `src/pth/runner/authorized-state-reads.ts` | 定义 `AuthorizedStateReadPort` 及 `forScope(authorization)`，产出 scope-bound canonical state reads（function/insight） |
| Create: `src/pth/runner/cognitive-working-set.ts` | 实现 `createTaskWorkingSetPolicy()` 与 `createBudgetedTaskCapabilities()`，将 ledger 与 `AuthorizedTaskReads` 组装为预算化 read facade |
| Modify: `src/pth/runner/index.ts` | 增加三个 `export *`（authorized-state-reads / authorized-task-reads / cognitive-working-set） |
| Create: `test/pth-kernel-execution/cognitive-budget.test.ts` | Step 1/4 的 ledger 六轴、正差额、pinned tools、skill 规则与 1,000 组确定性测试 |
| Create: `test/pth-runner/authorized-task-reads.test.ts` | 工厂契约、grant 映射、能力展开、失效/过期/缺 capability 零 backing call 测试 |
| Create: `test/pth-runner/authorized-state-reads.test.ts` | 并发 scope、clock 过期、tenant/space/task identity 隔离、`isVisible(entry.meta)` 防泄漏测试 |
| Create: `test/pth-runner/cognitive-working-set.test.ts` | facade bypass 测试：真实 factory 契约 + secured fake backing ports，全读路径过同一账本 |

## 4. 接口产出（Produces，冻结表）

| 接口全名 | 冻结语义 | 后续 Task 消费 |
|---|---|---|
| `CognitiveBudgetLedger` | 精确公开方法 `admitMemory` / `freezeSkillIndex` / `activateSkill` / `freezeTools` / `recordRetrievalTrace` / `snapshot`；六轴全上限；同 ID summary→full 只收正差额；`freezeTools` 先计 pinned、超限即失败；trace 绑定 task/directory/worker，初始 Context 为 call 0 | Task 6（`createCognitiveWorkingSetProvider` 与 final working-set snapshot） |
| `CognitiveBudgetExceededError` | `memory.get` / `skills.get` 展开无法放入账本时抛出，不静默截断 | Task 6（agent-loop 执行期错误路径） |
| scope-bound canonical state reads（`AuthorizedStateReadPort.forScope(authorization)`） | 每次 store 调用前检查 branded scope 与 deadline；固定 `tool-function`/`task-insight` kind；`isVisible(entry.meta, authorization.space)`；排序后 limit；稳定 ID `state:function:<entry.id>` / `state:insight:<entry.id>` | Task 6（经 `AuthorizedTaskReads` 的 `recallFunctions`/`recallInsights`） |
| `AuthorizedTaskReads` / `AuthorizedTaskReadFactory` | `forTask({lease, work, space, worker, authorization})` 只从 `work.scope`、signed grant、lease、worker 取 scope；`assertCurrentScope()` 每次调用检查绑定与有效 deadline；Memory 读取唯一所有者；invalid/expired/missing-capability 在任何 backing port 调用前失败；raw 基础 memory/store 方法不得作为 factory 依赖 | Task 6（`AgentTaskRunnerDeps.authorizedReads`、provider 输入） |
| `createTaskWorkingSetPolicy()` | 用同一输入构造 ledger；`freezeSkillIndex` 只接受 ledger-admitted IDs 进入 `policy.skillIndexIds`；charged summary 投影与暴露索引不发散 | Task 6（provider 构建 policy） |
| `createBudgetedTaskCapabilities()` | 只包装 7 条读路径（memory.retrieve/get/query、state.recallFunctions/recallInsights、skills.list/get）；不包装 write/maintain/review/promotion/task-control；`skills.list` 返回 deep-frozen admitted 快照；非 official `get` 拒绝 | Task 6（agent-loop 实际 capability/tool 面） |
| deterministic `snapshot()` | usage/IDs/omitted/retrievalTraces 由同一账本导出；`TaskWorkingSet.retrievalTraces` 唯一来源；重排输入逐字节一致 | Task 6（TaskOutcome usage/trace）、Task 7（evaluator 对账） |

## 5. 关键步骤

- **Step 1**：新建 `test/pth-kernel-execution/cognitive-budget.test.ts`，按计划编写六轴账本失败测试：初始 Context 与后续 Memory 读同一账本、summary→full 只收正差额、pinned tools 计入 `maxTools`、skill index/active/chars 上限。Expected：测试表达上述行为，待 Step 2 验证失败。
- **Step 2**：运行 `npx vitest run test/pth-kernel-execution/cognitive-budget.test.ts`。Expected：FAIL，因为 `cognitive-budget.ts` 不存在。
- **Step 3**：实现单调任务账本 `CognitiveBudgetLedger` 与 `canonicalExposureChars(value)`；所有输入 ID 去重，candidate 由 provider 按 score 排序、平局按 ID/name；`freezeSkillIndex` 按暴露 `SkillSummary` 投影计费，`activateSkill` 只收相对 summary 的正差额，放不下的 expansion 不改变先前 usage；`freezeTools` 使用 canonical Tool schema 名，pinned 去重并先计，超限即抛，再按排序追加 candidate；`recordRetrievalTrace` 拒绝 binding 不一致、deep-copy/freeze、分配确定性 `callIndex` 与稳定 `traceId`。Expected：账本单调，snapshot 是 `TaskWorkingSet.retrievalTraces` 唯一来源；canonical 投影按实际返回/注入字段、key 排序、UTF-8 JSON bytes 计费。
- **Step 4**：新增 1,000 组确定性生成输入测试，同种子 reverse 输入重跑。Expected：两次 `snapshot()` 逐字节相等，且六轴均 ≤ `N28_FEASIBILITY_BUDGET.task` 上限；同时断言 responsibility capacity 的 ok/usage 与生成 Region 一致。
- **Step 5**：先创建 `authorized-state-reads.ts`，再创建 `authorized-task-reads.ts`（先导出契约再接线 facade），最后在 `cognitive-working-set.ts` 实现 policy 与 budgeted facade。Expected：冻结操作→capability 映射表，family 名在读取边界不被接受；工厂只调用一次 `assertVerifiedTaskReadScope()`，不重跑 `ExecutionGrantService.verify()`；`retrieveMemory` 经 `queryVerified` 走 T4 分层路径；`createTaskWorkingSetPolicy` 只接受 ledger-admitted skill IDs；facade 只包装读路径并保留无关 capability。
- **Step 6**：编写 facade bypass 测试并运行四个测试文件。Expected：PASS；测试必须在任一 memory 方法使用独立账本时失败。
- **Step 7**：在 `src/pth/runner/index.ts` 增加三个 `export *`，并 `git add` 九个文件后 commit（计划原文）。Expected：本 lane 文件域一次性提交，commit message 为 `feat(pth): enforce task cognitive working set budgets`。

## 6. 设计裁决与红线

1. **统一任务账本**：初始 KnowledgeContext、后续 memory/knowledge 展开、`skills.list/get`、静态+ToolReg 工具面全部使用同一本 `CognitiveBudgetLedger`；禁止任一 memory 方法使用独立账本（计划 Step 3/6；设计 §6.2）。
2. **任务开始时冻结 policy，Working Set 单调增长**：`TaskWorkingSetPolicy` 的 Directory snapshot、预算、Skill 索引候选和 Tool face 冻结后不再变化；Working Set 随合法展开单调增长，每次先消费同一账本并可随时导出确定性 snapshot（设计 §6.2）。
3. **六个预算轴全上限**：`maxMemoryEntries=8`、`maxMemoryChars=4096`、`maxSkillIndexEntries=8`、`maxActiveSkills=4`、`maxSkillChars=8192`、`maxTools=16`，数值照抄设计 §6 实验预算；Memory admission 在 entry 或 char 任一超限前停止，Skill/Tool 同理。
4. **规范化投影计费**：`canonicalExposureChars(value)` 只对实际返回/注入字段投影、对象 key 排序、UTF-8 JSON 序列化计 bytes；包含 metadata-only query 行、Context summary 注入的 evidence/meta、function `spec`、insight 对象与 Skill `MemoryEntry` 字段；不得只计 `content`/`source`。
5. **summary→full 只收正差额**：同一 representation 重复读取免费；200-char summary 展开为 450-char full 只补收 250-char；放不下的 expansion 拒绝且不改变先前 usage（计划 Step 1/3）。
6. **pinned tools 计入 `maxTools`，超限在 LLM 前失败**：`freezeTools` 使用 canonical Tool schema 名，pinned 按 caller 顺序去重先计，超限即抛 `/pinned tools exceed/`；不允许把超额藏到「系统工具」（计划 Step 1/3；设计 §6.2）。
7. **trace 确定性**：`recordRetrievalTrace` 拒绝 Directory/worker binding 与构造输入不一致的 pending trace；deep-copy/freeze、分配下一 `callIndex`、由 task/directory/worker/query fingerprint/call index 派生稳定 `traceId`；初始 Context 为 call 0，其后每次 `memory.retrieve` 恰好一条（计划 Step 3；设计 §6.2）。
8. **操作→capability 映射表逐字冻结**：`memory.retrieve`/`memory.get`→`memory.read`，`memory.query`→`memory.read`+`memory.query`，`state.recallFunctions`→`state.recallFunctions`，`state.recallInsights`→`state.recallInsights`，`skills.list`→`skills.list`，`skills.get`→`skills.get`；family 名不得在读取边界被接受；`expandTaskReadGrantCapabilities` 的展开结果冻结（计划 Step 5）。
9. **`AuthorizedTaskReadFactory` 是 Memory 读取唯一所有者**：`retrieveMemory/getMemory/queryMemory` 只能映射到 Broker `queryVerified`（T4 分层路径）；raw 基础 memory/store 方法不得作为 factory 依赖，provider 不得把 raw base memory 方法传给任何 read adapter；invalid/expired/missing-capability 在任何 backing port 调用前失败（计划 Step 5）。
10. **skills 冻结快照与非 official get 拒绝**：provider 只传 ledger-admitted、deep-frozen `SkillSummary[]`；`skills.list()` 先 `assertCurrentScope()` 再返回同一快照，二次调用零 backing read；`skills.get()` 规范化 `foo`/`skill:foo`、要求 ID 在冻结索引内、拒绝非 official 结果（计划 Step 5）。

## 7. 非目标

- 不创建 PG Region / Responsibility / membership 表，不做任何 task 或 memory schema 迁移（计划 Global Constraints；设计 §1.2）。
- 不做 embedding、向量库或真实语义检索精度优化；本 lane 复用 T4 分层 retriever，不引入第二 wave 端口（设计 §1.2；计划 Step 5）。
- 不做自动 Region 发现/拆分/合并/迁移、自动 Role 分化、长期 autoscaler 或成本最优调度（设计 §1.2）。
- 不修改 N26 Source / Intake / Verification / Promotion 状态机（设计 §1.2）。
- 不把实验阈值宣布为生产默认值；实验常量不进入生产配置默认值（设计 §6.2）。
- 不包装 `write`、`maintain`、`review`、`promotion` 或 task-control 函数；`createBudgetedTaskCapabilities` 只包装 7 条读路径（计划 Step 5）。
- 本 lane 不实现 Task 6 的 `CognitiveWorkingSetProvider` 与 runner 接线；只冻结并导出 factory、policy、budgeted facade 供 T6 消费（计划 Task 5/6 边界）。

## 8. 验收标准

### 8.1 定向测试

计划本 Task 的全部 Run 命令（逐字）：

1. Step 2：`npx vitest run test/pth-kernel-execution/cognitive-budget.test.ts`
2. Step 6：`npx vitest run test/pth-kernel-execution/cognitive-budget.test.ts test/pth-runner/authorized-state-reads.test.ts test/pth-runner/authorized-task-reads.test.ts test/pth-runner/cognitive-working-set.test.ts`

（本 Task 计划内无 `npx tsc` Run 命令；类型检查归入全量门槛与 N28 acceptance 的独立 tsc 门。）

Expected 中的关键断言点：

- Step 1 ledger 测试：
  - `counts the initial context and later memory reads in the same budget`：先收 `m1=2000`、`m2=2000` 为 accepted；再收 `m3=200` 为 omitted；snapshot usage 为 `{memoryEntries:2, memoryChars:4000}`。
  - `charges only the positive representation delta when a summary expands to full text`：`maxMemoryChars=500` 时先收 200，展开 450 accepted 且 usage 为 450；再展开 501 拒绝且 usage 保持 450。
  - `counts pinned tools and rejects a pinned face that already exceeds the limit`：`maxTools=2` 时 `freezeTools(["done","ts_run","asp_cd"],[])` 抛出 `/pinned tools exceed/`。
  - `allows only indexed skills and caps active skill count and characters`：`maxActiveSkills=1, maxSkillChars=15` 时 `activateSkill("skill:a",10)` 为 `true`；`skill:b` 为 `false`；`skill:a` 16 为 `false`；`skill:outside` 抛 `/not in frozen skill index/`。
- Step 4：`never exceeds any axis across 1000 deterministic generated surfaces`：同种子 reverse 输入两次 `snapshot()` `toEqual`；memoryEntries/memoryChars/skillIndexEntries/activeSkills/skillChars/tools 六轴均 ≤ `N28_FEASIBILITY_BUDGET.task` 上限；生成的 responsibility capacity `ok` 与 usage 符合 `maxRegions=3`、`maxPrimaryWeight=80`、`maxSecondaryWeight=40`。
- Step 6 facade bypass 测试：全部读路径依次过 wrapper 后合并账本仍六轴合规；summary→full 只收正差额；公开 API 形状不变；非 official get 拒绝；冻结索引外 Skill 拒绝；huge metadata-only query / function spec / Skill meta 均在暴露前计费或省略；`skills.list()` 两次调用逐字节一致且 wrapper 不调用 backing list port；clock 推进后 cached `skills.list()` 拒绝；invalid/expired/missing-capability 时每个 backing-port 调用次数保持 0；任一 memory 方法使用独立账本时测试必须失败。

### 8.2 关闭条件对账表

| 关闭条件（来自计划 Expected、全局约束、本 lane focus） | 证据要求 |
|---|---|
| 统一预算为硬上限：六个预算轴全上限 | Step 1 ledger 六轴测试 + Step 4 1,000 组输入逐轴断言 `usage.* <= N28_FEASIBILITY_BUDGET.task.*` |
| 初始 Context 与后续 memory reads 同一账本 | Step 1 `counts the initial context and later memory reads in the same budget`；Step 6 合并账本仍六轴合规 |
| `canonicalExposureChars` 只计实际暴露投影（含 metadata-only 行、evidence/meta、spec） | Step 3 实现审查；Step 6 huge metadata-only query、huge function spec、huge Skill meta 均被计费或 exposure 前省略 |
| summary→full 只收正差额 | Step 1 `charges only the positive representation delta...`（450 后拒 501 且 usage 保持 450）；Step 6 facade 全路径 |
| pinned tools 计入 `maxTools` 且超限在 LLM 前失败 | Step 1 `freezeTools(["done","ts_run","asp_cd"],[])` 抛 `/pinned tools exceed/`；T6 再验证 LLM 前拒绝 |
| 1,000 组重排输入 ledger 输出逐字节一致 | Step 4 `expect(second).toEqual(first)` |
| 操作→capability 映射表逐字冻结，family 名不得在读取边界被接受 | Step 5 冻结表；`authorized-task-reads.test.ts` 中 family 名读取边界拒绝用例 |
| invalid/expired/missing-capability 时 backing port 调用次数为 0 | Step 6 三个 case 跨 memory/recall/Skill 面，断言每个 backing-port 调用计数为 0 |
| `AuthorizedTaskReadFactory` 是 Memory 读取唯一所有者；raw 基础 memory/store 方法不得作为 factory 依赖 | Step 5 工厂契约与 `authorized-task-reads.test.ts`；T6 provider 测试断言无 raw base read 传入 |
| `skills.list` 冻结快照二次调用零 backing read | Step 6 `skills.list()` 两次逐字节一致且 wrapper 不调用 backing list port；clock 推进后 cached list 拒绝 |
| 非 official get 拒绝 | Step 6 非 official get 拒绝用例 |

> **特别注意（写入关闭对账）**：六个预算轴全上限；canonicalExposureChars 只计实际暴露投影（含 metadata-only 行、evidence/meta、spec）；summary→full 只收正差额；pinned tools 计入 maxTools 且超限在 LLM 前失败；1,000 组重排输入 ledger 输出逐字节一致；操作→capability 映射表（7 个 read surface）逐字冻结，family 名不得在读取边界被接受；invalid/expired/missing-capability 时 backing port 调用次数为 0。AuthorizedTaskReadFactory 是 Memory 读取唯一所有者。合并者额外 review：raw 基础 memory/store 方法不得作为 factory 依赖；skills.list 冻结快照二次调用零 backing read；非 official get 拒绝。

### 8.3 全量门槛

合并者合并前：`npx vitest run` 全绿（既有 9 skip 基线不变）+ `npm run lint` 全绿；真实 PG 环境不可用按 `EVALUATION-INCOMPLETE` 记录，不得冒充通过。

## 9. merge 前合并者检查清单

1. **六轴硬上限与工具面**：逐轴核对 ledger 在 entry/char/工具数超限前停止；`freezeTools` 先计 pinned，pinned 自身超限必须在任何 LLM 调用前失败，且静态+ToolReg 共用 `maxTools`。
2. **投影计费与正差额**：核对 `canonicalExposureChars` 覆盖 metadata-only 行、evidence/meta、function `spec`、insight 对象与 Skill `MemoryEntry` 字段；summary→full 只收正差额，同 representation 重读不重复计费。
3. **确定性与唯一所有者**：1,000 组重排输入 `ledger.snapshot()` 逐字节一致；`AuthorizedTaskReadFactory` 是 Memory 读取唯一所有者，raw 基础 memory/store 方法不得作为 factory 依赖或 read adapter 传入。
4. **读取边界冻结**：操作→capability 映射表（7 个 read surface）逐字冻结；family 名不得在读取边界被接受；invalid/expired/missing-capability 时所有 backing port 调用次数为 0。（T7 的 32 个授权探针 = 8 个授权面 × 4 种失效；第 8 授权面 = KnowledgeContext build，见 `docs/pth/n28-lane-contract-rulings.md` 裁决 C2。）
5. **skills 与非 official**：`skills.list` 冻结快照二次调用零 backing read；`skills.get` 必须拒绝非 official get；冻结索引外的 Skill 在 facade 层拒绝。

## 10. 偏差纪律

- lane 内只动 §3 文件域；如需触及其他文件，先停 lane 报告用户裁决。
- 发现计划缺陷/步骤不可执行：停下报告，不自行改计划。
- README 徽章/测试总数只在合并回 main 时更新。
- 每 lane 一条 commit（focus 测试 + 契约内文件域）；偏差必须写进 commit body。
- 实现期不得弱化任何 N27 已验收契约、不变量或回归测试。
