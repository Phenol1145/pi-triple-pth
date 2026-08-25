# N28-T1 契约：冻结认知责任契约与角色兼容名

> 对应实施计划 Task 1（docs/pth/plan/n28-role-memory-orchestration-implementation-plan.md L46–L234）；验证假设：契约是所有假设的公共地基（H1–H6 共用的类型与常量）
> 上游依赖：无上游 lane；直接消费 main 上的 N16/N27 已验收接口
> Gate 0 记录：N27 最终复验报告 docs/pth/report/v1.2-acceptance-fix-revalidation-final.md 为 ACCEPTED；复验对象 main@c2c0729（R6=4d0a38b 经 merge c2c0729 合入 main，R1–R6 全部 merged）；N28 设计/计划基线 commit 9f10082（docs-only）。本 lane 实现分支必须派生自包含 9f10082 的 main，且首条 commit 信息注明 Gate 0 已过。
> 车道：分支 lane/n28-t1-contracts，worktree .worktrees/n28-t1，串行合并顺序 T1→T2→T3→T4→T5→T6→T7。

## 1. 目标

本 lane 只做计划 Task 1「Freeze the Cognitive Responsibility Contract and Role Compatibility Name」：冻结认知责任契约类型与实验预算常量，并把 `WorkerRole` 重命名为 `RoleDefinition` 且保留兼容别名。计划 Expected 为：Step 2 定向测试先因模块缺失而 FAIL；Step 6 聚焦测试 PASS，且不改变现有角色注册与谱系输出。

## 2. 上游接口（Consumes）

| 接口 | 来源文件 | 上游 Task |
|---|---|---|
| `WorkerRole`（现役角色字段；本 Task 重命名为 `RoleDefinition`，字段不变） | `src/pth/kernel/execution/worker-cluster.ts` | 无上游 lane；main 上 N16/N27 已验收接口 |
| 规范术语（Role Definition / WorkerReplica / MemoryRegion / 四类记忆等） | `CONTEXT.md` | 无上游 Task（仓库术语事实源） |

## 3. 实施范围

| 文件 | 改动 |
|---|---|
| Create: `src/pth/contracts/cognitive-responsibility.ts` | 新建契约文件：按设计 §2.2/§5.3/§6.2 建立类型（含支撑类型 `RetrievalWaveTrace`）、`N28_FEASIBILITY_BUDGET` 与 `checkResponsibilityCapacity()`（Step 3）；§4.1 的 Directory 类型归 T3 `memory-directory.ts` 独家拥有，本文件不得重复定义 |
| Modify: `src/pth/contracts/index.ts` | barrel 新增 `export * from "./cognitive-responsibility.js";`（Step 4） |
| Modify: `src/pth/kernel/execution/worker-cluster.ts` | `export interface WorkerRole` 改名为 `export interface RoleDefinition`，现有字段不变；新增可选 `loadPolicyRef?`；紧随接口新增兼容别名 `export type WorkerRole = RoleDefinition;`（Step 5） |
| Create: `test/pth-contracts/cognitive-responsibility.test.ts` | 新建契约定向测试（Step 1） |
| Modify: `test/pth-kernel-execution/worker-cluster.test.ts` | 新增 `WorkerRole` 兼容别名断言（Step 5） |

## 4. 接口产出（Produces，冻结表）

| 接口 | 冻结语义 | 后续 Task 消费 |
|---|---|---|
| `RoleDefinition` | 持久工作合同（由 `WorkerRole` 重命名，字段不变 + 可选 `loadPolicyRef?`）；角色 ID 不得被当作 worker ID | Task 2（`WorkerReplica` 构造、`roleDefinitionRevision`）、Task 3/5/6/7 |
| `RoleDefinitionRef` | `{ roleId: string; revision: string }` 稳定角色引用 | Task 2 起（作为 `WorkerReplicaRef.role`）、Task 3/6/7 |
| `WorkerReplicaRef` | 运行实例引用 `{ workerId; batchId; role }`；`workerId` 全系统唯一 UUID，`batchId` 只表达宿主生命周期、不参与消歧 | Task 2–7（H1 分离、目录、检索、预算、agent 面、评估） |
| `MemoryType` | `"setting" \| "wiki" \| "skill" \| "log"` 四类记忆 | Task 3（`classifyFeasibilityMemoryType`）、Task 4/5 |
| `MemoryRegion` | 版本化逻辑选择器与索引单元，不复制正文；selector 语义「组间 AND、组内 OR」；空 selector 非法，仅 `region:unclassified` 可无 selector | Task 3（Directory 构建）、Task 4（分层检索） |
| `MemoryResponsibility` | 责任绑定 `{ workerId; regionId; regionRevision; kind; priority; epoch }`；只改变检索优先级，不授予可见性 | Task 3（Directory 构建与容量断言）、Task 4 |
| `ResponsibilityCapacity` | `{ maxRegions; maxPrimaryWeight; maxSecondaryWeight }`，overlap 与 fallback 都计入 secondary | Task 3（`assertMemoryDirectoryResponsibilityCapacity`）、Task 5 测试 |
| `CognitiveBudget` | `{ maxMemoryEntries; maxMemoryChars; maxSkillIndexEntries; maxActiveSkills; maxSkillChars; maxTools }` 任务级统一账本上限 | Task 3 测试（`N28_ROLE_LOAD_POLICIES`）、Task 5/6/7 |
| `WorkerLoadEnvelope` | `{ responsibility: ResponsibilityCapacity; task: CognitiveBudget }` | Task 6（`budget: WorkerLoadEnvelope`）、Task 7 |
| `TaskWorkingSetPolicy` | 任务开始即冻结的 policy：taskId / worker / directorySnapshotId / budget / skillIndexIds / toolNames | Task 5（`createTaskWorkingSetPolicy` 产出）、Task 6/7 |
| `TaskWorkingSet` | 随合法展开单调增长的工作集快照：memory/skill/tool 使用量 + `usage` + `omitted` + `retrievalTraces` | Task 5（ledger `snapshot()` 返回）、Task 6/7 |
| `PendingRetrievalTrace` | Retriever 产生的未编号 trace；`status` 四态 `found \| exhausted-empty \| retrieval-incomplete \| retrieval-failed` | Task 4（产出）、Task 5（`recordRetrievalTrace` 输入）、Task 6 |
| `RetrievalTrace` | 任务账本按调用顺序编号后的 trace（`traceId` + `callIndex`） | Task 5（`TaskWorkingSet.retrievalTraces`）、Task 6/7 |
| `N28_FEASIBILITY_BUDGET` | 冻结实验预算常量（双层 `Object.freeze`；数值照抄设计 §6.2：3/80/40/8/4096/8/4/8192/16）；不进入生产默认值 | Task 3/5/6/7 与全部 H 假设验证 |
| `checkResponsibilityCapacity()` | 责任容量硬上限校验；拒绝原因按计划 Step 3 全列 | Task 3（`assertMemoryDirectoryResponsibilityCapacity`）、Task 5 测试、Task 7 评估 |

> 注：`MemoryRegionSelector`、`MemoryResponsibilityKind`、`ResponsibilityCapacityResult`、`RetrievalWaveTrace` 是上述接口的支撑类型，随同一文件冻结，不在计划 Produces 清单中单列。

## 5. 关键步骤

1. **Step 1 — 写失败契约测试**：建立 worker/regions/responsibilities fixtures，覆盖容量内通过、primary 超限、overlap+fallback 共用 secondary 上限、worker-mismatch 四类断言。Expected：测试文件就位，等待 Step 2 因模块缺失失败。
2. **Step 2 — 运行契约测试确认缺失模块失败**：运行 `npx vitest run test/pth-contracts/cognitive-responsibility.test.ts`。Expected：FAIL，因为 `src/pth/contracts/cognitive-responsibility.ts` 不存在。
3. **Step 3 — 创建可执行契约与精确实验预算**：按设计 §2.2/§5.3/§6.2 逐字建立接口（`RetrievalWaveTrace` 作为 `PendingRetrievalTrace` 的支撑类型随本文件冻结；§4.1 Directory 类型由 T3 独家拥有），加入 `Object.freeze` 的 `N28_FEASIBILITY_BUDGET` 与 `checkResponsibilityCapacity()`。Expected：常量与设计一字不差；拒绝原因联合类型全列 worker-mismatch / unknown-region / region-revision / invalid-weight / duplicate-responsibility / region-count / primary-weight / secondary-weight，且函数内按计划 Step 3 的顺序短路返回。
4. **Step 4 — 从 barrel 导出契约**：在 `src/pth/contracts/index.ts` 添加 `export * from "./cognitive-responsibility.js";`。Expected：后续 Task 可从 `src/pth/contracts/index.js` 导入全部契约。
5. **Step 5 — 重命名角色接口且不破坏导入**：`export interface WorkerRole` 改名为 `export interface RoleDefinition`，字段不变；新增可选 `loadPolicyRef?`；紧随接口新增 `export type WorkerRole = RoleDefinition;`；在 `worker-cluster.test.ts` 增加兼容别名断言。Expected：现有导入不破坏；角色注册与谱系输出不变。
6. **Step 6 — 运行聚焦测试**：运行 `npx vitest run test/pth-contracts/cognitive-responsibility.test.ts test/pth-kernel-execution/worker-cluster.test.ts test/pth-kernel-execution/role-lineage.test.ts`。Expected：PASS，且不改变现有角色注册与谱系输出。
7. **Step 7 — 提交契约切片**：按计划 `git add` §3 五文件并 commit。Expected：单条 commit `feat(pth): define cognitive responsibility contracts`。

## 6. 设计裁决与红线

1. **Role Definition 与 WorkerReplica 分离**：Role Definition 表达持久工作合同，WorkerReplica 表达运行实例；新代码不得把 role ID 称作 worker ID。
2. **重命名是兼容别名，不是语义迁移**：`WorkerRole` 改名为 `RoleDefinition` 时字段保持不变，仅新增可选 `loadPolicyRef?`；`WorkerRole` 保留为 `@deprecated` 类型别名，不得破坏现有导入。
3. **契约字段名是后续实施计划的统一接口**：`cognitive-responsibility.ts` 中的类型必须按设计 §2.2/§5.3/§6.2 逐字建立（§4.1 Directory 类型由 T3 `memory-directory.ts` 独家拥有）；`MemoryRegion` 不复制正文，Region 不是第五类记忆。
4. **责任不是授权**：`MemoryResponsibility` 只改变维护与检索优先级；tenant、space、status、Execution Grant 检查在所有读面保留，责任区不得扩大权限。
5. **Selector 语义固定**：组间 AND、组内 OR；`domains` 只读取 Catalog 验证的 DomainId，`memoryTypes` 读取 `DirectoryEntryInput.memoryType`；空 selector 非法，仅 `region:unclassified` 可无 selector。
6. **拒绝原因全列**：`checkResponsibilityCapacity` 的拒绝原因必须按六类组织、8 个原因字面量全列——绑定完整性五类（worker-mismatch、unknown-region、region-revision、invalid-weight、duplicate-responsibility）+ 容量超限类（region-count / primary-weight / secondary-weight）。
7. **实验预算常量照抄设计 §6.2**：`N28_FEASIBILITY_BUDGET` 为 `maxRegions=3, maxPrimaryWeight=80, maxSecondaryWeight=40, maxMemoryEntries=8, maxMemoryChars=4096, maxSkillIndexEntries=8, maxActiveSkills=4, maxSkillChars=8192, maxTools=16`；这些是实验常量，不进入生产配置默认值。
8. **`maxTools` 语义**：静态与 ToolReg 工具共享同一 `maxTools` 上限，pinned tools 计入；`maxTools` 只计实际 LLM Tool schemas（static + ToolReg 规范下划线名），TS capability 函数不算工具 schema。
9. **本 lane 零运行时行为**：Task 1 只冻结类型与常量，不建 PG 表、不做 task/memory schema 迁移、不改 TaskLease 持久化、不碰 N26 状态机。
10. **不改变角色注册与谱系输出**：Step 6 聚焦测试必须证明 `role-lineage.test.ts` 与改动前基线一致，任何角色注册/谱系输出变化都是本 lane 的 No-Go。

## 7. 非目标

- 不迁移现有 `WorkerRole` 存储结构；首版不要求现有 WorkerRole 存储立即迁移（`WorkerRole` 仅作兼容别名保留）。
- 不创建 PostgreSQL Region / Responsibility / membership 表，不做 membership transactional outbox 与重启恢复。
- 不做自动 Region 发现/拆分/合并/迁移，不做 Role 自动创建/合并/退役，不做长期 autoscaler。
- 不做 embedding、向量库或真实语义检索精度优化。
- 不修改 N26 Source/Intake/Verification/Promotion 状态机。
- 不把实验阈值直接宣布为生产默认值。
- 本 lane 不实现目录构建、分层检索、预算账本或 agent 暴露面等运行时行为；只冻结类型与常量。
- 不在本 lane 更新 README 徽章/测试总数（只在合并回 main 时更新）。

## 8. 验收标准

### 8.1 定向测试

计划本 Task 的全部 Run 命令（本 Task 无独立 tsc Run 命令）：

- `npx vitest run test/pth-contracts/cognitive-responsibility.test.ts`（Step 2）
  - Expected：FAIL，失败原因为 `src/pth/contracts/cognitive-responsibility.ts` 不存在。
- `npx vitest run test/pth-contracts/cognitive-responsibility.test.ts test/pth-kernel-execution/worker-cluster.test.ts test/pth-kernel-execution/role-lineage.test.ts`（Step 6）
  - Expected：PASS，且无角色注册或谱系输出变化。

关键断言点：

- `accepts a worker load that is inside every responsibility limit`：`toEqual({ ok: true, usage: { regions: 2, primaryWeight: 50, secondaryWeight: 30 } })`。
- `rejects responsibility expansion above the primary weight`：algebra 权重 81 时 `toMatchObject({ ok: false, reason: "primary-weight" })`。
- `counts overlap and fallback against the same secondary ceiling`：overlap 30 + fallback 11 > 40 时 `toMatchObject({ ok: false, reason: "secondary-weight" })`。
- `rejects a responsibility that names another worker`：`toMatchObject({ ok: false, reason: "worker-mismatch" })`。
- `keeps WorkerRole as a compatibility alias for RoleDefinition`：`RoleDefinition` 值可赋给 `WorkerRole`，且 `legacy.id === "compat-role"`。

### 8.2 关闭条件对账表

| 关闭条件 | 证据要求 |
|---|---|
| 契约接口与预算常量与设计一字不差（设计 §2.2/§5.3/§6.2；§4.1 归 T3） | 定向测试 4 例通过；review 逐字段 diff 接口名与字面量（含 `RetrievalWaveTrace`）；`N28_FEASIBILITY_BUDGET` 9 个数值与设计逐项一致 |
| `checkResponsibilityCapacity` 六类拒绝原因全列（8 个 reason 字面量） | `cognitive-responsibility.test.ts` 覆盖 worker-mismatch / primary-weight / secondary-weight；函数体内 unknown-region / region-revision / invalid-weight / duplicate-responsibility / region-count 路径不得少于计划 Step 3 字面量 |
| `WorkerRole` → `RoleDefinition` 重命名必须是兼容别名，不得破坏现有导入 | `worker-cluster.test.ts` 新用例 `keeps WorkerRole as a compatibility alias for RoleDefinition` + Step 6 focused run 全 PASS |
| 不得改变任何角色注册/谱系输出 | `role-lineage.test.ts` 在 Step 6 focused run 中 PASS，输出与改动前基线一致 |
| 计划 Expected：Step 2 缺失模块 FAIL；Step 6 focused PASS | Step 2 命令输出为 module-not-found 类 FAIL；Step 6 命令输出全 PASS |
| 全局约束：新代码不把 role ID 当 worker ID；责任不授权；本 lane 不做 schema 迁移 | review：本 lane 只增类型/常量与兼容别名；无 PG/schema 文件进入改动集 |
| 偏差纪律：lane 内只动 §3 文件域；单条 commit；不弱化 N27 合约 | commit body + `git show --stat` 文件集等于 §3 五文件；无 N27 回归测试被删除或弱化 |

> **特别注意**：契约接口与预算常量必须与设计一字不差；checkResponsibilityCapacity 的六类拒绝原因全列；WorkerRole→RoleDefinition 重命名必须是兼容别名，不得破坏现有导入；不得改变任何角色注册/谱系输出。合并者额外 review：没有借机修改 worker-cluster 中与契约无关的字段语义；barrel 导出不得引入循环依赖。

### 8.3 全量门槛

合并者合并前：`npx vitest run` 全绿（既有 9 skip 基线不变）+ `npm run lint` 全绿；真实 PG 环境不可用按 `EVALUATION-INCOMPLETE` 记录，不得冒充通过。

## 9. merge 前合并者检查清单

1. **契约逐字对账**：逐个字段 diff `src/pth/contracts/cognitive-responsibility.ts` 与设计 §2.2/§5.3/§6.2（§4.1 Directory 类型归 T3）；`N28_FEASIBILITY_BUDGET` 的 9 个数值与设计一字不差，且双层 `Object.freeze` 在位；`RetrievalWaveTrace` 随本文件冻结。
2. **拒绝原因与边界**：核对 `ResponsibilityCapacityResult` 联合类型与函数实际返回的 8 个 reason 字面量完全一致，六类组织无缺漏；容量比较保持计划原样，不得改成更宽松的边界。
3. **别名纯度**：`worker-cluster.ts` 中 `WorkerRole` 必须逐字为 `export type WorkerRole = RoleDefinition;` 且带 `@deprecated`；`RoleDefinition` 与旧 `WorkerRole` 字段完全一致，只新增 `loadPolicyRef?`，没有借机修改 worker-cluster 中与契约无关的字段语义。
4. **谱系无变化**：focused run 中 `role-lineage.test.ts` 输出与改动前基线一致，角色注册/谱系输出零变化；若基线快照丢失，先停 lane 报告。
5. **barrel 与依赖**：`src/pth/contracts/index.ts` 只新增 `export * from "./cognitive-responsibility.js";`；确认 barrel 导出不得引入循环依赖（`contracts` 不得反向 import `worker-cluster` 或其他运行时模块）。

## 10. 偏差纪律

- lane 内只动 §3 文件域；如需触及其他文件，先停 lane 报告用户裁决。
- 发现计划缺陷/步骤不可执行：停下报告，不自行改计划。
- README 徽章/测试总数只在合并回 main 时更新。
- 每 lane 一条 commit（focus 测试 + 契约内文件域）；偏差必须写进 commit body。
- 实现期不得弱化任何 N27 已验收契约、不变量或回归测试。
