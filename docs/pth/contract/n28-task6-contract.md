# N28-T6 契约：真实 agent 面服从 Working Set（prompt/Skill/Tool 三处一致）

> 对应实施计划 Task 6（docs/pth/plan/n28-role-memory-orchestration-implementation-plan.md L1987–L2352）；验证假设：H6：工作集真实进入 agent 面；集合外调用被拒绝
> 上游依赖：T2（replica/TaskLoop 透传）+ T4（verified scope/Context）+ T5（budgeted capabilities/provider）
> Gate 0 记录：N27 最终复验报告 docs/pth/report/v1.2-acceptance-fix-revalidation-final.md 为 ACCEPTED；复验对象 main@c2c0729（R6=4d0a38b 经 merge c2c0729 合入 main，R1–R6 全部 merged）；N28 设计/计划基线 commit 9f10082（docs-only）。本 lane 实现分支必须派生自包含 9f10082 的 main，且首条 commit 信息注明 Gate 0 已过。
> 车道：分支 lane/n28-t6-agent-working-set，worktree .worktrees/n28-t6，串行合并顺序 T1→T2→T3→T4→T5→T6→T7。

## 1. 目标

实现计划 Task 6「Make the Actual Agent Prompt, Skill Facade and Tool Executor Obey the Working Set」。让 agent-loop 实际收到的 prompt、Skill facade 与 Tool schema 三处都与本任务冻结的 Working Set 完全一致，集合外调用在执行器解析前被拒绝。本 lane 同时产出 H6 所需的最终 working-set snapshot（TaskOutcome usage/trace），供 Task 7 对账。

## 2. 上游接口（Consumes）

| 接口全名 | 来源文件 | 上游 Task |
|---|---|---|
| `TaskLoop`（worker-stamped，含 `TaskDispatchContext.worker`） | `src/pth/bootstrap/task-loop.ts`、`src/pth/bootstrap/task-loop-types.ts` | T2 |
| `VerifiedTaskReadScopeFactory`（`forTask()` 单次 mint 授权） | `src/pth/execution/authorization/verified-task-read-scope.ts` | T4 |
| layered `KnowledgeContextProvider` 输出（`retrievalTrace`、entries） | `src/pth/runner/knowledge-context.ts` | T4 |
| `ToolRegSnapshot`（`loadToolRegSnapshot` / `visibleRegistryTools`） | `src/pth/kernel/execution/tool-registry.ts` | 既有（N14 快照读取口，经 T2 TaskLoop 透传） |
| `TaskWorkingSetPolicy` | `src/pth/contracts/cognitive-responsibility.ts` | T1（T5 实例化） |
| `CognitiveBudgetLedger` | `src/pth/kernel/execution/cognitive-budget.ts` | T5 |
| `AuthorizedTaskReadFactory` / `AuthorizedTaskReads` | `src/pth/runner/authorized-task-reads.ts` | T5 |
| budgeted capabilities（`createBudgetedTaskCapabilities`） | `src/pth/runner/cognitive-working-set.ts` | T5 |

## 3. 实施范围

| 文件（Create/Modify） | 改动 |
|---|---|
| Modify: `src/pth/kernel/execution/agent-loop-types.ts` | `AgentLoopOptions` 增可选 `toolAllowlist?: readonly string[]`，作为冻结任务工具面 |
| Modify: `src/pth/kernel/execution/agent-loop.ts` | 用 `normalizeToolName()` 归一 allowlist，在 schema 过滤、system prompt、执行器解析前三处同时生效；固定拒绝文案并返回 `undefined` |
| Modify: `src/pth/kernel/execution/agent-loop-prompt.ts` | 导出 `taskToolUnion()`；`buildAgentSystemPrompt()` / `toolsDescription()` 只派生自同一冻结 union；移除固定工具清单及 `dev.run` 等集合外名字；role-doc 查询选 `id, ..., meta` |
| Modify: `src/pth/kernel/execution/agent-loop-guards.ts` | environment prelude / guard 更新 role-doc 投影与 Working Set 约束文本 |
| Modify: `src/pth/runner/cognitive-working-set.ts` | 定义并实现 `CognitiveWorkingSetProvider` / `createCognitiveWorkingSetProvider`；Skill 评分文本与计费投影分离；工具名归一、pinned 先计数、admitted 摘要深冻结并返回预算化 capabilities |
| Modify: `src/pth/runner/authorized-task-reads.ts` | 提供 provider 消费的 `AuthorizedTaskReads` 接入（`listSkills` 只读一次等） |
| Modify: `src/pth/runner/knowledge-context.ts` | 导出 `contextPromptProjection()`，prompt 构建与预算计费共用同一投影 |
| Modify: `src/pth/runner/agent-task-runner.ts` | 注入 `memoryDirectory` / `cognitiveWorkingSetProvider` / `cognitiveResponsibilityMode` / `authorizedReads`；hoist ToolReg 快照；verified scope 每任务只 mint 一次；固定 Context → provider → ledger 顺序；输出 usage 与 cognitive-working-set trace |
| Modify: `src/pth/bootstrap/task-loop-types.ts` | `TaskLoopDeps` 增透传 `memoryDirectory` / provider / reads / verified scope / mode 等可选依赖 |
| Modify: `src/pth/bootstrap/task-loop.ts` | 将 replica 与上述依赖传给 `AgentTaskRunner` |
| Modify: `src/pth/bootstrap/worker-slot-runtime.ts` | 装配并透传可行性 provider 所需依赖到 runner |
| Modify: `src/pth/bootstrap/batch-runtime-assembly.ts` | 接收 `resolveRoleBudget` 等依赖；feasibility 模式启动前 `assertMemoryDirectoryResponsibilityCapacity`，过载即启动错误 |
| Modify: `src/pth/bootstrap/batch-process.ts` | feasibility 模式构造 provider；`RunBatchProcessDeps` 增可选依赖；正常 CLI 入口保持 undefined |
| Create: `scripts/tools/n28-feasibility-harness.ts` | 单一公共装配：`assembleBatchRuntime()` + 有限 `runBatchHost()` + 内存 adapters，PG-free；供 vertical 测试与 Task 7 复用 |
| Modify: `test/pth-runner/agent-task-runner.test.ts` | 覆盖 feasibility 结构化 rejected、off 模式不变、usage/trace、ToolReg hoist 后单次加载 |
| Modify: `test/pth-kernel-execution/agent-loop.test.ts` | 覆盖 allowlist 三处生效、`registry_omitted` / `registry.omitted` 双名归一、executor 零调用、别名只计一次 |
| Modify: `test/pth-kernel-execution/prompt-docs.test.ts` | 断言 prompt 不残留 `dev.run` 等冻结集合外名字 |
| Create: `test/pth-kernel-execution/agent-loop-working-set.integration.test.ts` | 不 mock `runAgentTask` 的真实 LLM 面集成测试：fake LLM 记录 messages 与 tools；断言 schema = frozen union ∩ 当前 ASP space face；拒绝路径与 trace |
| Create: `test/pth-runner/cognitive-responsibility.vertical.test.ts` | 生产 `assembleBatchRuntime` + 有限 `runBatchHost` 垂直测试；H6 用 final working-set snapshot 对账 prompt/facade/tool schemas |

## 4. 接口产出（Produces，冻结表）

| 接口全名 | 冻结语义 | 后续 Task 消费 |
|---|---|---|
| `CognitiveWorkingSetProvider`（`createCognitiveWorkingSetProvider()`，`src/pth/runner/cognitive-working-set.ts`） | `build()` 返回 `{ policy, ledger, capabilities }`；feasibility provider 解析可选 Role load policy 并与系统预算逐轴取 min；`loadPolicyRef` 无法解析时先于任何读取/LLM 调用失败；Skill 只经 `authorizedReads.listSkills` 读取（恰好一次），评分文本与计费投影分离；工具 schema 名归一为下划线，pinned `done` + ASP ambient union 先计数；admitted 摘要深冻结；返回 `createBudgetedTaskCapabilities(...)` | 本 Task 的 `AgentTaskRunner` 装配；Task 7 CLI/评估器经 harness 复用 |
| `AgentLoopOptions.toolAllowlist`（`src/pth/kernel/execution/agent-loop-types.ts`） | 冻结任务工具面（`readonly string[]`）；schema 暴露与执行授权使用同一 canonicalize 后的集合；ASP 每轮只暴露其与当前 space face 的交集；union 恒含 protocol-pinned `done` | agent-loop 内部三处（本 Task）；Task 7 H6 表面对账 |
| execution-time hidden-tool rejection（`src/pth/kernel/execution/agent-loop.ts`） | canonical name 不在 allowlist 时先于一切 executor 查找拒绝；文案固定 `tool ${tool} is outside the frozen Task Working Set`；`onStep`/`onTrace` 记 `ok:false` 并返回 `undefined`；不得依赖模型尊重广告 schema | Task 7 H6 hidden dispatch 计数器与 NO-GO 判定 |
| `TaskOutcome.usage` + `AgentTraceEvent type:"cognitive-working-set"` | usage 键名固定 `cognitive.*` 六键：`cognitive.memoryEntries`、`cognitive.memoryChars`、`cognitive.skillIndexEntries`、`cognitive.activeSkills`、`cognitive.skillChars`、`cognitive.tools`（计划 L2257 原文）；事件携带 immutable policy/snapshot IDs、精确 admitted ID/name 集、usage、omitted 计数与有序 `retrievalTraces`/trace IDs（不含 entry 正文与 Skill 内容）；首 LLM 前与 finish 各 emit 一次 | Task 7 评估器：H6 用 final trace snapshot 对账实测 prompt/facades/tool schemas |
| `taskToolUnion()`（`src/pth/kernel/execution/agent-loop-prompt.ts`） | ASP 开：快照 `meta` + 当前已注册空间，union `toolsForSpace(space, role.actionTools)`，canonicalize 名，恒含 pinned `done`；ASP 关：`toolsToSchema(...,{asp:false})` + `done` | 本 Task runner 装配 `staticToolNames` 与 prompt 构建 |
| `contextPromptProjection()`（`src/pth/runner/knowledge-context.ts`） | 精确包含 id、summary、evidence 与 exposed meta；prompt 构建与 budget 计费调用同一函数，禁止评测专用投影 | 本 Task prompt builder 与 ledger `canonicalExposureChars`；Task 7 对账 |

## 5. 关键步骤

冲突时以计划 Task 6 步骤为规范。

- **Step 1**：新增真实 LLM 面集成测试（不 mock `runAgentTask`）。构造确定性 fake LLM 记录每轮 `messages` 与 `options.tools`；ToolReg 注册超过 `maxTools`，冻结一个 admitted program，令 `registry.omitted` 成为首个 omitted program；ASP 模式脚本为隐藏 `registry_omitted` → `asp_cd(ts)` → `ts_run`（预算化 `memory.retrieve` / `skills.list/get` / `state.recall*`）→ `asp_cd(meta)` → `done`。Expected：每轮可见 schema 集等于 `frozen union ∩ 当前 ASP space face`；trace 出现 `registry.omitted` 拒绝且含固定文案；omitted executor 零调用；prompt 不出现 `registry.omitted`；`finalWorkingSet.toolNames.length <= 16`；outcome 为 `completed`。
- **Step 2**：在 `AgentLoopOptions` 增加 `toolAllowlist?: readonly string[]`。在 `agent-loop.ts` 中用 `normalizeToolName()` 归一并在三处同时生效：每轮 LLM 前过滤静态 + Role-visible ToolReg schema；将冻结任务 union 传入 `buildAgentSystemPrompt()` / `toolsDescription()`，prompt 不得命名集合外工具并移除 `dev.run` 等固定清单；在解析 `AGENT_TOOLS`、capability-action wrapper 或 ToolReg executor 之前拒绝 canonical name 不在 allowlist 的工具。Expected：拒绝文案固定 `tool ${tool} is outside the frozen Task Working Set`；`registry_omitted` 与 `registry.omitted` 归一为同一 policy 名、均被拒且 executor 计数为 0；别名在 `maxTools` 只计一次；union 恒计 protocol-pinned `done`。
- **Step 3**：在 `cognitive-working-set.ts` 定义 `CognitiveWorkingSetProvider` 接口与 `createCognitiveWorkingSetProvider(deps)`。feasibility provider 解析可选 Role load policy，逐轴与系统 budget 取 min；`loadPolicyRef` 存在但无 resolver 或匹配 policy 时在任何读取/LLM 前失败；`assembleBatchRuntime` 只接受泛型 `resolveRoleBudget`，不得 import `scripts/**`。Expected：未知 ref 负例中所有 backing-read 与 LLM spy 均为 0；Skill 只经 `authorizedReads.listSkills` 读取（恰好一次），评分用 `${id}\n${anchor}\n${whenToUse}\n${effect}`，计费用 `canonicalExposureChars(skillSummaryProjection(summary))`（含 `status` 的完整 `SkillSummary` 投影）；admitted 摘要深冻结；重复 `skills.list()` 零额外 backing reads。
- **Step 4**：将 provider 接入 `AgentTaskRunner` 而不改变默认路径。`AgentTaskRunnerDeps` 增可选 `memoryDirectory`、`cognitiveWorkingSetProvider`、`cognitiveResponsibilityMode`、`authorizedReads`；feasibility 模式下四者（连同 replica、verified-scope factory、read factory 与单次 grant-bound result）缺失即返回结构化 rejected outcome，不得静默退回 raw base reads；`off` 保留旧可选路径。Expected：ToolReg 快照 hoist 到 `runAgentTask()` 参数外；`verifiedReadScopeFactory.forTask()` 每任务恰好一次，同一冻结 `authorization` 以对象身份传入 Context 与 `authorizedReads.forTask()`；顺序固定为 Context → pending trace 校验 directorySnapshotId → provider → ledger `recordRetrievalTrace`；initial context 超限 truncate 且 `omitted.reason="cognitive-budget"`；feasibility 下 Context `retrieval-failed`/`retrieval-incomplete` 走 structured rejected，不得进 legacy “warn + original text” 分支；`off` 完全不动。任务完成时 `TaskOutcome.usage` 使用 `cognitive.*` 键，`AgentTraceEvent` 增 `type:"cognitive-working-set"`。
- **Step 5**：将 replica 与 provider 依赖穿透 `TaskLoop` 与 batch assembly。`TaskLoopDeps` 增可选依赖；`batch-process.ts` 在 feasibility 模式构造 provider；`RunBatchProcessDeps` 增可选依赖且正常 CLI 入口保持 undefined。Expected：缺失 Directory 或 read factory 是 startup/first-task error 而非省略 provider；`off` 保持旧检索/能力行为；feasibility 模式启动 slot 前调用 `assertMemoryDirectoryResponsibilityCapacity`，过载即 startup error；in-memory gate 不调用长时 PG 依赖的 `runBatchProcess()`，而是经 `scripts/tools/n28-feasibility-harness.ts` 调用 `assembleBatchRuntime()` + 有限 `runBatchHost()`，执行生产组合。
- **Step 6**：构建垂直集成测试。四个注入 `workerSpecs` 携带冻结 `N28_ROLE` 与四个 fixture `WorkerReplica` refs（replica factory 注入），一个 immutable directory（algebra/geometry primary + numerical overlap），冻结 `N28_ROLE_LOAD_POLICIES` resolver，真实 layered retriever、`createKnowledgeContextProvider()`、生产 `assembleBatchRuntime` + 有限 `runBatchHost`、真实 TaskLoop/archive wrapper、`AgentTaskRunner` 与 `runAgentTask()`、真实预算化 capability wrapper，仅模型输出用确定性 fake LLM。Expected：algebra/geometry/global 三任务均 `completed`；各任务 prompt 含对应 `alg-01` / `geo-01`；`toolNames.length <= 16`；`globalTrace.globalFallback === true`；无 `trap-*` 返回；`actualSchemaSetByTurn`、`actualSkillSummaries`、`actualWorkingSet` 与期望冻结快照逐项相等；pause algebra 后 geometry 仍可运行。
- **Step 7**：运行真实表面聚焦套件。Expected：PASS；same-space、Role-visible 但预算 omitted 的 `registry.omitted` 尝试在 otherwise valid executor 被调用前由新 Working Set guard 拒绝。
- **Step 8**：提交真实 agent 集成。`git add` 计划列出的全部 §3 文件，单条 commit `feat(pth): enforce cognitive working set in agent runtime`。

## 6. 设计裁决与红线

1. **H6 直通 agent 面**：stub LLM 实际看到的 memory 摘要、Skill facade、tool schemas 必须与冻结 Working Set 完全一致；预算器只出报告而 agent 仍可见/可调全量 Skill/Tool/Memory 即 No-Go。
2. **三处同源**：`toolAllowlist` 在 schema 过滤、system prompt、执行器解析前同时生效，且使用同一 `normalizeToolName()` 归一后的集合。
3. **固定拒绝文案**：拒绝文案固定为 `tool ${tool} is outside the frozen Task Working Set`；allowlist 检查必须在所有 executor 查找之前，不得依赖模型尊重广告 schema。
4. **隐藏工具双名归一**：`registry_omitted` 与 `registry.omitted` 都归一到一个 policy 名；两者均被拒且 executor 零调用；别名在 `maxTools` 只计一次。
5. **ToolReg 快照 hoist**：`loadToolRegSnapshot` 在 `runAgentTask()` 参数外执行，provider 与 agent-loop 共用同一份冻结快照；删除旧的内联二次加载，任务运行中不得观察到不同 registry 版本。
6. **ASP 每轮暴露面**：可见 schema 集 = `frozen union ∩ 当前 ASP space face`；当前 space face = `toolsForSpace()` 静态 schema + Role-visible ToolReg schema（ToolReg 今日无 space 字段）；union 恒计 protocol-pinned `done`（即使 `done` 只在 `meta` 可用）。
7. **prompt 不得残留集合外名字**：`buildAgentSystemPrompt()` / `toolsDescription()` 文本派生自同一冻结 union，替换 `PTH_WORKER_SYSTEM` 固定工具清单；`dev.run` 等冻结集合外名字不得出现在 worldview/examples。
8. **verified scope 每任务只 mint 一次**：`verifiedReadScopeFactory.forTask()` 在 Context/provider 前恰好调用一次，同一冻结 `authorization` 以对象身份传入 `KnowledgeContextProvider.build()` 与 `authorizedReads.forTask()`；vertical test 以对象身份比较。
9. **Context 与 ledger 顺序**：先建 Context 并校验 pending trace 指向注入的 `MemoryDirectory` snapshot，再以该确切 `directorySnapshotId` 建 provider，然后 `recordRetrievalTrace` 先入 ledger 再 `admitMemory`；初始 context 超限 truncate 且 `omitted.reason="cognitive-budget"`；不得用 Domain Catalog `catalogVersion` 或硬编码 ID 替代。
10. **feasibility / off 分流**：feasibility 模式下 Context `retrieval-failed`/`retrieval-incomplete` 必须 structured rejected，不得进 legacy 降级分支；`off` 模式完全不动。实验预算数值照抄设计：`maxRegions=3`、`maxPrimaryWeight=80`、`maxSecondaryWeight=40`、`maxMemoryEntries=8`、`maxMemoryChars=4096`、`maxSkillIndexEntries=8`、`maxActiveSkills=4`、`maxSkillChars=8192`、`maxTools=16`。vertical test 必须走生产 `assembleBatchRuntime` + `runBatchHost`，不得 mock `runAgentTask`；stub 只替代模型输出，不替代运行路径、授权检查、预算器或 agent 暴露面。

## 7. 非目标

- 不建 PG Region/Responsibility/membership 表，不做任务或记忆 schema 迁移；Task routing 与 TaskLease CAS 仍以 role 为基准。
- 不把实验阈值宣布为生产配置默认值；不做自动 Region 拆分/合并、Role 自动分化、autoscaling、embeddings 或真实语义检索精度优化。
- 不修改 N26 Source/Intake/Verification/Promotion 状态机，不弱化任何 N27 已验收契约、不变量或回归测试。
- in-memory gate 不调用长时 PG 依赖的 `runBatchProcess()`；只走 `assembleBatchRuntime()` + 有限 `runBatchHost()`。
- `off` 模式保留旧检索/能力行为，不引入任何 Working Set 路径。
- 本 lane 不更新 README 徽章/测试总数（合并回 main 时更新）。

## 8. 验收标准

### 8.1 定向测试

计划本 Task 的 Run 命令（vitest/tsc）如下：

```bash
npx vitest run test/pth-runner/agent-task-runner.test.ts test/pth-kernel-execution/agent-loop.test.ts test/pth-kernel-execution/prompt-docs.test.ts test/pth-kernel-execution/agent-loop-ptc.integration.test.ts test/pth-kernel-execution/agent-loop-working-set.integration.test.ts test/pth-kernel-execution/task-loop.test.ts test/pth-runner/cognitive-responsibility.vertical.test.ts
```

Expected：PASS。关键断言点：

- same-space、Role-visible 但 budget-omitted 的 `registry.omitted` 尝试在 otherwise valid executor 被调用前由新 Working Set guard 拒绝；
- 每轮可见 schema 集等于 `frozen union ∩ 当前 ASP space face`；
- trace 含 `{ type: "tool-result", tool: "registry.omitted", ok: false, resultPreview: 含 "outside the frozen Task Working Set" }`；
- omitted registry executor 零调用；任何轮次的广告 tools 均不含 `registry_omitted`；system prompt 不含 `registry.omitted`；
- `finalWorkingSet.toolNames.length <= 16`；`outcome.status === "completed"`；
- vertical：algebra/geometry/global 三任务 `completed`；prompt 含对应 `alg-01`/`geo-01`；`toolNames.length <= 16`；`globalTrace.globalFallback === true`；无 `trap-*`；`actualSchemaSetByTurn` / `actualSkillSummaries` / `actualWorkingSet` 与期望冻结快照相等；pause algebra 后 geometry 仍可运行。

### 8.2 关闭条件对账表

| 关闭条件 | 证据要求 |
|---|---|
| H6：工作集真实进入 agent 面，集合外调用被拒绝 | `agent-loop-working-set.integration.test.ts` 的 schema 逐轮对账、`registry.omitted` 拒绝 trace、executor 零调用；`cognitive-responsibility.vertical.test.ts` 中 final working-set snapshot 与实测 prompt/facade/tool schemas 一致 |
| `toolAllowlist` 在 schema 过滤、system prompt、执行器解析前三处同时生效 | `agent-loop.test.ts` 三处路径断言：每轮广告 tools ⊆ allowlist；system prompt 不含集合外名字；执行器解析前拒绝且 executor 零调用 |
| 拒绝文案固定 | 断言原文 `tool ${tool} is outside the frozen Task Working Set` |
| ToolReg 快照 hoist 后 provider 与 agent-loop 共用同一份 | runner/integration 断言 `loadToolRegSnapshot` 单次调用，provider 与 agent-loop 接收同一快照对象（或同一 snapshot ID） |
| verified scope 每任务只 mint 一次并以对象身份比较 | vertical/runner 断言 `forTask()` 调用计数为 1，`KnowledgeContextProvider.build()` 与 `authorizedReads.forTask()` 收到同一 `authorization` 对象 |
| Context pending trace 先入 ledger 再 admit，初始 context 超限 truncate 且 `omitted.reason=cognitive-budget` | runner 测试对 ledger 方法调用顺序断言；超限 fixture 断言 `omitted.reason === "cognitive-budget"` |
| feasibility 模式下 Context `retrieval-failed`/`retrieval-incomplete` 必须 structured rejected，不得进 legacy 降级分支 | `agent-task-runner.test.ts` 对两个 Context 状态各断言 rejected outcome，且 legacy 降级 spy 零调用 |
| `off` 模式完全不动 | 现有/新增 runner 测试断言 `off` 下不注入 provider、不触发 Working Set 路径，旧行为不变 |
| usage 键名固定 `cognitive.*` 六键（六轴与 §4 枚举一致） | `TaskOutcome.usage` 字段白名单断言（runner/vertical 测试） |
| vertical test 必须走生产 `assembleBatchRuntime`+`runBatchHost`，不得 mock `runAgentTask` | `cognitive-responsibility.vertical.test.ts` 直接调用生产导出；禁止 `vi.mock(".../agent-task-runner")`；harness 由 `assembleBatchRuntime()` 组装 |
| prompt 中不得残留 `dev.run` 等冻结集合外名字；隐藏工具双名 `registry_omitted` 与 `registry.omitted` 都归一到一个 policy 名且 executor 零调用 | `prompt-docs.test.ts` 与 `agent-loop.test.ts` 断言 |
| ASP 模式取法按现状（`pthConfig` 字符串比较）适配计划 `aspMode` 表述 | `agent-loop.test.ts` / prompt-docs 覆盖 ASP 开/关两路径，确认读取的是现状 `pthConfig` 字符串比较 |
| 全量回归：`npx vitest run` 全绿（既有 9 skip 基线不变）+ `npm run lint` 全绿 | 合并者合并前执行并留存命令输出 |
| 真实 PG 环境不可用 | 按 `EVALUATION-INCOMPLETE` 记录，不得冒充通过 |

> 特别注意（冻结红线，必须逐条成立）：`toolAllowlist` 在 schema 过滤、system prompt、执行器解析前三处同时生效；拒绝文案固定为 `tool X is outside the frozen Task Working Set`；ToolReg 快照 hoist 后 provider 与 agent-loop 共用同一份；verified scope 每任务只 mint 一次并以对象身份比较；Context pending trace 先入 ledger 再 admit，初始 context 超限 truncate 且 `omitted.reason=cognitive-budget`；feasibility 模式下 Context retrieval-failed/incomplete 必须 structured rejected，不得进 legacy 降级分支；off 模式完全不动。usage 键名固定 `cognitive.*` 六键（与 §4 枚举一致）。vertical test 必须走生产 `assembleBatchRuntime`+`runBatchHost`，不得 mock `runAgentTask`。注意实现时按现状把 ASP 模式取法（`pthConfig` 字符串比较）适配到计划中的 `aspMode` 表述。合并者额外 review：prompt 中不得残留 `dev.run` 等冻结集合外名字；隐藏工具双名 `registry_omitted` 与 `registry.omitted` 都归一到一个 policy 名且 executor 零调用。

### 8.3 全量门槛

合并者合并前：`npx vitest run` 全绿（既有 9 skip 基线不变）+ `npm run lint` 全绿；真实 PG 环境不可用按 `EVALUATION-INCOMPLETE` 记录，不得冒充通过。

## 9. merge 前合并者检查清单

1. **三处同源对抗检查**：分别审阅 schema 过滤、system prompt、执行器解析前三条路径，确认都消费同一 canonicalize 后的 `toolAllowlist`；用 `prompt-docs.test.ts` 与 grep 确认 prompt 无 `dev.run` 等冻结集合外名字。
2. **双名归一对抗检查**：以 `registry_omitted` 与 `registry.omitted` 各调用一次同一 ToolReg program，断言二者归一为同一 policy 名、返回同一固定拒绝文案、ToolReg executor 调用计数为 0，且 `maxTools` 中别名只计一次。
3. **快照与 scope 顺序对抗检查**：确认 `loadToolRegSnapshot` 只在 `runAgentTask()` 参数外执行一次且旧 inline 二次加载已删除；`verifiedReadScopeFactory.forTask()` 每任务恰好一次，同一 `authorization` 以对象身份进入 Context 与 `authorizedReads`；pending trace 先 `recordRetrievalTrace` 再 `admitMemory`。
4. **feasibility/off 分流对抗检查**：feasibility 下 Context `retrieval-failed`/`retrieval-incomplete` 必须走到 structured rejected，legacy 降级 spy 零调用；初始 context 超限 truncate 且 `omitted.reason="cognitive-budget"`；`off` 模式无 provider 注入、无新行为。
5. **vertical 真实性对抗检查**：确认 `cognitive-responsibility.vertical.test.ts` 走生产 `assembleBatchRuntime`+`runBatchHost`，未 mock `runAgentTask`；`TaskOutcome.usage` 只含 `cognitive.*` 六键（§4 枚举）；ASP 模式取法为现状 `pthConfig` 字符串比较并已适配计划 `aspMode` 表述。

## 10. 偏差纪律

- lane 内只动 §3 文件域；如需触及其他文件，先停 lane 报告用户裁决。
- 发现计划缺陷/步骤不可执行：停下报告，不自行改计划。
- README 徽章/测试总数只在合并回 main 时更新。
- 每 lane 一条 commit（focus 测试 + 契约内文件域）；偏差必须写进 commit body。
- 实现期不得弱化任何 N27 已验收契约、不变量或回归测试。
