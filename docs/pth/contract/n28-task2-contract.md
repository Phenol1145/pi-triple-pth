# N28-T2 契约：同角色 WorkerReplica 独立运行时身份与控制

> 对应实施计划 Task 2（docs/pth/plan/n28-role-memory-orchestration-implementation-plan.md L237–L634）；验证假设：H1：Role/Worker 可分离、独立控制、busy-remove 干净收尾
> 上游依赖：T1（cognitive-responsibility 契约：WorkerReplicaRef）
> Gate 0 记录：N27 最终复验报告 docs/pth/report/v1.2-acceptance-fix-revalidation-final.md 为 ACCEPTED；复验对象 main@c2c0729（R6=4d0a38b 经 merge c2c0729 合入 main，R1–R6 全部 merged）；N28 设计/计划基线 commit 9f10082（docs-only）。本 lane 实现分支必须派生自包含 9f10082 的 main，且首条 commit 信息注明 Gate 0 已过。
> 车道：分支 lane/n28-t2-worker-replica-identity，worktree .worktrees/n28-t2，串行合并顺序 T1→T2→T3→T4→T5→T6→T7。

## 1. 目标

为同一 Role 的多个 WorkerReplica 建立独立运行时身份：同角色副本拥有不同 `workerId`、相同 role ref，并可通过共享 `WorkerSlotRuntime` 独立 pause/resume/remove（含 busy-remove 干净收尾）。在 batch、TaskLoop、heartbeat、audit、grant 与 capability 全链路传播 worker 身份，同时保持 off 模式旧行为逐字节兼容。验证 H1：Role/Worker 可分离、独立控制、busy-remove 干净收尾。

## 2. 上游接口（Consumes）

| 接口全名 | 来源文件 | 上游 Task |
|---|---|---|
| `WorkerReplicaRef` | `src/pth/contracts/cognitive-responsibility.ts` | T1 |
| `RoleDefinition`（含 `WorkerRole` 兼容别名） | `src/pth/kernel/execution/worker-cluster.ts` | T1 |
| 现有 `TaskLoop` / `TaskLoopDeps` / `TaskDispatchContext` | `src/pth/bootstrap/task-loop.ts`、`src/pth/bootstrap/task-loop-types.ts` | 既有（N27 已验收运行时；本 lane 仅按计划扩展） |
| batch IPC（role-bulk heartbeat/control 消息形状） | `src/pth/bootstrap/batch-process.ts`、`src/pth/kernel/execution/batch-manager.ts` | 既有（N27 已验收运行时；本 lane 仅按计划扩展） |
| Execution Grant identity（现有 task/sandbox principal 形状） | `src/pth/bootstrap/task-loop.ts`、`src/pth/impls/kernels/capability.ts` | 既有（N27 已验收运行时；本 lane 仅按计划扩展） |

## 3. 实施范围

| 文件（逐字照抄计划 Task 2 Files 列表） | 改动 |
|---|---|
| Create: `src/pth/kernel/execution/worker-replica.ts` | 新增 `WorkerReplica` 状态机（idle/busy/paused/draining/stopped）、`createWorkerReplica()`、`roleDefinitionRevision()`；`ref` 冻结且 `role` 子冻结（Step 1/3） |
| Modify: `src/pth/contracts/tasking.ts` | `TaskDispatchContext` 增加可选 `worker?: WorkerReplicaRef`；从本地 contract 模块导入 `WorkerReplicaRef`（Step 4） |
| Modify: `src/pth/config/schema.ts` | 新增 `PTH_BATCH_ID`（string，默认 `""`）与 `PTH_COGNITIVE_RESPONSIBILITY_MODE`（`off\|feasibility`，默认 `off`）（Step 5） |
| Modify: `docs/pth/configuration.md` | 记录两个新配置键及 off 默认语义（Step 5） |
| Modify: `test/pth-config/config.test.ts` | 覆盖两个新配置键的默认值与枚举/字符串校验（Step 9 运行清单） |
| Modify: `src/pth/bootstrap/task-loop-types.ts` | `TaskLoopDeps` 增加可选 `replica?: import("../kernel/execution/worker-replica.js").WorkerReplica`（Step 4） |
| Modify: `src/pth/bootstrap/task-loop.ts` | 仅当 replica 存在时 `startTask`/`finishTask`；`setTaskDispatchContext` 写 `worker`；activity/audit 增加 `workerId`；替换两处 per-task principal fallback 为 `worker:<workerId>`，保留 `roles:[role.id]`、`roleId`、task routing 与 TaskLease CAS role-based；无 replica 保留旧 context/audit/grant 形状；feasibility 模式采用严格 per-candidate cycle，busy remove 不得预领第二 candidate（Step 4） |
| Create: `src/pth/bootstrap/worker-slot-assembly.ts` | `assembleWorkerSlotIdentity()`：off 分支 `taskPrincipalId=role.id`、`sandboxPrincipalId=worker:<roleId>`；feasibility 分支两者均 `worker:<workerId>`；永不折叠为单一 principalId；batch-process 与内存测试共用（Step 5） |
| Create: `src/pth/bootstrap/worker-slot-runtime.ts` | 生产组件 `WorkerSlotRuntime`：拥有唯一 `slots` 数组；`runOnce`/`runAllOnce` 为唯一轮询入口；`heartbeat` 投影 `replicas[]`；`handleControl` 单 slot 控制；`finalizeStoppedSlot()` 确定性清理（Step 5/6） |
| Create: `src/pth/bootstrap/batch-runtime-assembly.ts` | `assembleBatchRuntime(deps)` 与 `runBatchHost(runtime, hostOpts)`；唯一生产组合根；支持注入 `workerSpecs`/`replicaFactory` 并校验重复 ID、batch mismatch、role ID mismatch、revision mismatch（Step 5） |
| Modify: `src/pth/bootstrap/batch-process.ts` | `PTH_BATCH_ID` fork env 修复（`deps.env` 为 undefined 时 override 不得丢弃）；feasibility 模式实例化共享 slot runtime、委托 IPC/heartbeat/control；off 模式保留旧循环与旧 IPC/heartbeat 形状（Step 5/6） |
| Modify: `src/pth/kernel/execution/batch-manager.ts` | 存储 `replicas: WorkerReplicaStatus[]`；`pendingCtl` 按 `workerId` 关联；新增 `pauseReplica()`/`resumeReplica()`/`removeReplica()`；`removeReplica` 只在最终 `worker-removed` 事件后 resolve（Step 6） |
| Modify: `src/pth/impls/kernels/capability.ts` | worker-originated task capabilities 的 principal 改为 `ctx.worker ? worker:<ctx.worker.workerId> : worker:<ctx.roleId>`；fallback 仅限 legacy tests 与非 batch callers（Step 7） |
| Modify: `src/pth/runner/observers/audit-observer.ts` | 记录 server-stamped worker principal 与独立 role 字段（Step 4） |
| Create: `test/pth-kernel-execution/worker-replica.test.ts` | 同角色副本独立寻址、单任务状态机、busy 时 pause 保留、revision 来自 canonical Role Definition（Step 1） |
| Create: `test/pth-kernel-execution/worker-slot-assembly.test.ts` | 调用 batch-process 实际使用的同一 helper，断言 off 与 feasibility 两分支，含 legacy task/sandbox 两个 distinct principal（Step 8） |
| Create: `test/pth-kernel-execution/worker-slot-runtime.test.ts` | H1 主证据：同 Role 两 slot、busy-remove 收尾、第二 candidate 不领、disposer 恰好一次、另一副本继续 claim/execute、heartbeat/ack 来自共享 runtime 投影（Step 8） |
| Create: `test/pth-kernel-execution/batch-runtime-assembly.test.ts` | 注入 TaskLoop/kernel 适配器有限迭代运行导出 host，断言生产 assembly 发出与 harness 相同的 heartbeat/control/audit/grant identities（Step 8） |
| Modify: `test/pth-kernel-execution/task-loop.test.ts` | claim=0 保持 idle；completed/rejected/cancelled/throw 经同一 finally 回 idle；busy 时 pause → draining → paused；断言 worker ID 与 role ID 分字段（Step 8） |
| Modify: `test/pth-kernel-execution/batch-manager.test.ts` | 子进程 stub 验证 `removeReplica` 传输/关联；off 模式回归：旧 heartbeat 形状、worker-specific control 不可用、principal 等于 pre-N28 role-derived 值（Step 8） |

## 4. 接口产出（Produces，冻结表）

| 接口全名 | 冻结语义 | 后续 Task 消费 |
|---|---|---|
| `WorkerReplica`（含 `createWorkerReplica()`、`roleDefinitionRevision()`），`src/pth/kernel/execution/worker-replica.ts` | 状态机 `idle→busy→draining→paused/stopped`；同一 worker 一次最多一个任务；`ref` 冻结且 `role` 子冻结；`snapshot()` 产出 `WorkerReplicaStatus`；factory 默认 `randomUUID`；`roleDefinitionRevision` 为 canonical Role Definition 的 `role-sha256:<hex>` | T6（经 batch-runtime assembly 组合进 agent 面）；T7（评估器消费生产组件） |
| `WorkerReplicaStatus`，`src/pth/kernel/execution/worker-replica.ts` | `extends WorkerReplicaRef`，携带 `state` 与可选 `currentTaskId`；作为 heartbeat `replicas[]` 与 `BatchManager.replicas` 的冻结元素 | T6（worker-slot-runtime 复用）；T7（H1 心跳身份指标） |
| `WorkerSlotRuntime`，`src/pth/bootstrap/worker-slot-runtime.ts` | 拥有唯一 `slots` 数组；公共面 `add/runOnce/runAllOnce/heartbeat/handleControl/list/disposeAll`；`runOnce`/`runAllOnce` 是 feasibility 模式唯一轮询入口；其 `finally` 调用内部 `finalizeStoppedSlot()` 恰好一次 | T6（修改并复用）；T7（harness/evaluator 直接使用生产 runtime） |
| batch heartbeat `replicas[]`（`WorkerSlotRuntime.heartbeat()` 返回） | feasibility 模式形状 `{ type:"status", tasks, replicas, ts, rss, cpuU, cpuS }`；off 模式不广告 `replicas`、保持旧 heartbeat 形状 | T7（H1 心跳身份指标与验收证据） |
| `pauseReplica()`/`resumeReplica()`/`removeReplica()`，`src/pth/kernel/execution/batch-manager.ts` | 按 `batchId + workerId` 定位单个副本；`pendingCtl` 按 `workerId` 关联；`removeReplica` 只在最终匹配的 `worker-removed` 事件后 resolve；off 模式不接受 worker-specific control | T7（harness/evaluator 控制入口） |
| deterministic stopped-slot cleanup（`finalizeStoppedSlot()` 语义） | busy-remove 先 `draining`/stop-after-task；任务 `finally` 后观察 `stopped`、阻止下一轮、await `loop.stop()`/`dispose()`、移除 slot、发出唯一 `worker-removed`；dispose/remove 幂等；busy remove 后不得预领第二 candidate | T7（H1 busy-remove 收尾证据） |
| `TaskDispatchContext.worker` stamping，`src/pth/contracts/tasking.ts` | `worker?: WorkerReplicaRef`；仅在 replica 存在时由 TaskLoop 服务端戳记；无 replica 保留当前 context/audit/grant 形状 | T4（`AgentTaskRunnerDeps.replica` 与 `KnowledgeContextProvider.build` 传播 `workerId`）；T5（WorkerReplicaRef 消费）；T6（worker-stamped TaskLoop 消费） |
| `assembleWorkerSlotIdentity()`，`src/pth/bootstrap/worker-slot-assembly.ts` | off：`taskPrincipalId=role.id`、`sandboxPrincipalId=worker:<roleId>`；feasibility：两者均 `worker:<workerId>`；返回两个显式 principal，绝不折叠为单一 `principalId`；batch-process 与内存测试共用，测试不得重述分支逻辑 | T6/T7（生产 assembly/harness 复用） |
| `assembleBatchRuntime()` / `runBatchHost()`，`src/pth/bootstrap/batch-runtime-assembly.ts` | 唯一生产组合根；`workerSpecs`/`replicaFactory` 注入并校验 duplicate IDs、batch mismatch、role ID mismatch、`roleDefinitionRevision(input.role) !== replica.ref.role.revision`；host 负责 IPC/control 与轮询，production 传 `continuous=true`，测试/harness 传 `maxIterations` | T6（agent 面集成）；T7（harness 以相同 assembly/host 执行生产组合） |

## 5. 关键步骤

按计划步骤编号；冲突时以计划该 Task 步骤为规范。

- **Step 1**：编写失败测试 `worker-replica.test.ts`，断言同角色副本可独立寻址、同一 worker 一次一个任务、busy 时 pause 保留、revision 来自 canonical Role Definition 而非无关 catalog。Expected：测试因模块缺失 FAIL。
- **Step 2**：运行 `npx vitest run test/pth-kernel-execution/worker-replica.test.ts`。Expected：FAIL，原因是 `src/pth/kernel/execution/worker-replica.ts` 不存在。
- **Step 3**：实现 `WorkerReplica` 类、`WorkerReplicaState`/`WorkerReplicaStatus` 类型、`createWorkerReplica()` 与 `roleDefinitionRevision()`；构造时冻结 `ref` 与 `ref.role`。
- **Step 4**：给 `TaskDispatchContext` 加可选 `worker?: WorkerReplicaRef`；`TaskLoopDeps` 加可选 `replica`；仅当 replica 存在时 start/finish、dispatch context 戳 `worker`、activity/audit 写 `workerId`，并把两处 per-task principal fallback（claim scope 与 `setExecutionGrantContext`）替换为 `worker:<workerId>`；保留 `roles:[role.id]`、`roleId`、task routing 与 TaskLease CAS role-based；无 replica 保留旧形状。feasibility 模式两条路径都用严格 per-candidate cycle。
- **Step 5**：schema 增加 `PTH_BATCH_ID`（默认 `""`）与 `PTH_COGNITIVE_RESPONSIBILITY_MODE`（`off|feasibility`，默认 `off`）；`BatchManager.spawnBatch` 注入 batch ID 但不擅自开启 feasibility；修复 fork env 覆盖表达式；提取 `assembleWorkerSlotIdentity()`、`WorkerSlotRuntime`、`assembleBatchRuntime()`/`runBatchHost()`；`createWorker(role)` 仅在 feasibility 模式创建 replica 并注入 TaskLoop/kernel principal；off 模式保留旧循环、旧 principal 与旧 IPC/heartbeat 形状。
- **Step 6**：feasibility 模式 host 只发 runtime 拥有的 heartbeat 投影；`handleControl` 处理 worker-pause/worker-resume/worker-remove 且只触碰一个 slot；busy-remove 标记 stop-after-task 并调用非中止 `stop()`；`runOnce` 在 finally 后观察 `stopped`、阻止再运行、await stop/dispose、移除 slot、发唯一 `worker-removed`；off 模式不广告 `replicas`、不接受 worker-specific control；`BatchManager` 存 `replicas` 并新增 `pauseReplica`/`resumeReplica`/`removeReplica`。
- **Step 7**：`capability.ts` 中 worker-originated 的 delegate/await/penetrate scope principal 改用 `ctx.worker ? worker:<workerId> : worker:<roleId>`；fallback 仅限 legacy tests 与非 batch callers。
- **Step 8**：扩展测试：子进程 stub 只验证 BatchManager 传输/关联；`worker-slot-runtime.test.ts` 作为 H1 主证据；off 模式回归；`task-loop.test.ts`、`worker-slot-assembly.test.ts`、`batch-runtime-assembly.test.ts` 分别覆盖状态、两分支 principal、生产 assembly 身份一致性。
- **Step 9**：运行 `npx vitest run test/pth-config/config.test.ts ... role-lineage.test.ts` 与 `npx tsc --noEmit`。Expected：PASS；既有 role-bulk control 仍可调用，replica control 独立。
- **Step 10**：按计划 `git add` 契约内全部文件并提交一个 commit，subject 按计划 `feat(pth): separate worker replica identity from roles`；本 lane 首条 commit body 注明 Gate 0 已过，偏差写入 body。

## 6. 设计裁决与红线

1. **Role/Worker 分离**：Role Definition 表达持久工作合同（`roleId + revision`）；WorkerReplica 表达运行实例（唯一 `workerId`）。新代码不得把 role ID 当 worker ID。
2. **同 Role 副本独立寻址**：同角色副本必须拥有不同 `workerId`、相同 role ref；pause/remove 一个副本不得影响同 Role 其他副本；同一副本一次最多执行一个任务。
3. **路由与身份分用**：task routing/claim 与 TaskLease CAS 仍按 `roleId`；具体执行身份、heartbeat、audit 与控制按 `workerId`。Execution Grant principal 使用 `worker:<workerId>`，role 以角色声明单独携带。
4. **busy-remove 必须干净收尾**：busy replica 的 remove 先进入 draining，任务 `finally` 完成后由同一 slot 状态机停止下一轮、释放 kernel 并从 slot 集合移除；不能只把内存状态改成 `stopped`；不得预领第二 candidate。
5. **off 模式逐字节兼容是硬条件**：默认 `off`，保留旧 heartbeat 形状、role 批量控制、旧 task/sandbox principal 值；feasibility 模式才启用 worker-specific control 与 `replicas[]`。
6. **WorkerSlotRuntime 是可行性模式唯一轮询/清理入口**：batch-process 不得保留第二份 slots 数组或清理循环；`runOnce`/`runAllOnce` 是唯一轮询入口，其 `finally` 调用 `finalizeStoppedSlot()` 恰好一次。
7. **两个显式 principal 不得折叠**：`assembleWorkerSlotIdentity()` 必须分别返回 `taskPrincipalId` 与 `sandboxPrincipalId`；off 分支为 `role.id` 与 `worker:<roleId>`，feasibility 分支均为 `worker:<workerId>`；测试不得重述分支逻辑。
8. **`PTH_BATCH_ID` fork env 修复**：`env: { ...process.env, ...(this.deps.env ?? {}), ...envOverride }`；`deps.env` 为 undefined 时 override 不得被丢弃。TaskLoop 两处 principal fallback 只在 replica 存在时换 worker principal，无 replica 时保留完全当前形状。

## 7. 非目标

- 不建 PostgreSQL Region、Responsibility 或 membership 表；本 lane 不做 task/schema migration。
- 不修改 TaskLease 持久化与恢复协议；第一阶段路由与 CAS 仍按现有 `roleId` 工作。
- 不做自动 Region 拆分、自动 Role 分化、autoscaler、embedding 或把实验阈值宣布为生产默认值。
- 不修改 N26 Source/Intake/Verification/Promotion 状态机。
- 不实现 MemoryDirectory、layered retrieval、CognitiveBudget 或 agent 工作集（属 T3–T6）。
- 不改变 Role Lineage parent 语义（parent 表达派生来源，不表达副本、负载或 MemoryRegion）。
- off 模式不广告 `replicas`、不接受 worker-specific control、不改变旧轮询算法；无 replica 调用方不改变旧 context/audit/grant 形状。
- 本 lane 不更新 README 徽章/测试总数（合并回 main 时更新）。

## 8. 验收标准

### 8.1 定向测试

计划本 Task 全部 Run 命令（逐字）：

- `npx vitest run test/pth-kernel-execution/worker-replica.test.ts`（Step 2；Expected：FAIL，因 `worker-replica.ts` 不存在）
- `npx vitest run test/pth-config/config.test.ts test/pth-kernel-execution/worker-replica.test.ts test/pth-kernel-execution/worker-slot-assembly.test.ts test/pth-kernel-execution/worker-slot-runtime.test.ts test/pth-kernel-execution/batch-runtime-assembly.test.ts test/pth-kernel-execution/task-loop.test.ts test/pth-kernel-execution/batch-manager.test.ts test/pth-kernel-execution/role-lineage.test.ts`（Step 9）
- `npx tsc --noEmit`（Step 9）

Expected 关键断言点：

- `worker-slot-runtime.test.ts`：被寻址的 same-Role slot 单独经历 `busy → draining → stopped → removed`；第二个 candidate 从未被 claim 且保持 pending；对该 slot 无后续 `runOnce()`；其 kernel disposer 恰好执行一次；另一个 same-Role slot 继续 claim 并 execute；heartbeat 与 ack 来自共享 runtime 投影；延迟的最终 ack 关联真实 `BatchManager.removeReplica()`。
- `batch-manager.test.ts`：transport stub 报告两个 researcher 副本、只移除被寻址 ID；断言 `removeReplica(batchId,"w-a")` 返回 true，`w-b` 仍在 `listBatches()`；off 模式回归断言 heartbeat 旧形状、worker-specific control 不可用、每个 claim/grant/capability principal 恰好等于其 pre-N28 role-derived 值。
- `task-loop.test.ts`：claim=0 时 replica 保持 idle；completed/rejected/cancelled/throw 均经同一 `finally` 回到 idle；busy 任务中 pause → `draining`，完成后 `paused`；捕获 TaskDispatchContext、grant context、activity 与 AuditObserver 输出并断言 worker ID 与 role ID 分字段。
- `worker-slot-assembly.test.ts`：调用 batch-process 使用的同一 helper，断言 off 与 feasibility 两分支，包括 legacy task/sandbox 两个 distinct principal。
- `batch-runtime-assembly.test.ts`：以注入的 TaskLoop/kernel 适配器有限运行两个迭代，断言生产 assembly 发出与 harness 相同的 heartbeat、control、audit、grant identities；disconnected helper 或 source-text match 不算证据。
- Step 9 Expected：PASS；既有 role-bulk control 仍可调用，replica control 独立。

### 8.2 关闭条件对账表

| 关闭条件 | 证据要求 |
|---|---|
| 同 Role 两副本独立寻址：不同 `workerId`、相同 role ref；独立 pause/remove 不影响同 Role 其他副本 | `worker-replica.test.ts`：`a.ref.role` 等于 `b.ref.role`、`a.ref.workerId !== b.ref.workerId`、`Object.isFrozen(a.ref.role)`；`worker-slot-runtime.test.ts`：被寻址 slot 单独 `busy→draining→stopped→removed`，另一同 Role slot 继续 claim/execute |
| 同一 WorkerReplica 一次最多一个任务；claim=0 保持 idle；完成/拒绝/取消/抛错经同一 finally 回 idle；busy 时 pause → draining → paused | `worker-replica.test.ts`（startTask 重复抛 `/already busy/`；finishTask 回 idle）；`task-loop.test.ts` 相应用例 |
| busy-remove 干净收尾：先 draining，任务 `finally` 后由同一 slot 状态机停止下一轮、释放 kernel、移除 slot；不得只改内存状态为 `stopped`；busy remove 后不得预领第二个 candidate | `worker-slot-runtime.test.ts`：第二 candidate 从未 claim 且保持 pending、无后续 `runOnce()`、kernel disposer 恰好一次、delayed final ack 关联真实 `BatchManager.removeReplica()`；`finalizeStoppedSlot()` 计数/事件断言 |
| heartbeat、audit、grant 能定位实例：audit/grant/heartbeat 都要 workerId 与 roleId 分字段；TaskLoop 两处 principal fallback 只在 replica 存在时换 worker principal | `task-loop.test.ts` 捕获 TaskDispatchContext、grant context、activity 与 AuditObserver 输出断言分字段；`batch-runtime-assembly.test.ts` 断言生产 assembly 发出相同 identities；无 replica 时旧形状不变 |
| 爆炸半径最大的 lane。off 模式逐字节兼容是硬条件：旧 heartbeat 形状、role 批量控制、旧 task/sandbox principal 值全部保留。WorkerSlotRuntime 是可行性模式唯一轮询/清理入口，batch-process 不得保留第二份 slots 数组或清理循环。busy remove 后不得预领第二个 candidate。PTH_BATCH_ID fork env 修复（deps.env 为 undefined 时 override 不得丢弃）。合并者额外 review：逐一对照 batch-process 旧行为做 off 模式 diff 审查；TaskLoop 两处 principal fallback 只在 replica 存在时换 worker principal；audit/grant/heartbeat 都要 workerId 与 roleId 分字段。 | `batch-manager.test.ts` off 模式回归 + `worker-slot-assembly.test.ts` 两分支断言 + `worker-slot-runtime.test.ts` busy-remove 断言 + §9 合并者检查清单全过；合并者 off 模式逐行 diff 审查通过 |
| `WorkerSlotRuntime` 是可行性模式唯一轮询/清理入口；batch-process 不得保留第二份 slots 数组或清理循环 | `worker-slot-runtime.test.ts` 使用与 batch-process 相同的生产 runtime；`batch-runtime-assembly.test.ts` 执行导出 host；代码审查确认 batch-process 无第二 slots 数组/清理循环 |
| `PTH_BATCH_ID` fork env 修复（`deps.env` 为 undefined 时 override 不得丢弃） | `test/pth-config/config.test.ts` 新键默认值；`batch-manager.test.ts`/审查确认 fork `env` 表达式为 `{ ...process.env, ...(this.deps.env ?? {}), ...envOverride }`，undefined 时不丢 override |
| 既有 role-bulk control 仍可调用，replica control 独立 | Step 9 vitest 全绿 + 计划 Expected：PASS |
| 不弱化任何 N27 已验收契约、不变量或回归测试 | 全量 `npx vitest run` 全绿（既有 9 skip 基线不变）+ `npm run lint` 全绿 |
| 真实 PG 环境不可用 | 按 `EVALUATION-INCOMPLETE` 记录，不得冒充通过 |

### 8.3 全量门槛

合并者合并前：`npx vitest run` 全绿（既有 9 skip 基线不变）+ `npm run lint` 全绿；真实 PG 环境不可用按 `EVALUATION-INCOMPLETE` 记录，不得冒充通过。

## 9. merge 前合并者检查清单

1. **off 模式逐字节兼容 diff 审查（爆炸半径最大）**：逐一对照 `batch-process.ts` 旧行为做 off 模式 diff 审查——旧 heartbeat 形状、role 批量控制、旧 task/sandbox principal 值全部保留；无 replica 路径的 context/audit/grant 形状逐字段不变。
2. **唯一轮询/清理入口审查**：确认 `WorkerSlotRuntime` 是 feasibility 模式唯一轮询/清理入口；`batch-process.ts` 不得保留第二份 `slots` 数组或清理循环；`runOnce`/`runAllOnce` 是唯一轮询入口，`finalizeStoppedSlot()` 恰好执行一次。
3. **busy-remove 对抗审查**：确认 busy 时先进入 draining/stop-after-task，当前任务 `finally` 完成后才 finalize；同一 `runOnce()` 内不得预领第二个 candidate；dispose/removal 幂等；其他同 Role slot 不受影响。
4. **principal 分字段审查**：TaskLoop 两处 principal fallback 只在 replica 存在时换 `worker:<workerId>`；claim scope、grant、audit、heartbeat 都要 `workerId` 与 `roleId` 分字段；`assembleWorkerSlotIdentity()` 必须返回两个显式 principal 且 off 分支保留旧值。
5. **fork env 与配置审查**：`PTH_BATCH_ID` 的 fork env 覆盖在 `deps.env` 为 undefined 时不得丢弃；`PTH_COGNITIVE_RESPONSIBILITY_MODE` 默认 `off`；`spawnBatch` 注入 batch ID 但不擅自开启 feasibility。

## 10. 偏差纪律

- lane 内只动 §3 文件域；如需触及其他文件，先停 lane 报告用户裁决。
- 发现计划缺陷/步骤不可执行：停下报告，不自行改计划。
- README 徽章/测试总数只在合并回 main 时更新。
- 每 lane 一条 commit（focus 测试 + 契约内文件域）；偏差必须写进 commit body。
- 实现期不得弱化任何 N27 已验收契约、不变量或回归测试。
