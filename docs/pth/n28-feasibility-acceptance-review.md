# N28 可行性验收复核报告（ROLE/MEMORY/WORKER 编排）

> - 日期：2026-08-19
> - 复核对象：`main@7525c7f768c652dfc506a10763915abd8bb3af0c`
> - 验收范围：N28 T1–T7（Role / Worker / Memory 编排可行性切片；`318e3ad..7525c7f`，72 files，`+14608/-117`）
> - 设计：[n28-role-memory-orchestration-design.md](./n28-role-memory-orchestration-design.md)
> - 实施计划：[n28-role-memory-orchestration-implementation-plan.md](./n28-role-memory-orchestration-implementation-plan.md)
> - 历史报告：[n28-feasibility-report.md](./n28-feasibility-report.md)

## 1. 验收结论

**NOT ACCEPTED / NO-GO。**

这里区分两种状态：当前 HEAD 的自动 acceptance driver 因环境预检和驱动逻辑返回
**EVALUATION-INCOMPLETE**；本报告依据已复现的直接阻断与生产路径审查，给出的独立验收处置是
**NOT ACCEPTED / NO-GO**。前者不是 GO，也不会覆盖后者。

T1–T7 的主要契约、Directory、分层检索、预算账本、WorkerReplica、agent 工具面和评估骨架已经合入；
但本轮独立复核发现：

1. `state.recallFunctions` / `state.recallInsights` 存在可复现的硬预算绕过；
2. 标准 batch CLI 没有注入 feasibility 依赖；即使补齐依赖，现有装配也不会生成 `AgentTaskRunner` 强制要求的分层检索 trace；
3. Knowledge Context 没有复用 Broker 的同一 wave port，授权、过滤与 trace 计数可能漂移；
4. H1/H2/H4/H6 的关键验收指标仍为空或硬编码，评估器没有完成计划要求的探针和破坏性验证；
5. worker 实例控制、子 agent 身份和最终 acceptance driver 仍有生产路径缺口。

因此，当前实现可以继续作为关闭默认开关的实验切片，但不能证明“固定单 Worker 负载上限、重叠记忆责任区、
分层兜底检索、严格授权和真实 agent 工作集”已经端到端可行。不得据此进入生产自动扩容、持久责任分配或默认开启。

## 2. 验收范围与口径

本报告只验收最近合入的 N28 Role / Worker / Memory 编排方案，不包含 Human Interface 迁移或 Autonomous
Knowledge Intake 的后续设计。

验收采用以下口径：

- **代码事实优先**：以当前 `HEAD` 的生产装配和运行路径为准，不以测试 harness 代替生产路径；
- **暴露面优先**：预算以实际返回给 agent 的内容为准，而不是只看账本计数；
- **同源端口优先**：Broker、Context 和 capability facade 应共享授权与检索实现；
- **非空分母**：要求执行的探针未运行时不得判 PASS；
- **当前提交证据**：旧提交上的测试数字不能外推为当前 `HEAD` 的最终验收结果；
- **环境失败不洗白**：已启动门禁的失败不得被其他环境不可用改标为 `EVALUATION-INCOMPLETE`。

## 3. 阻断问题

### P0-1：State recall 可绕过统一认知预算

文件：[cognitive-working-set.ts](../../src/pth/runner/cognitive-working-set.ts) `:83-91`

`memory.retrieve` 和 `memory.query` 会根据 `ledger.admitMemory(...).accepted` 过滤返回结果，
但 `state.recallFunctions` 与 `state.recallInsights` 只调用账本、忽略 admission 结果，随后返回全部 rows。

本轮最小复现：

```json
{
  "budget.maxMemoryEntries": 1,
  "returned": 2,
  "usage.memoryEntries": 1,
  "omittedCount": 1
}
```

即账本显示未超限，第二条记录也被标为 omitted，但它已经返回给 agent。该缺陷直接违反 H5 的硬上限，
所以历史报告中的 H5 PASS 不能接受。

此外，[authorized-state-reads.ts](../../src/pth/runner/authorized-state-reads.ts) `:48-56` 对调用方的
`opts.limit` 只做默认值处理，没有施加统一上限，会扩大该绕过的影响。

### P0-2：标准 batch feasibility 路径无法启动，补齐依赖后仍会自我拒绝

文件：

- [batch-process.ts](../../src/pth/bootstrap/batch-process.ts) `:173-178, 715-729`
- [agent-task-runner.ts](../../src/pth/runner/agent-task-runner.ts) `:205-213`

标准 batch CLI 在 [batch-process.ts](../../src/pth/bootstrap/batch-process.ts) `:825-843` 调用
`runBatchProcess()` 时没有注入 feasibility 所需的 Directory/read factories，因此显式打开模式会先在
`:227-235` 启动失败。即使由测试或后续 launcher 补齐这些依赖，生产 `runBatchProcess()` 构造的
`KnowledgeContextProvider` 仍只注入 `memory/catalog/isVisible`，会走 legacy 分支且不产生
`retrievalTrace`。同一 batch 又把该 provider 传给 `AgentTaskRunner`；runner 强制要求 trace 的
`directorySnapshotId` 与当前 MemoryDirectory 一致，否则返回 `cognitive-directory-trace-mismatch`。

绿色 vertical 测试使用的是专用 harness provider，并在
[n28-feasibility-harness.ts](../../scripts/n28-feasibility-harness.ts) `:153-222` 直接构造
`AgentTaskRunner`；它没有经过 `assembleBatchRuntime → runBatchHost → TaskLoop`。因此标准 batch CLI 尚不能
启用该模式，现有 vertical 也没有验证真实 batch 端到端链路。

### P0-3：T7 评估器没有执行完整验收实验

文件：[eval-n28-feasibility.ts](../../scripts/eval-n28-feasibility.ts) `:324-345, 459-515`

当前评估器存在以下空观测或常量结果：

- H1：`auditIdentityProbeCases=0`、`grantIdentityProbeCases=0`；
- H4：`authorizationProbeCases=0`，visibility 只执行到 10/14；
- H6：`surfaceComparisonCases=0`、`hiddenDispatchProbeCases=0`；
- H2：`ownerlessRegions=0`、`bodyCopiesOutsideCanonicalStore=0` 被直接赋常量，没有扫描
  Directory / Responsibility / WorkingSet 根；
- H3：gold probe 在 `:250-300` 自建 Directory/retriever 并内联另一套 `searchWave`，没有调用生产
  Broker、Context 或共享 vertical harness；它只断言 expected entry 最终出现且执行了 0–3 四波，
  没有校验 fixture 声明的 `expectedWave`；
- 未实现计划要求的六类真实组件 sabotage/mutation 探针。

评估器当前输出 NO-GO 是 fail-closed 的正确结果；但它只能说明“验证尚未完成”，不能证明某一假设已经通过。
尤其不能根据常量零值接受 H2，也不能只根据账本生成测试接受 H5。

## 4. 高优先级生产路径缺口

### P1-1：Context 绕过注入的分层检索端口

文件：[knowledge-context.ts](../../src/pth/runner/knowledge-context.ts) `:194-233`

layered 分支检查了 `deps.layeredSearchWave` 是否存在，却没有调用它，而是内联实现另一套
`memory.retrieve → visibility filter → region filter → rank`。Broker 则使用真正注入的 wave port。

后果：

- Broker 与 Context 的授权、过滤和查询语义可能漂移；
- wave port 上的审计、计量和 fail-closed 逻辑无法约束 Context；
- `candidateCount` / `visibleCount` 被记录为 backing retrieve 返回集的数量，没有按当前 regionSet/wave 收窄，
  H3/H4 trace 不能作为诚实证据。

### P1-2：同 Role WorkerReplica 尚不能通过生产 API 独立控制

文件：

- [routes-kernel.ts](../../src/pth/gateway/routes-kernel.ts) `:414-429`
- [pth-gateway-facade.ts](../../src/pth/application/gateway/pth-gateway-facade.ts) `:268-272`
- [batch-process.ts](../../src/pth/bootstrap/batch-process.ts) `:288-316`

对外控制协议仍只接受 `role`，facade 只调用 role 级 `pauseWorker/resumeWorker/removeWorker`，没有暴露
`workerId` 或 replica 级方法。在 feasibility 模式，role 级 remove 虽展开成逐实例 remove，却不发送 role 级
`removed` 最终回执；`BatchManager.removeWorker()` 会等待 5 秒后返回失败。

因此 H1 所要求的“同 Role 副本可独立寻址和控制”尚未进入生产端口。

### P1-3：子 agent 仍使用 Role 派生的伪 Worker 身份

文件：[batch-process.ts](../../src/pth/bootstrap/batch-process.ts) `:493-505, 543-555`

穿透/child-agent 路径使用 `principalId=worker:<childRoleId>`，且直接调用 `runAgentTask()`，没有传递
真实 `WorkerReplicaRef`。这会让 grant/capability/audit 链在该路径退化为 Role 身份，无法证明 H1 的
Worker UUID 已端到端贯通。

### P1-4：Acceptance driver 会产生错误的门禁状态

文件：[accept-n28-feasibility.ts](../../scripts/accept-n28-feasibility.ts) `:88-107, 139-179`

- 纯内存 focused suite 被错误绑定到 PostgreSQL preflight；PostgreSQL 不可用时，focused 根本不会启动；
- focused 成功后直接把 `skipped=[]`，没有解析 JSON 报告确认零 skip；
- 只要任一 gate unavailable，已启动 gate 的非零退出也会被整体改标为 `EVALUATION-INCOMPLETE`；
- Redis preflight 固定调用默认 `redis-cli ping`，没有使用项目配置的 endpoint；
- command gate 不保留 stdout/stderr，失败证据不可追溯。

本轮在当前环境实跑的 authority driver 返回 `EVALUATION-INCOMPLETE`，而不是历史报告记录的最终 NO-GO
envelope；这两者应明确区分。

### P1-5：N28 类型门禁缩窄且历史报告未绑定当前 HEAD

- [tsconfig.n28.json（旧仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/tsconfig.n28.json) `:14-22` 只包含 4 个 scripts 和 3 个测试文件，
  没有覆盖计划列出的 31 个 focused 测试文件；
- [n28-feasibility-report.md](./n28-feasibility-report.md) `:4, 71` 绑定的是旧提交
  `5e6a588d88c20d6628105b1cdd6afee6bee6dea4`，当前 HEAD 为 `7525c7f...`。

因此 `n28Typecheck exit 0` 只能证明这 7 个文件通过类型检查；旧报告中的全量绿色数字也不能作为当前
HEAD 的新鲜证据。

## 5. H1–H6 独立复核矩阵

| 假设 | 结论 | 复核说明 |
|---|---|---|
| **H1 Role / Worker 可分离** | **FAIL** | WorkerReplica、slot runtime 局部测试通过；但生产 API 不能按 workerId 控制，role remove 缺最终回执，child-agent identity 仍按 role 派生，audit/grant 探针为 0/3、0/3。 |
| **H2 重叠责任区不复制正文** | **INCONCLUSIVE** | Directory 单元与确定性测试未发现具体实现缺陷；但评估器将 body-copy/ownerless 结果硬编码为 0，且没有按计划扫描 Directory、Responsibility、WorkingSet 三类根，不能判 PASS。 |
| **H3 错误绑定不会导致不可达** | **FAIL（端到端）** | evaluator 自建 retriever/wave 的 12/12 gold 通过；但它没有调用生产 Broker/Context，共享 vertical 又绕过 batch/TaskLoop。标准 batch 无 feasibility 依赖，补齐依赖后 Context 仍无 layered trace；Context 也未复用 Broker wave port。 |
| **H4 fallback 不改变授权边界** | **FAIL** | 32 个授权矩阵探针未运行，visibility 仅 10/14；Context 自建检索闭包扩大了 Broker/Context 语义漂移风险。 |
| **H5 统一预算提供硬上限** | **FAIL** | CognitiveBudgetLedger 的 1,000 组生成测试通过，但 state recall 实际返回 omitted rows，存在已复现的真实暴露面绕过。 |
| **H6 Working Set 真实进入 agent 面** | **FAIL（组合验收）** | Agent loop 的 schema/prompt allowlist 和 hidden executor 局部测试存在正向证据；但 12/12 surface、1/1 hidden-dispatch 指标未接入，真实 batch 又在 agent 前自拒绝。 |

## 6. 新鲜验证证据

以下命令均在 `main@7525c7f768c652dfc506a10763915abd8bb3af0c`、clean worktree 上重新执行：

| 验证 | 结果 | 可证明范围 |
|---|---|---|
| `npx tsc -p tsconfig.n28.json --noEmit` | **exit 0** | 仅证明 `tsconfig.n28.json` 当前列出的 7 个文件 |
| N28 focused 31 文件 | **31 files / 267 tests passed / 0 skipped** | 局部契约、runner、retriever、预算与 harness 回归 |
| `npm run lint` | **exit 0** | tsc、PTH boundaries 0、PTH config 0；沙箱内首次受 `tsx` IPC `EPERM`，在允许环境重跑通过 |
| evaluator 连跑两次 | **byte-identical；均 exit 1 / NO-GO** | H2/H3/H5 被 evaluator 标 PASS；H1/H4/H6 因分母不足 FAIL；本报告按生产路径复核将 H2 改为 INCONCLUSIVE、H3/H5 改为 FAIL |
| acceptance driver | **exit 2 / EVALUATION-INCOMPLETE** | PostgreSQL/Redis preflight 不可用；focused/full 未启动；typecheck exit 0；driver 内 lint 因沙箱 `tsx` IPC 为 exit 1，而允许环境单独重跑 lint 为 exit 0 |
| `npm test` | **未得到可用终态** | 当前环境受 Redis、sandbox/CLI 等集成条件影响；运行至约 156 秒时已有失败并持续重试，人工终止，不作为 N28 代码归因或绿色证据 |
| `git diff --check` / `git status --short` | **exit 0 / clean** | 验收取证结束时未修改实现代码；本报告落盘后仅有预期文档改动 |

预算绕过另以只读运行时探针复现：`maxMemoryEntries=1` 时 state recall 返回 2 条，而 ledger 只计 1 条并
将另一条记为 omitted。

## 7. 已确认的正向基础

以下成果可以保留，不需要推倒重来：

- RoleDefinition 与 WorkerReplicaRef 已形成独立契约；
- WorkerSlotRuntime 的 pause/resume/draining/idle remove 基本状态机已有局部测试；
- MemoryDirectory 的 snapshot、membership、overlap 与四类 MemoryType 已形成可测试模型；
- LayeredKnowledgeRetriever 的四波搜索与 strict query filtering 已有确定性 fixture；
- VerifiedTaskReadScope 对 tenant、worker、lease/grant deadline 的绑定方向正确；
- CognitiveBudgetLedger 的六轴计量和 skill/tool 冻结策略已有生成式测试；
- Agent loop 已有冻结工具面、prompt/schema 同源和 hidden executor 拒绝的局部证据；
- feature flag 默认关闭，focused 中显式的 legacy off-mode 回归通过。

上述正向基础说明方案仍值得修复并继续验证，但它们不能抵消 P0 阻断项。

## 8. 修复顺序

### 第一层：恢复硬安全不变量

1. State recall 只返回 `ledger.admitMemory(...).accepted` 对应的 rows；
2. 对 state `limit` 做服务器端归一和硬上限；
3. 增加 summary/full expansion、超条目、超字符和不同顺序的回归测试；
4. 确认所有 Memory/Skill/State/Knowledge 间接读取都消费同一账本。

### 第二层：打通真实生产组合路径

1. 由生产 batch 构造并注入同一 `layeredRetriever + layeredSearchWave`；
2. Broker 与 Context 直接调用同一 wave port，不复制过滤/授权逻辑；
3. trace 按每个 wave 的真实 candidate/visible/selected/scanned 数量生成；
4. 用真实 `assembleBatchRuntime → TaskLoop → AgentTaskRunner` 完成至少一个有限生命周期任务。

### 第三层：补齐 Worker 身份与控制面

1. API/facade 增加 workerId 级 pause/resume/remove；
2. role 批量操作聚合并发送单一确定性最终回执；
3. child-agent 获得真实 WorkerReplicaRef，grant/capability/audit 统一使用 `worker:<uuid>`；
4. 增加同 Role 两副本的 API、heartbeat、audit、grant 和 child-agent 组合测试。

### 第四层：修复评估与最终门禁

1. 实现 H1 audit/grant、H4 32+14、H6 12+1 的真实探针；
2. 实现 H2 三类根的正文复制扫描和 ownerless region 检测；
3. 增加六类 sabotage/mutation 测试，确认每个探针能发现对应缺陷；
4. focused 不依赖 PostgreSQL；所有 started gate 的失败优先判 NO-GO；
5. 解析 focused/full JSON skip manifest，并保留每条 command stdout/stderr；
6. 恢复计划逐字要求的 4 个 scripts + 31 个 tests（共 35 files）类型覆盖，或先正式修订 Task 7 契约后再改变门禁；
7. 在同一 clean commit 上重跑 evaluator 两次、focused、typecheck、full regression、lint，生成新的 acceptance envelope。

## 9. 重新验收条件

重新验收必须同时满足：

1. P0-1 预算绕过有红→绿回归测试，实际返回集合与 ledger accepted 集合一致；
2. 真实 batch feasibility 任务 completed，且 Context/Broker trace 绑定同一 Directory snapshot；
3. 同 Role WorkerReplica 可通过生产端口按 workerId 独立控制；
4. grant、capability、audit 和 child-agent 均记录真实 worker UUID；
5. H1–H6 全部具有非空、精确分母，六类 sabotage 均能把对应假设变为 FAIL；
6. evaluator 连跑两次字节一致且为 GO；
7. focused 31 文件零 skip、N28 类型覆盖符合契约、full regression 和 lint 均 exit 0；
8. 最终报告绑定实际 evaluated HEAD，工作树 clean，门禁输出可追溯。

在以上条件全部满足前，本报告的独立复核处置保持 **NOT ACCEPTED / NO-GO**；当前自动 acceptance envelope
仍为 **EVALUATION-INCOMPLETE**。修复后必须重跑并生成绑定新 evaluated HEAD 的权威 envelope。
