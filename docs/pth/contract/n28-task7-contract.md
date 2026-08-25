# N28-T7 契约：可复现 Go/No-Go 评测器与最终验收

> 对应实施计划 Task 7（docs/pth/plan/n28-role-memory-orchestration-implementation-plan.md L2356–L2902（+执行顺序 L2905–L2924））；验证假设：H1–H6 汇总判定 + 最终 acceptance envelope
> 上游依赖：T1–T6 全部完成并合并回 main
> Gate 0 记录：N27 最终复验报告 docs/pth/report/v1.2-acceptance-fix-revalidation-final.md 为 ACCEPTED；复验对象 main@c2c0729（R6=4d0a38b 经 merge c2c0729 合入 main，R1–R6 全部 merged）；N28 设计/计划基线 commit 9f10082（docs-only）。本 lane 实现分支必须派生自包含 9f10082 的 main，且首条 commit 信息注明 Gate 0 已过。
> 车道：分支 lane/n28-t7-evaluator-acceptance，worktree .worktrees/n28-t7，串行合并顺序 T1→T2→T3→T4→T5→T6→T7。

## 1. 目标

实现 Task 7「Add a Reproducible Go/No-Go Evaluator and Record the Feasibility Result」：新增可复现的 Go/No-Go 评测器与最终验收驱动，机械汇总 H1–H6 判定。Expected 为：评测器只从 metrics 推导假设与 NO-GO 条件，两次运行 byte-identical；最终 `N28AcceptanceEnvelope` 是可行性决定的唯一权威，并据此生成带证据的 GO/NO-GO 报告。

## 2. 上游接口（Consumes）

计划原文：Consumes: all Task 1–6 production classes and frozen fixtures。

| 接口全名 | 来源文件 | 上游 Task |
|---|---|---|
| `RoleDefinition`、`RoleDefinitionRef`、`WorkerReplicaRef`、`MemoryType`、`MemoryRegion`、`MemoryResponsibility`、`ResponsibilityCapacity`、`CognitiveBudget`、`WorkerLoadEnvelope`、`TaskWorkingSetPolicy`、`TaskWorkingSet`、`PendingRetrievalTrace`、`RetrievalTrace`、`N28_FEASIBILITY_BUDGET`、`checkResponsibilityCapacity()` | `src/pth/contracts/cognitive-responsibility.ts` | T1 |
| `WorkerReplica`、`WorkerReplicaStatus`、生产用 `WorkerSlotRuntime`（由 `batch-process.ts` 使用）、batch heartbeat `replicas[]`、`pauseReplica()`、`resumeReplica()`、`removeReplica()`、确定性 stopped-slot cleanup、运行时 `TaskDispatchContext.worker` stamping | `src/pth/kernel/execution/worker-replica.ts`、`src/pth/bootstrap/worker-slot-runtime.ts`、`src/pth/bootstrap/batch-runtime-assembly.ts`、`src/pth/bootstrap/batch-process.ts` | T2 |
| `MemoryTypeClassifier`、`MemoryDirectorySnapshot`、`buildMemoryDirectorySnapshot()`、`assertMemoryDirectorySnapshotIntegrity()`、`assertMemoryDirectoryResponsibilityCapacity()`、`responsibilitiesForWorker()`、`membershipsForEntry()`、`regionEntryIds()` | `src/pth/execution/memory-type-classifier.ts`、`src/pth/execution/memory-directory.ts` | T3 |
| `VerifiedTaskReadScope`、`VerifiedTaskReadScopeFactory`、`createLayeredKnowledgeRetriever()`、`LayeredRetrievalRequest`、per-call `searchWave` port、`PendingRetrievalTrace`、KnowledgeBroker/KnowledgeContextProvider 中的 optional layered 路径 | `src/pth/execution/layered-knowledge-retriever.ts`、`src/pth/execution/authorization/verified-task-read-scope.ts`、`src/pth/execution/knowledge-broker.ts`、`src/pth/runner/knowledge-context.ts` | T4 |
| `CognitiveBudgetLedger`、`CognitiveBudgetExceededError`、scope-bound canonical state reads、`AuthorizedTaskReadFactory`、`createTaskWorkingSetPolicy()`、`createBudgetedTaskCapabilities()`、确定性 `snapshot()` | `src/pth/kernel/execution/cognitive-budget.ts`、`src/pth/runner/authorized-task-reads.ts`、`src/pth/runner/authorized-state-reads.ts`、`src/pth/runner/cognitive-working-set.ts` | T5 |
| optional `CognitiveWorkingSetProvider`、agent-loop `toolAllowlist`、execution-time hidden-tool rejection、TaskOutcome usage/trace 中的 final working-set snapshot | `src/pth/kernel/execution/agent-loop-types.ts`、`src/pth/kernel/execution/agent-loop.ts`、`src/pth/kernel/execution/agent-loop-guards.ts`、`src/pth/runner/cognitive-working-set.ts`、`src/pth/bootstrap/task-loop-types.ts`、`src/pth/bootstrap/task-loop.ts` | T6 |
| 冻结 corpus、worker refs、regions、responsibilities、gold queries；共享 harness 及其可选 `sabotage` 参数 | `scripts/tools/n28-feasibility-fixture.ts`、`scripts/tools/n28-feasibility-harness.ts` | T3/T6 |

## 3. 实施范围

| 文件（Create/Modify 逐字列全） | 改动 |
|---|---|
| `scripts/eval/eval-n28-feasibility.ts` | Create |
| `scripts/accept/accept-n28-feasibility.ts` | Create |
| `tsconfig.n28.json` | Create |
| `scripts/tools/n28-feasibility-harness.ts` | Modify |
| `scripts/tools/n28-feasibility-fixture.ts` | Modify |
| `test/pth-runner/n28-feasibility-evaluator.test.ts` | Create |
| `test/pth-runner/n28-feasibility-acceptance.test.ts` | Create |
| `docs/pth/report/n28-feasibility-report.md` | Create after execution |
| `docs/README.md` | Modify |

## 4. 接口产出（Produces，冻结表）

| 接口全名 | 冻结语义 | 哪个后续 Task 消费 |
|---|---|---|
| `N28FeasibilityMetrics` | 全部 metric 字段与 `METRIC_KEYS` 逐字冻结；只做结构校验，精确分母与阈值属于 hypothesis/direct predicates | 无后续 N28 Task；由 evaluator/acceptance 测试与报告消费 |
| `N28FeasibilityResult` | `decision: "GO" \| "NO-GO"`、`hypotheses: Record<"H1"\|"H2"\|"H3"\|"H4"\|"H5"\|"H6", { passed: boolean; evidence: string[] }>`、`metrics: N28FeasibilityMetrics` | 由 `accept-n28-feasibility.ts` 的 envelope 与报告消费 |
| `N28AcceptanceEnvelope` | `evaluatedCommit`、`implementationTreeClean`、`evaluator.{first,second,byteIdentical}`、`focused`/`n28Typecheck`/`fullRegression`/`lint` 四个 `CommandGateEvidence`、`decision: "GO"\|"NO-GO"\|"EVALUATION-INCOMPLETE"`、`reasons` | 唯一终审；由后续生产化计划（GO 后才授权编写）与合并者消费 |
| CLI JSON | evaluator/acceptance driver stdout JSON；进程退出码（evaluator：0=provisional GO、1=provisional NO-GO；driver：0=GO、1=NO-GO、2=EVALUATION-INCOMPLETE） | 合并者、报告生成与 README 索引消费 |
| evidence-backed GO/NO-GO report | `docs/pth/report/n28-feasibility-report.md`：commit SHA、精确命令、H1–H6 PASS/FAIL 证据、evaluator JSON metrics、完整 acceptance envelope、免责句 | `docs/README.md` 索引与后续生产化计划消费 |

## 5. 关键步骤

- **Step 1**：先写失败的 evaluator 聚合测试。Expected：passing fixture 判 GO；每个 metric 的坏值判 NO-GO；NaN/Infinity/-1 与缺字段被判非法；六条 sabotage 路径各自使对应 H 失败且 sentinel 较 baseline 增加；unsabotaged 运行不硬编码决定且 metrics 满足 `goldQueries: 12`、`generatedBudgetCases: 1000`。
- **Step 2**：实现 `eval-n28-feasibility.ts`，只调用真实 harness exports。Expected：`METRIC_KEYS` 覆盖全部接口键；`validateN28FeasibilityMetrics` 仅做结构校验；H1–H6 按计划表从 metrics 机械推导；非空分母精确冻结；CLI 入口有 `import.meta.url` guard；evaluator 与 Vitest 互不 import；sabotage 分支与 evaluator import 不得进入 `src/pth/**`。
- **Step 3**：让直接 No-Go 条件覆盖汇总 metrics。Expected：`decideN28Feasibility(metrics)` 是唯一决策函数，GO 当且仅当每个 hypothesis 与每条直接不变量通过；调用方不能传入独立 hypothesis booleans；evaluator 从不硬编码期望成功。
- **Step 4**：定义最终 acceptance envelope 及其决策测试。Expected：`N28AcceptanceEnvelope` 字段冻结；skip manifest 冻结 `N28_ACCEPTED_BASELINE_SKIPS`（9 条 sandbox-security skip）；`parseVitestSkipManifest` 归一化路径、聚合重复行、拒绝未知 JSON shape；`decideN28Acceptance` 的全部 GO 条件与 EVALUATION-INCOMPLETE/NO-GO 规则冻结；environment unavailable 只能来自 preflight 四类探针；driver 也有 `import.meta.url` guard；决策测试变异每个字段/gate 均不返回 GO。
- **Step 5**：先提交 evaluator、acceptance driver 与共享 harness，再收集证据。Expected：创建 `tsconfig.n28.json`（裁决 C7 收窄后的 N28 专有文件清单——4 scripts + vertical/evaluator/acceptance 三测试；source paths 覆盖 clean-checkout 依赖闭包，不替换为 workspace `dist` 声明）；记录实现 commit SHA 作为 evaluated implementation commit，不得 amend。
- **Step 6**：evaluator 运行两次并验证 byte-stable 语义输出。Expected：两次运行退出码相同（0=provisional GO，1=provisional NO-GO）且 `diff` 无输出；JSON 不含时间戳、随机 ID 或机器路径。
- **Step 7**：运行完整 N28 focused gate。Expected：`npx tsc -p tsconfig.n28.json --noEmit` 通过并记录为独立 `n28Typecheck` gate；随后 `npx vitest run`（Step 7 文件清单）全部 PASS 且无 PG/Redis skip（该 slice 刻意 in-memory）；unsabotaged 集成测试只验证 evidence/decision 一致性，不要求 GO。
- **Step 8**：运行既有回归与架构门禁。Expected：`npm test` 与 `npm run lint` 在 N27 认可的同一环境 PASS 且无新 skip；`check:pth-boundaries` 与 `check:pth-config` 零违规；PG/Redis 不可用或 sandbox 受限基线只记「evaluation not completed」，不得记为 GO 或 N28 功能失败。
- **Step 9**：构建 acceptance envelope 并记录精确结果，不得升级为生产验收。Expected：driver 导出唯一的 `N28_FOCUSED_TEST_FILES` 数组且与 Step 7 冻结清单完全相等；只解析 Vitest JSON reporter 输出；进程退出 0/1/2 对应 GO/NO-GO/EVALUATION-INCOMPLETE；创建 `docs/pth/report/n28-feasibility-report.md` 且最终结论只取自 envelope；GO 只列下一步规划输入，不创建生产 schema 或 ADR。
- **Step 10**：从文档索引链接 N28。Expected：在 `docs/README.md` 增加两行 PTH 条目（N28 设计/实施计划 + feasibility report）；仅当最终 envelope（而非 provisional evaluator）为 GO 时报告才标 GO。
- **Step 11**：提交不可变报告与索引更新。Expected：仅 `git add docs/pth/report/n28-feasibility-report.md docs/README.md` 并以 `docs(pth): record N28 feasibility decision` 提交。

## 6. 设计裁决与红线

1. **唯一决策函数**：`decideN28Feasibility(metrics)` 是唯一判定入口；H1–H6 从 metrics 机械推导，调用方不得提供独立 hypothesis booleans；evaluator 不得硬编码期望成功。
2. **结构校验与业务判定分离**：`validateN28FeasibilityMetrics(value: unknown): string[]` 只做结构校验——缺/多字段、非数、`NaN`、`Infinity`、负计数、比值越 `[0,1]`；精确分母与阈值属于 hypothesis/direct predicates。结构非法 → NO-GO 且 H1–H6 全 false 并附验证证据；结构合法但计数失败 → 仍推导各 H，使责任 H 可观察。
3. **非空分母精确冻结**：`workerLifecycleProbeCases===6`、`directoryInvariantProbeCases===8`、`authorizationProbeCases===32`、`surfaceComparisonCases===12`；H1 另需 `batchRuntimeProbeCases===1`、`stoppedSlotCleanupProbeCases===2`、`heartbeatIdentityProbeCases===4`、`auditIdentityProbeCases===3`、`grantIdentityProbeCases===3`；H2 另需 `directoryDeterminismProbeCases===1`；H4 另需 `visibilityProbeCases===14`；H6 另需 `hiddenDispatchProbeCases===1`；H3/H5 另冻结 `goldQueries`/`goldFoundQueries`/`fourWaveCases===12`、`generatedBudgetCases===1000`、`generatedResponsibilityCases===1000`。这些计数只在命名公共探针实际返回观察后递增；无观察的 0 是 vacuous，判 No-Go。
4. **直接 No-Go 覆盖汇总分**：`decideN28Feasibility` 在任一 hypothesis 未过或任一步骤 3 直接不变量失败时返回 NO-GO；H6 在 fake LLM 收到冻结 Tool face 外 schema 或隐藏 executor 被调用时也失败。
5. **Sabotage 哨兵映射逐字冻结**：`control-target-swap`→H1/`sameRoleReplicaControlFailures`；`directory-body-copy`→H2/`bodyCopiesOutsideCanonicalStore`；`remove-global-wave`→H3/`missingFourWaveCases`；`scope-guard-bypass`→H4/`unauthorizedReadPortInvocations`；`budget-wrapper-bypass`→H5/`budgetViolations`；`tool-dispatch-guard-bypass`→H6/`hiddenExecutorInvocations`。sabotage 参数只能存在于 harness，不得直接写 metric/hypothesis/counter；必须经同一观察者捕获，且 sentinel 必须较 unsabotaged baseline 增加。
6. **Provisional 与唯一终审**：evaluator 判定是 provisional；只有 `accept-n28-feasibility.ts` 可发最终 GO。报告不得把 provisional evaluator decision 复制为最终结论；driver 进程退出 0/1/2 对应 GO/NO-GO/EVALUATION-INCOMPLETE。
7. **Skip manifest 冻结**：`N28_ACCEPTED_BASELINE_SKIPS = [{ file: "test/pth-execution/sandbox-security.integration.test.ts", tests: 9 }] as const`；解析只认 Vitest JSON `testResults[].assertionResults[]` 中 `pending`/`skipped`/`todo`/`disabled`，路径相对化并统一 `/`，聚合重复文件、去零计数、按仓库相对路径排序；拒绝未知 JSON shape，不回退 stdout 或 `numPendingTests`。
8. **环境不可用只来自 preflight 四类探针**：`postgres`/`redis`/`sandbox`/`toolchain`，且必须在命令执行前运行；gate 一旦 `started=true`，非零退出永远是 NO-GO，不得把已执行失败测试改标为环境问题。
9. **实验预算照抄设计/计划**：`maxRegions=3`、`maxPrimaryWeight=80`、`maxSecondaryWeight=40`（overlap + fallback）、`maxMemoryEntries=8`、`maxMemoryChars=4096`、`maxSkillIndexEntries=8`、`maxActiveSkills=4`、`maxSkillChars=8192`、`maxTools=16`；static 与 ToolReg 共享同一 `maxTools` 上限；不得宣布为生产默认值。
10. **可复现与边界**：两次 evaluator 输出 byte-identical；JSON 不含时间戳/随机 ID/机器路径；Vitest 与 CLI 都从 `scripts/tools/n28-feasibility-fixture.ts` 取冻结 corpus 等输入且互不 import；evaluator import 与 sabotage 分支不得进入 `src/pth/**`；`tsconfig.n28.json` 文件清单按裁决 C7 收窄（N28 专有文件），source path overrides 覆盖 clean-checkout 依赖闭包，不替换为 workspace `dist` 声明。

## 7. 非目标

- 不创建任何 PG 表，不做自动 Region 拆分/合并/迁移、自动 Role 分化、autoscaling、embedding/向量检索优化；不修改 N26 Source/Intake/Verification/Promotion 状态机。
- 不把实验阈值直接宣布为生产默认值；GO 只授权编写下一步实施计划，不授权数据库迁移、自动均衡、扩缩容、Role 演化或 N26 集成。
- 不实现 GO 后的生产化事项：persistent WorkerReplica lease identity、Region/Responsibility revision tables、membership outbox、real-corpus weight calibration、make-before-break rebalance。
- 不创建生产 schema 或 ADR；报告出现 NO-GO 时列失败直接条件并停止，出现 EVALUATION-INCOMPLETE 时列缺失证据并在认可环境重跑。
- 不把 NO-GO 洗成绿测：NO-GO 是有效可行性结果，仍继续生成报告。
- 不在 evaluator 内重新实现 ranking、visibility、budgeting 或 tool filtering；不允许 evaluator/Vitest 互相 import，不允许 sabotage 分支或 evaluator import 进入 `src/pth/**`。

## 8. 验收标准

### 8.1 定向测试

以下 Run 命令逐字取自计划 Task 7（vitest/tsc 为本 lane 的测试/类型门禁；Step 6/9 的 TSX 命令一并冻结供对账）。

```bash
npx tsc -p tsconfig.n28.json --noEmit
```

```bash
npx vitest run \
  test/pth-contracts/cognitive-responsibility.test.ts \
  test/pth-kernel-execution/worker-cluster.test.ts \
  test/pth-kernel-execution/role-lineage.test.ts \
  test/pth-config/config.test.ts \
  test/pth-kernel-execution/worker-replica.test.ts \
  test/pth-kernel-execution/worker-slot-assembly.test.ts \
  test/pth-kernel-execution/worker-slot-runtime.test.ts \
  test/pth-kernel-execution/batch-runtime-assembly.test.ts \
  test/pth-kernel-execution/task-loop.test.ts \
  test/pth-kernel-execution/batch-manager.test.ts \
  test/pth-execution/memory-type-classifier.test.ts \
  test/pth-execution/memory-directory.test.ts \
  test/pth-execution/knowledge-ranking.test.ts \
  test/pth-execution/verified-task-read-scope.test.ts \
  test/pth-execution/layered-knowledge-retriever.test.ts \
  test/pth-kernel-execution/cognitive-budget.test.ts \
  test/pth-runner/authorized-state-reads.test.ts \
  test/pth-runner/authorized-task-reads.test.ts \
  test/pth-runner/cognitive-working-set.test.ts \
  test/pth-tasking/task-outcome-observers.test.ts \
  test/pth-execution/knowledge-broker.test.ts \
  test/pth-runner/knowledge-context.test.ts \
  test/pth-runner/agent-task-runner.test.ts \
  test/pth-kernel-execution/agent-loop.test.ts \
  test/pth-kernel-execution/prompt-docs.test.ts \
  test/pth-kernel-execution/agent-tool-convergence.test.ts \
  test/pth-kernel-execution/agent-loop-working-set.integration.test.ts \
  test/pth-kernel-execution/agent-loop-ptc.integration.test.ts \
  test/pth-runner/cognitive-responsibility.vertical.test.ts \
  test/pth-runner/n28-feasibility-evaluator.test.ts \
  test/pth-runner/n28-feasibility-acceptance.test.ts \
  --reporter=json \
  --outputFile /tmp/n28-focused.json
```

```bash
npm test -- --reporter=json --outputFile /tmp/n28-full.json
npm run lint
```

```bash
TSX_TSCONFIG_PATH=tsconfig.n28.json node --import tsx scripts/eval/eval-n28-feasibility.ts > /tmp/n28-run-1.json
TSX_TSCONFIG_PATH=tsconfig.n28.json node --import tsx scripts/eval/eval-n28-feasibility.ts > /tmp/n28-run-2.json
diff -u /tmp/n28-run-1.json /tmp/n28-run-2.json
```

```bash
TSX_TSCONFIG_PATH=tsconfig.n28.json node --import tsx scripts/accept/accept-n28-feasibility.ts --output /tmp/n28-acceptance.json
```

关键断言点（Expected）：

- `npx tsc -p tsconfig.n28.json --noEmit`：通过，作为独立 `n28Typecheck` gate；`scripts/**` 与 feasibility 测试不能仅靠 Vitest 转译不查类型而通过。
- focused `npx vitest run`：所有 contract 与 mutation 测试 PASS，且无 PG/Redis skip（feasibility slice 刻意 in-memory）；unsabotaged 集成测试验证 evidence/decision 一致性，不要求 GO；CLI 与 report 才携带真实 feasibility 结论。
- `npm test`：在与 N27 验收相同的认可环境 PASS，且无新 skip；`check:pth-boundaries` 与 `check:pth-config` 零违规；PG/Redis 不可用或 sandbox 受限基线记「evaluation not completed」。
- `npm run lint`：全绿。
- evaluator 两次运行：退出码相同（0=provisional GO，1=provisional NO-GO），`diff` 无输出。
- acceptance driver：进程退出 0 仅限最终 GO，1 为 NO-GO，2 为 EVALUATION-INCOMPLETE。

### 8.2 关闭条件对账表

> 以下关闭条件从计划 Expected、全局约束与本 lane focus 逐条抽取；严禁缩窄或放宽计划的任何条件。

**8.2.1 evaluator 判定纯度与机械推导**

| 关闭条件 | 证据要求 |
|---|---|
| evaluator 判定只能从 metrics 机械推导，不得接受独立 hypothesis 布尔 | `n28-feasibility-evaluator.test.ts` 对 passing fixture 断言 GO、对每个 metric 坏值断言 NO-GO；代码 review 确认 `decideN28Feasibility` 是唯一决策函数，无独立 hypothesis 入参 |
| `METRIC_KEYS` 覆盖 `N28FeasibilityMetrics` 全部键 | 测试断言 `Object.keys(badValueByMetric).sort()` 与 `[...METRIC_KEYS].sort()` 相等 |
| `validateN28FeasibilityMetrics` 仅做结构校验：缺/多字段、非数、`NaN`、`Infinity`、负计数、比值越 `[0,1]` | 测试对 `NaN`/`Infinity`/`-1` 断言非空错误；删除 `goldQueries` 后 `decide` 为 NO-GO |
| 结构非法 → NO-GO 且 H1–H6 全 false 并附验证证据；结构合法但计数失败 → 仍推导各 H | 测试第一例 + 代码 review；sabotage 用例断言对应 `hypotheses[H].passed === false` 而其余 H 可观察 |
| H1 精确谓词（照抄计划 Step 2 表） | 六个 lifecycle probes 及 batch-runtime/cleanup/heartbeat/audit/grant 分母全部跑满；same-role control、batch-runtime consumption、stopped-slot cleanup、heartbeat identity、audit identity、grant identity failures 全为 0 |
| H2 精确谓词（照抄计划 Step 2 表） | 8 个 invariant probes + 1 个独立重排输入 determinism probe 跑满；directory coverage=1；恰好 4 个 Memory Types；canonical body count=100；membership references 超过 canonical bodies；overlap memberships≥1；ownerless Regions/body copies/directory invariant failures/snapshot mismatches=0 |
| H3 精确谓词（照抄计划 Step 2 表） | 恰好 12 个 gold queries 跑满且全部找到；gold recall=1；全部 12 例 waves 恰为 `[0,1,2,3]`；max waves≤4；max `RetrievalWaveTrace.selectedCount`≤20；incomplete/failed gold cases=0；`candidateCount`/`scannedCount` 保持诚实可观测值，不被本内存证明封顶 |
| H4 精确谓词（照抄计划 Step 2 表） | 全部 32 个 authorization cells（8 个授权面 × 4 种失效；八面 = KnowledgeContext build + memory.retrieve/get/query + state.recallFunctions/Insights + skills.list/get，见裁决 C2）与全部 14 个 Broker/Context visibility observations 跑满；authorization leaks、unauthorized wave invocations、unauthorized Memory/Skill/state backing-port invocations=0；invalid/expired/missing-capability grants 不调用任何 backing read |
| H5 精确谓词（照抄计划 Step 2 表） | 恰好 1,000 个 task budget cases 与 1,000 个 responsibility cases 跑满；budget/responsibility/snapshot/Working Set determinism violations=0 |
| H6 精确谓词（照抄计划 Step 2 表） | 全部 12 个 surface comparisons 与真实 omitted-tool dispatch probe 跑满；schema/Skill/working-set surface mismatches 与 hidden executor invocations=0 |
| 每个 evidence array 只命名产生测试/harness probe 与观察到的 counter；booleans 不得独立于 metrics 提供 | 代码 review；evaluator JSON `hypotheses.*.evidence` 内容 |
| 直接计数器只描述 unsabotaged acceptance run；故意注入的 negative/sabotage probes 只断言 detector 触发，不计入正向 run 的 leak/failure 总数 | `detects one mutation for each H1-H6 path` 测试结构 + unsabotaged 运行对账 |
| 非空分母精确冻结：`workerLifecycleProbeCases=6`、`directoryInvariantProbeCases=8`、`authorizationProbeCases=32`、`surfaceComparisonCases=12`、`batchRuntimeProbeCases=1`、`stoppedSlotCleanupProbeCases=2`、`heartbeatIdentityProbeCases=4`、`auditIdentityProbeCases=3`、`grantIdentityProbeCases=3`、`directoryDeterminismProbeCases=1`、`visibilityProbeCases=14`、`hiddenDispatchProbeCases=1`、`goldQueries=12`、`goldFoundQueries=12`、`fourWaveCases=12`、`generatedBudgetCases=1000`、`generatedResponsibilityCases=1000` | `passingMetricsFixture()` 逐项枚举上述精确值；`decideN28Feasibility` 直接条件逐项相等断言；CLI JSON metrics 对账 |
| 6 个 sabotage 哨兵映射逐字冻结：`control-target-swap`→H1/`sameRoleReplicaControlFailures`；`directory-body-copy`→H2/`bodyCopiesOutsideCanonicalStore`；`remove-global-wave`→H3/`missingFourWaveCases`；`scope-guard-bypass`→H4/`unauthorizedReadPortInvocations`；`budget-wrapper-bypass`→H5/`budgetViolations`；`tool-dispatch-guard-bypass`→H6/`hiddenExecutorInvocations` | `n28-feasibility-evaluator.test.ts` 的 `cases` 对象与映射逐字一致；每个 sabotage 断言 `result.decision==="NO-GO"`、对应 H `passed===false`、对应 sentinel `> baseline` |
| sabotage 只能存在于 harness，不得直接写 metric/hypothesis/counter；sentinel 必须较 unsabotaged baseline 增加 | 代码 review + sabotage 测试的 `toBeGreaterThan(baseline.metrics[sentinel])` |
| 共享 harness 拥有唯一 canonical `Map<tenantId|entryId, body>`；`bodyCopiesOutsideCanonicalStore = duplicateCompositeIds + countBodyFields(projectionRoots)`；`canonicalBodyEntries` 为 map size，`directoryMembershipReferences = sum(membership.regionIds.length)` 且必须大于它 | 三个 detector 测试分别向 Directory membership、Responsibility、Working Set snapshot 注入 `content` 字段并断言同一 H2 counter 递增；代码 review |
| unsabotaged run 仍执行 negative contract probes 与两份独立重排 ledger，观察来自公共组件而非常量 | `runs the unsabotaged shared assembly without hardcoding its decision` + harness/vertical 测试证据 |

**8.2.2 decideN28Feasibility 直接 No-Go 条件（照抄 Step 3，逐条）**

| 关闭条件（任一条命中即 NO-GO） | 证据要求 |
|---|---|
| `metricSchemaErrors.length > 0` | `rejects a bad value for every metric, plus missing/non-finite fields` |
| `Object.values(hypotheses).some((item) => !item.passed)` | 上述 H1–H6 谓词对账 |
| `metrics.goldQueries !== 12` | `passingMetricsFixture` 与 CLI JSON 对账；坏值单测 |
| `metrics.goldFoundQueries !== 12` | 同上 |
| `metrics.fourWaveCases !== 12` | 同上 |
| `metrics.generatedBudgetCases !== 1000` | 同上 |
| `metrics.generatedResponsibilityCases !== 1000` | 同上 |
| `metrics.workerLifecycleProbeCases !== 6` | 同上 |
| `metrics.batchRuntimeProbeCases !== 1` | 同上 |
| `metrics.stoppedSlotCleanupProbeCases !== 2` | 同上 |
| `metrics.heartbeatIdentityProbeCases !== 4` | 同上 |
| `metrics.auditIdentityProbeCases !== 3` | 同上 |
| `metrics.grantIdentityProbeCases !== 3` | 同上 |
| `metrics.directoryInvariantProbeCases !== 8` | 同上 |
| `metrics.directoryDeterminismProbeCases !== 1` | 同上 |
| `metrics.authorizationProbeCases !== 32` | 同上 |
| `metrics.visibilityProbeCases !== 14` | 同上 |
| `metrics.surfaceComparisonCases !== 12` | 同上 |
| `metrics.hiddenDispatchProbeCases !== 1` | 同上 |
| `metrics.authorizationLeaks > 0` | 同上 |
| `metrics.goldRecall < 1` | 同上 |
| `metrics.budgetViolations > 0` | 同上 |
| `metrics.responsibilityViolations > 0` | 同上 |
| `metrics.sameRoleReplicaControlFailures > 0` | 同上 |
| `metrics.batchRuntimeConsumptionFailures > 0` | 同上 |
| `metrics.stoppedSlotCleanupFailures > 0` | 同上 |
| `metrics.heartbeatIdentityFailures > 0` | 同上 |
| `metrics.auditIdentityFailures > 0` | 同上 |
| `metrics.grantIdentityFailures > 0` | 同上 |
| `metrics.directoryCoverage < 1` | 同上 |
| `metrics.memoryTypesCovered !== 4` | 同上 |
| `metrics.canonicalBodyEntries !== 100` | 同上 |
| `metrics.directoryMembershipReferences <= metrics.canonicalBodyEntries` | 同上 |
| `metrics.overlapMemberships < 1` | 同上 |
| `metrics.ownerlessRegions > 0` | 同上 |
| `metrics.bodyCopiesOutsideCanonicalStore > 0` | 同上 |
| `metrics.directoryInvariantFailures > 0` | 同上 |
| `metrics.snapshotDeterminismMismatches > 0` | 同上 |
| `metrics.workingSetDeterminismMismatches > 0` | 同上 |
| `metrics.maxRetrievalWaves > 4` | 同上 |
| `metrics.missingFourWaveCases > 0` | 同上 |
| `metrics.maxWaveSelectedCount > 20` | 同上 |
| `metrics.unauthorizedWaveInvocations > 0` | 同上 |
| `metrics.unauthorizedReadPortInvocations > 0` | 同上 |
| `metrics.retrievalIncompleteCases > 0` | 同上 |
| `metrics.retrievalFailedCases > 0` | 同上 |
| `metrics.surfaceMismatches > 0` | 同上 |
| `metrics.hiddenExecutorInvocations > 0` | 同上 |
| H6 附加：fake LLM 收到冻结 Tool face 外 schema，或隐藏 executor 被调用 | H6 sabotage 用例 + 集成测试对 agent 实际表面捕获 |

**8.2.3 decideN28Acceptance 全部 GO 条件（逐条）**

| 关闭条件（GO 仅当以下全部满足） | 证据要求 |
|---|---|
| `evaluatedCommit` 是当前非空 HEAD | `n28-feasibility-acceptance.test.ts` 变异 missing/mismatched commit 断言不返回 GO；driver 记录并输出 evaluated commit SHA |
| `implementationTreeClean === true` | 同上，变异 dirty tree 断言不返回 GO；driver 输出工作树状态 |
| 两次 evaluator 输出 byte-identical，且两者均为 provisional GO | 同上，变异 non-identical evaluator JSON / provisional NO-GO 断言不返回 GO；Step 6 `diff -u` 无输出 |
| focused gate：`started=true`、`exitCode=0`、零 skip | 同上，变异 focused nonzero 或 skip 断言不返回 GO；`/tmp/n28-focused.json` 由 driver 解析 |
| N28-specific typecheck gate：`started=true`、`exitCode=0`、零 skip | 同上，变异 typecheck nonzero 或 skip 断言不返回 GO；driver 输出 `n28Typecheck` 证据 |
| full `npm test` gate：`started=true`、`exitCode=0`，skip manifest 恰为冻结清单且无新 skip | 同上，变异 full nonzero、new skip、missing baseline skip 断言不返回 GO；`/tmp/n28-full.json` 与 `N28_ACCEPTED_BASELINE_SKIPS` 比对 |
| lint gate：`started=true`、`exitCode=0` | 同上，变异 lint nonzero 断言不返回 GO |
| `environmentStatus="unavailable"` 只能来自命令执行前运行的显式 preflight 探针（postgres/redis/sandbox/toolchain），不得把已执行失败测试改标为环境问题 | 同上，变异 post-start failure falsely labelled unavailable 断言不返回 GO；代码 review |
| 命令无法启动，或 preflight 分类为 unavailable 的认可环境 → `EVALUATION-INCOMPLETE` | 同上，变异 non-started command、controlled unavailable preflight 断言不返回 GO 且 decision 为 `EVALUATION-INCOMPLETE` |
| 已执行测试/lint 失败或 skip manifest 变化 → `NO-GO` | 同上，对应变异断言 decision 为 `NO-GO` |
| 报告不得把 provisional evaluator decision 复制为最终结论 | 代码 review + report 与 envelope 对账 |
| evaluator 判定是 provisional；只有 `accept-n28-feasibility.ts` 可发最终 GO | 代码 review：`decideN28Acceptance` 唯一产终审；evaluator 只产 provisional result |
| skip manifest 冻结 9（`test/pth-execution/sandbox-security.integration.test.ts`，9 tests） | `parseVitestSkipManifest` 单测（POSIX/macOS 绝对路径归一化一致）+ acceptance 决策测试 |
| 报告必须含免责句：「This result validates the reversible in-memory orchestration model; it does not validate PG durability, automatic partitioning, autoscaling, real-LLM retrieval quality, or production default thresholds.」 | `docs/pth/report/n28-feasibility-report.md` 内容对账 |
| GO 只授权写生产化计划，禁止 ADR/schema | 计划 Step 9 原文 + report/commit 内容 review |
| 合并者额外 review：CLI 入口有 `import.meta.url` guard | `scripts/eval/eval-n28-feasibility.ts` 与 `scripts/accept/accept-n28-feasibility.ts` 均含 `import.meta.url === pathToFileURL(process.argv[1]).href` guard；acceptance 测试导入纯决策函数不得递归启动 driver |
| 合并者额外 review：`tsconfig.n28.json` 文件清单与裁决 C7 收窄后清单一致 | 人工比对（4 个 scripts + vertical/evaluator/acceptance 三测试）；source paths 覆盖 clean-checkout 依赖闭包，不替换为 workspace `dist` 声明 |
| 合并者额外 review：评估两次运行 byte-identical | Step 6 `diff -u` 无输出 + envelope `evaluator.byteIdentical === true` |
| 合并者额外 review：env unavailable 只能来自 preflight 四类探针 | `CommandGateEvidence.unavailableReason` 仅含 `postgres`/`redis`/`sandbox`/`toolchain`；代码 review `probeAcceptedN27Environment()` |

### 8.3 全量门槛

合并者合并前：`npx vitest run` 全绿（既有 9 skip 基线不变）+ `npm run lint` 全绿；真实 PG 环境不可用按 `EVALUATION-INCOMPLETE` 记录，不得冒充通过。

## 9. merge 前合并者检查清单

1. **判定纯度与冻结常量**：evaluator 判定只能从 metrics 机械推导，不得接受独立 hypothesis 布尔；非空分母精确冻结（`workerLifecycle=6`、`directoryInvariant=8`、`authorization=32`、`surfaceComparison=12`、`batchRuntime=1`、`stoppedSlotCleanup=2`、`heartbeatIdentity=4`、`auditIdentity=3`、`grantIdentity=3`、`directoryDeterminism=1`、`visibility=14`、`hiddenDispatch=1`、`gold=12`、`generatedBudget=1000`、`generatedResponsibility=1000`）；6 个 sabotage 哨兵映射逐字冻结；`decideN28Feasibility` 与 `decideN28Acceptance` 的全部 GO 条件已逐条写进 §8.2，未缩窄或放宽。
2. **终审与报告边界**：evaluator 判定是 provisional；只有 `accept-n28-feasibility.ts` 可发 GO；报告必须含免责句；GO 只授权写生产化计划，禁止 ADR/schema。
3. **CLI 与类型配置**：`scripts/eval/eval-n28-feasibility.ts` 与 `scripts/accept/accept-n28-feasibility.ts` 的 CLI 入口均有 `import.meta.url` guard（Vitest 导入不触发驱动）；`tsconfig.n28.json` 文件清单与计划 Step 5 逐字一致。
4. **可复现性**：评估两次运行 byte-identical（`diff` 无输出，envelope `byteIdentical=true`）；JSON 无时间戳/随机 ID/机器路径。
5. **环境诚实性**：`env unavailable` 只能来自 preflight 四类探针（postgres/redis/sandbox/toolchain），且必须在命令执行前；gate 一旦 `started=true`，非零退出永远是 `NO-GO`；skip manifest 冻结 9（sandbox-security 文件）且无新 skip。

## 10. 偏差纪律

- lane 内只动 §3 文件域；如需触及其他文件，先停 lane 报告用户裁决。
- 发现计划缺陷/步骤不可执行：停下报告，不自行改计划。
- README 徽章/测试总数只在合并回 main 时更新。
- 每 lane 一条 commit（focus 测试 + 契约内文件域）；偏差必须写进 commit body。**T7 例外**：按计划 Task 7 允许且仅允许两次提交——Step 5 的 `test(pth): add N28 feasibility evaluator`（该 SHA 即 evaluated implementation commit，之后不得 amend）与 Step 11 的 `docs(pth): record N28 feasibility decision`。
- 实现期不得弱化任何 N27 已验收契约、不变量或回归测试。

## 11. 人工批准修订 v1.1（第二轮复核 P0-5 / §8 条件 7）

- 批准人：本会话用户（选项「批准 Task7 合同 v1.1（推荐）」）。
- 批准内容：确认裁决 C7 合法有效——`tsconfig.n28.json` 收窄为 N28 专有 7 文件
  （4 scripts + vertical/evaluator/acceptance 三测试）是**批准后的合同版本**，不再是
  「评估后追加的收窄」；n28Typecheck 证据以 7 文件 zero-skip typecheck 为准，
  `npm run lint` 的根 `tsc --noEmit` 继续承担源码类型正确性。
- 效力：本修订作为 Task 7 合同 v1.1 的一部分，与 §1–§10 同等效力；若未来扩回
  31 文件 typecheck，需另立 v1.2 修订并再次人工批准。

## 12. 人工批准修订 v1.2（恢复 35 文件 typecheck）

- 批准人：本会话用户（复验收 Phase B D-2 选择「恢复 35 文件（推荐）」）。
- 批准内容：恢复原 Task 7/实施计划要求的 **35 文件 typecheck**——`tsconfig.n28.json`
  覆盖 4 个 scripts + 31 个 focused tests，不再使用 C7 的 7 文件收窄口径。
- 效力：本修订取代 v1.1 的 C7 收窄；n28Typecheck 证据以 35 文件 zero-skip typecheck 为准，
  与实施计划 `:2723-2786` 的文件清单一致。
