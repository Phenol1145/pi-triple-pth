# N31：统一 Workflow DAG 薄腰设计

> 日期：2026-08-19
>
> 状态：**设计已确认；尚未实施**
>
> 前置设计：[任务编排分工](./orchestration.md) · [Trigger 运行时](./trigger-runtime.md) ·
> [统一运行观测台](./n30-runtime-observatory-design.md)

## 0. 决策摘要

PTH 不新建一个替代 Task、Knowledge Intake、Optimizer 和 Trigger 的通用 Workflow 引擎。
本设计新增一个最小“薄腰”协议：下层原生执行器继续拥有各自状态和安全不变量，上层把它们投影为统一、只读、可版本化的 DAG；动态构造首期只编译为现有 `FlowSpec`，不改写 Knowledge Intake 或 Promotion 的安全状态机。

统一关系如下：

```text
原生事实源                 统一薄腰                    消费方

Task / FlowSpec     ─┐
Intake Run/Attempt   ├─> Workflow Projector ─> Workflow Run Graph ─> API / N30 / Audit
Optimizer/Proposal   ┤
Trigger/Audit       ─┘

Feedback + Catalog + Budget
              └──────> Workflow Compiler ─> FlowSpec ─> 现有 TaskResolver
```

核心裁决：

1. **Workflow 是一次有限运行内的无环工作图**；现有 `loop` 在视图中按 attempt 展开，不画回边。
2. **Loop 是跨 Workflow Run 的反馈关系**；一轮结束后可编译不同的下一轮 Workflow Revision。
3. **统一先发生在合同、投影、关联和观测面，不发生在领域状态所有权上**。
4. **Task Flow 是首个可动态编译目标**；Intake、Promotion、Optimizer 首期只投影，不接受通用编译器改写安全骨架。
5. **Activity/SSE 是低延迟提示，PostgreSQL 与原生聚合仍是历史事实源**。
6. 首期不新增数据库表、不迁移存量数据、不新增 Role/Worker、不改变 claim/lease/CAS/outbox 语义。

## 1. 背景与当前事实

PTH 已存在多种“工作流”或“循环”，但它们不是同一种执行模型：

| 机制 | 当前事实源 | 当前执行模型 | 已有动态性 |
|------|-----------|-------------|-----------|
| Task Flow | `tasks.payload.flow` | `TaskResolver` 顺序解释 Stage | match/branch/decompose/loop/wait |
| Task delegation | Task delivery + parent/lineage | TaskControl delegate/await | 运行时生成子任务 |
| Knowledge Intake | `knowledge_intake_runs/attempts` | PG stage + lease/CAS + outbox | 重试、重爬、unchanged/changed |
| Optimizer | scorecard + memory suggestion + verify task | 窗口检测、apply、verify、deopt | 下一窗口反馈 |
| Trigger | system/memory TriggerDef | event/schedule → native action/task | 动态退避、事件链 |
| Human gate | Human Interaction 协议 | 外部响应后恢复 | 人类裁决 |

现有 `FlowSpec` 是有序 Stage 表，不是显式 DAG。`TaskResolver` 以 `resolvedStages.length` 选择下一 Stage；`decompose` 产生带 parent/deps 的新 Task。它足以作为首期动态编译目标，却不能被宣称为通用 DAG 调度器。

Knowledge Intake 已有更严格的领域状态机：阶段迁移必须绑定 tenant、fromStage、lease token、lease generation、rowVersion 与未过期 lease，并把下一阶段 outbox 与迁移放在同一事务。把它降级成普通 Flow 会破坏已验收的安全不变量，因此本设计明确禁止这种迁移。

## 2. 目标与非目标

### 2.1 目标

- 为 Task、Intake、Optimizer、治理提案提供同一 Workflow Run Graph 读模型；
- 为 N30 甘特图、关键路径、阻塞分析和资源关联提供稳定节点与边；
- 保留 native status，同时给出有限、诚实的归一状态；
- 为事件增加可选 Workflow 关联字段，兼容现有生产者；
- 让不同反馈输入可编译出不同的下一轮 Task Flow；
- 每个编译结果可解释、可摘要、可散列、可重放比较；
- 防止 LLM 或 worker 直接修改运行图、扩大授权或删除安全节点；
- 保持现有执行路径和数据库 schema 不变。

### 2.2 首期非目标

- 不建设通用 Workflow 状态表或新的顶层 Module；
- 不以统一协议替代 TaskRepository、IntakeRepository 或 Optimizer；
- 不为 `FlowSpec` 新增任意依赖边、join 调度器或图搜索调度器；
- 不让通用 Compiler 编排 Intake fetch/admit/verify/promote；
- 不提供统一写控制 API；
- 不把 ActivityHub 变成持久事件库；
- 不以 payload 中未盖章的 parent/deps 作为授权事实；
- 不实现 LLM 自由生成并直接提交 Workflow；
- 不在本轮实现 Source Expansion、自动 Memory Responsibility 再平衡或全局 Router 学习。

## 3. 领域模型

### 3.1 Workflow Definition

描述一类有限工作图的稳定模板、约束和反馈入口。首期不单独持久化 Definition；Task Flow 的 Definition 由 Compiler 版本与现有 `FlowSpec` 共同标识。

### 3.2 Workflow Revision

一次编译产生的不可变拓扑版本。Revision 由规范化定义和编译输入摘要共同绑定；运行开始后不原地修改。运行时扩展形成新的 revision 或原生子任务事实，但不得改写旧历史。

### 3.3 Workflow Run

某个 Workflow Revision 的一次有限执行。Task lineage、Intake Run、Optimizer suggestion 分别可成为原生 Run。

### 3.4 Loop Epoch

反馈循环中的一轮 Workflow Run。同一 Loop 的下一 Epoch 可以引用不同 Workflow Revision；跨轮反馈是因果关系，不是当前 DAG 的回边。

### 3.5 Workflow Projection

从原生事实源构造的只读 Workflow Run Graph。Projection 不拥有状态，不通过反向写入改变原生聚合。

### 3.6 Workflow Compiler

根据上一轮摘要、反馈、Runtime Catalog、认知预算与编译策略生成下一轮 Task Flow 的纯编译边界。Compiler 不认领任务、不执行工具、不写知识、不批准提案。

## 4. 统一合同

合同放在 `src/pth/contracts/workflow.ts`，由 contracts barrel 导出。首期合同保持只读、小集合和开放 native reference，不把所有原生字段复制进来。

~~~typescript
export type WorkflowType =
  | "task-flow"
  | "knowledge-intake"
  | "optimizer"
  | "governance"
  | "control";

export type WorkflowNodeKind =
  | "task"
  | "stage"
  | "decision"
  | "human-gate"
  | "join"
  | "native-action"
  | "compensation";

export type WorkflowNodeStatus =
  | "planned"
  | "ready"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type WorkflowEdgeKind =
  | "requires"
  | "spawned-by"
  | "waits-for"
  | "reviews"
  | "compensates"
  | "supersedes";

export interface WorkflowRunRef {
  readonly workflowType: WorkflowType;
  readonly runId: string;
  readonly epoch: number;
  readonly definitionVersion?: string;
}

export interface WorkflowNativeRef {
  readonly kind: "task" | "intake-run" | "intake-attempt" |
    "optimizer-suggestion" | "proposal" | "trigger-fire";
  readonly id: string;
}

export interface WorkflowNode {
  readonly nodeId: string;
  readonly kind: WorkflowNodeKind;
  readonly nativeRef: WorkflowNativeRef;
  readonly nativeStatus: string;
  readonly status: WorkflowNodeStatus;
  readonly label: string;
  readonly attempt?: number;
  readonly roleId?: string;
  readonly workerId?: string;
  readonly batchId?: string;
  readonly createdAt?: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WorkflowEdge {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly kind: WorkflowEdgeKind;
  readonly nativeEvidence?: readonly WorkflowNativeRef[];
}

export interface WorkflowRunGraph {
  readonly ref: WorkflowRunRef;
  readonly nativeStatus: string;
  readonly status: WorkflowNodeStatus;
  /** 只覆盖稳定 node identity/kind 与 edges，表达本轮拓扑。 */
  readonly topologyDigest: string;
  /** 覆盖 native status、attempt 与时间字段，表达本次读模型快照。 */
  readonly snapshotRevision: string;
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
  readonly observedAt: number;
  readonly warnings: readonly string[];
}
~~~

`topologyDigest` 是对规范化 `ref + node identity/kind + edges` 的 SHA-256 摘要；
`snapshotRevision` 再覆盖 native status、attempt 与事实时间。二者都不是数据库 row version。
节点与边先按稳定 ID 排序，`observedAt` 不参与任何摘要。这样状态更新可以只改变
snapshotRevision，而不把相同拓扑误报成新的 Workflow Revision。

## 5. 身份映射与投影规则

### 5.1 Task Flow

Run 身份优先级：

1. 服务器盖章的 `payload.delivery.lineageId`；
2. 服务器侧可验证的 `job_id`；
3. 根 Task 自身 ID。

禁止仅凭调用方自报的 `payload.parent/deps` 合并跨租户 Run。Legacy parent/deps 只可作为显示证据，并产生 warning；权威 parent edge 必须来自 delivery 盖章或同租户数据库关系。

节点：

- Task 节点：`task:<taskId>`；
- Flow Stage 视图节点：`task:<taskId>:stage:<stageId>:attempt:<n>`；
- delegate 子任务仍是独立 Task 节点；
- `dispatchWait` 生成 `waits-for` 边；
- delivery parent 生成 `spawned-by` 边；
- legacy deps 只在可验证同租户且目标存在时生成 `requires` 边。

现有 `FlowSpec.loop` 不在图内产生 `stage → stage` 回边，而是展开为：

```text
stage:x:attempt:1 → stage:x:attempt:2 → stage:x:attempt:3
```

如果现有数据不足以还原历史 attempt，Projection 只显示当前累计次数并写 warning，不伪造精确时间区间。

Task 状态归一：

| native | normalized |
|--------|------------|
| pending | ready |
| claimed | running |
| submitted（历史兼容状态） | unknown |
| completed | succeeded |
| rejected | failed |
| escalated | waiting |

### 5.2 Knowledge Intake

Run ID 为 `intake:<tenantId>:<runId>`。每条 append-only attempt 是一个节点：

```text
intake:<runId>:<stage>:<attempt>:<leaseGeneration>
```

边来自 frozen transition matrix 和实际成功 attempt，不从 UI 猜测阶段。当前尚未发生的允许阶段可作为 `planned` 节点显示，但必须标记 `detail.materialized=false`，不得混同于事实。

Intake 状态归一：

| native | normalized |
|--------|------------|
| queued | ready |
| leased | running |
| waiting | waiting |
| completed | succeeded |
| failed/dead-letter | failed |

Projection 绝不提供反向写入口；stage/lease/CAS/outbox 继续完全由 IntakeRepository 和 IntakeService 拥有。

### 5.3 Optimizer

Run ID 为 `optimizer:<tenantId>:<suggestionId>`。首期根据 suggestion、目标资产、verify task、verify aggregate 与 deopt 记录生成：

```text
observe → suggest → apply|human-gate → verify → keep|compensation
```

缺少基线、复测或 deopt 事实时保留 warning，不把“没有记录”解释为成功。

### 5.4 Governance 与 Control

Skill、Tool、Memory、Role 提案可按 proposal ID 投影为 governance Run；首期只要求合同支持，不纳入第一批验收。

Trigger 的 schedule/event 只是 Workflow 的唤醒或反馈机制，不等于完整 Workflow。没有 durable fire ID 的控制环只进入实时 Activity 视图，不承诺历史 Run 重放；后续如需历史控制环，再引入服务器生成的 fire ID，不能以时间戳拼接授权身份。

## 6. 动态 Workflow Compiler

首期 Compiler 只生成现有 `FlowSpec`，不新增通用图调度器。

~~~typescript
export interface WorkflowFeedbackSignal {
  readonly kind: string;
  readonly sourceRunId: string;
  readonly sourceNodeId?: string;
  readonly severity: "info" | "warning" | "failure";
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WorkflowCompileInput {
  readonly workflowType: "task-flow";
  readonly nextEpoch: number;
  readonly previous?: WorkflowRunGraph;
  readonly feedback: readonly WorkflowFeedbackSignal[];
  readonly catalogVersion: string;
  readonly allowedRoleIds: readonly string[];
  readonly budget: Readonly<{
    maxStages: number;
    maxChildren: number;
    maxLoopAttempts: number;
    maxParallelBranches: number;
  }>;
  readonly policyVersion: string;
}

export interface WorkflowChangeSet {
  readonly addedStageIds: readonly string[];
  readonly removedOptionalStageIds: readonly string[];
  readonly reassignedStages: readonly Readonly<{ stageId: string; from?: string; to: string }>[];
  readonly reasons: readonly WorkflowFeedbackSignal[];
}

export interface CompiledTaskWorkflow {
  readonly flow: FlowSpec;
  readonly compilerVersion: string;
  readonly inputDigest: string;
  readonly topologyDigest: string;
  readonly changeSet: WorkflowChangeSet;
}
~~~

### 6.1 编译策略

首期只允许确定性规则编译：相同规范化输入必须产生相同 `inputDigest`、`FlowSpec` 和 `topologyDigest`。LLM 可以在后续产生 proposal，但 proposal 必须经同一个确定性 validator 编译，不能直接发布。

推荐采用“模板 + 受限 patch”，而不是每轮从零生成：

- 可增加可选诊断、审核、分支或子任务；
- 可重分配尚未运行的 Stage Role；
- 可收窄并行度和循环上限；
- 可在证据明确时跳过声明为 optional 的 Stage；
- 不可删除 mandatory Stage；
- 不可引用 Runtime Catalog 之外的 Role；
- 不可突破编译预算；
- 不可写 tenant、principal、grant、Trust Policy 或 promotion authority。

### 6.2 发布与跨轮关系

Compiler 不预先制造 runId。编译结果经现有 Task 发布入口创建根 Task，服务器生成 Task ID 并盖章 delivery lineage；该 lineage 成为 Run ID。编译元数据可以放在根 Task payload 的独立 `workflow` 键中：

~~~typescript
{
  workflow: {
    type: "task-flow",
    epoch: 2,
    compilerVersion: "...",
    inputDigest: "...",
    topologyDigest: "...",
    previousRunId: "..."
  },
  flow: { ...existingFlowSpec }
}
~~~

`previousRunId` 只表达因果关系，不形成当前 DAG 的 dependency 回边。服务器发布入口必须忽略或覆盖调用方自报的 tenant、principal、lineage 和授权字段。

首期不建立通用自动反馈调度器。Optimizer、Trigger 或应用服务可以显式调用 Compiler；每个调用点必须声明自身 feedback policy。这样不会在尚未理解各循环终止条件前引入全局自动演化。

## 7. 事件关联与时效性

现有 ActivityEvent 增加可选、只读关联：

~~~typescript
workflow?: {
  type: WorkflowType;
  runId: string;
  epoch: number;
  nodeId: string;
  topologyDigest?: string;
  snapshotRevision?: string;
}
~~~

兼容规则：

- 字段全为 optional，旧生产者与消费者不受影响；
- producer 只能使用当前服务器上下文中的真实 task/run/worker 身份；
- ActivityHub ring buffer 只用于降低 UI 延迟；
- PostgreSQL 重投影定期校正 Activity 提示；
- SSE 断线后客户端必须先获取新 snapshot，再续接 live hint；
- `snapshotRevision` 落后或 `topologyDigest` 不匹配时丢弃旧 hint，不回写生产状态。

N30 的 RuntimeInterval 可由 WorkflowNode 派生；N31 不替代 N30 资源采样与 Freshness Contract。N30 继续展示时间和资源，N31 提供逻辑拓扑、阻塞边和跨轮因果。

## 8. 查询与控制边界

首期新增 tenant-scoped、read-only 查询：

```text
GET /api/v1/observe/workflows
GET /api/v1/observe/workflows/:type/:runId
GET /api/v1/observe/workflows/:type/:runId/events
```

要求：

- tenant 只从认证上下文派生；
- 列表有时间窗、状态、type、limit/cursor 边界；
- runId 必须与 type 一起解析，不做跨类型模糊查询；
- 原生状态和 warning 原样返回；
- 无法证明的边不显示为事实；
- 查询不得持有 DataWorldAccess 或数据库任意 SQL 能力，只依赖窄 read ports。

首期不提供统一控制 API。未来如增加 `retry/cancel/resume`，统一层只能把命令分发给原生 application service；它不得直接更新 task/intake/optimizer 表。每个响应必须返回 native CAS 结果和新的 read-model revision。

## 9. 安全与可靠性不变量

1. **Tenant 隔离**：每个 projector 查询在数据层带 tenant predicate；跨 tenant parent/deps 一律忽略并告警。
2. **无环**：每个 Run Graph 投影后执行拓扑校验；发现环时返回带 warning 的局部图，不修写原生数据。
3. **来源诚实**：每个边可带 nativeEvidence；推断边必须标记 detail，不得伪装成服务器盖章事实。
4. **不可逆历史**：completed node、attempt、revision 不被 patch 原地改写。
5. **权限不扩张**：Compiler 只使用服务器提供的 allowedRoleIds、预算和 policy snapshot。
6. **安全骨架固定**：Intake/Promotion/Human approval 等领域门不接受通用 Compiler patch。
7. **有界图**：查询限制最大 Run 数、节点数、边数和时间窗；超限返回截断 warning。
8. **确定性**：规范化排序、stable ID 和 digest 均有纯函数测试。
9. **失败隔离**：Projector、UI 或 SSE 故障不得阻塞原生执行器。
10. **无双写真相**：首期不保存第二套 authoritative Workflow 状态。

## 10. 分层交付

### U0：合同与纯投影

- 新增 workflow contracts；
- Task、Intake、Optimizer 纯 projector；
- stable ID、状态映射、无环与 digest 测试；
- 不接 API，不改生产事件。

验收：冻结 fixture 重排后 digest 不变；loop attempt 无回边；跨租户伪 parent 不产生边。

### U1：只读查询与 N30 接入

- 新增窄 read ports 和投影 application/query service；
- 注册 `/api/v1/observe/workflows` 查询；
- ActivityEvent 增 optional workflow ref；
- N30 使用 WorkflowNode/Edge 增强甘特图、阻塞和关键路径。

验收：当前 Task lineage、Intake Run、Optimizer suggestion 各至少一条真实 PG 投影；UI 断线重连以 snapshot 校正 live hint。

### U2：Task Workflow Compiler

- 纯规则 Compiler + validator；
- 输出现有 `FlowSpec`；
- 使用现有发布入口和 TaskResolver 执行；
- 保存编译摘要到根 Task payload；
- 固化两轮反馈产生不同 Flow 的回归。

验收：相同输入 byte-identical；不同反馈只改变允许项；非法 Role、预算超限、mandatory 删除全部 fail-closed；现有 Flow 回归不变。

### U3：有限反馈接线

- 选择一个低风险循环调用 Compiler，例如 optimizer 的复测任务；
- 反馈策略显式、版本化、有最大 Epoch 与停止条件；
- 下一轮发布记录 previousRunId；
- 可关闭并回退到静态 Flow。

验收：两 Epoch 使用不同 Revision，历史均可重投影；关闭开关后不再生成下一轮；重复终态事件不重复发布。

U0–U2 是“最小统一”范围。U3 只做一个低风险 canary，不把所有循环同时迁入。

## 11. 验收矩阵

| 类别 | 必须证明 |
|------|---------|
| Compatibility | 原 Task/Intake/Optimizer focused suites 全绿，schema 无迁移 |
| Projection | Task/Intake/Optimizer 三类 Run 均可投影 |
| DAG | 所有返回图无环；attempt/epoch 不使用回边 |
| Identity | delivery lineage 优先；跨 tenant/untrusted parent 不合图 |
| Determinism | 输入重排、重复读取均保持 topologyDigest 与 snapshotRevision |
| Truthfulness | native status 保留；缺失时间/边产生 warning |
| Freshness | snapshot 为事实；Activity 仅 hint；断线后重新快照 |
| Compiler | 相同输入同输出；反馈变化产生受限 changeSet |
| Guardrails | unknown Role、超预算、mandatory 删除均拒绝 |
| Native ownership | Projector/Compiler 无 repository 写权，不改变 Intake CAS |
| Rollback | U2/U3 开关关闭后现有静态 Flow 仍可运行 |

## 12. 被否决的替代方案

### 12.1 立即建设统一 DAG 执行引擎

否决。它要求同时重写 TaskResolver、Task waiting、Intake lease/CAS、Optimizer verify/deopt 与 Trigger；迁移面大，且容易把领域安全约束抽象掉。

### 12.2 把所有循环转成 Task Flow

否决。Task Flow 没有 Intake 的 revision、policy、lease generation、rowVersion 和原子 outbox 语义，也不应拥有 Promotion 权限。

### 12.3 新建 authoritative workflow_runs 表

首期否决。它会与 tasks/intake/suggestion 双写并产生一致性问题；只读 Projection 已能满足统一观测和动态编译验证。

### 12.4 让 LLM 每轮从零生成完整 DAG

否决。难以确定性重放、比较、预算和验证。LLM 后续只能提出受限 patch，确定性 Compiler/Validator 才能发布。

### 12.5 只在前端拼图

否决。前端无法证明 tenant、lineage、CAS 和 native status；统一投影必须由 PTH 服务端产生，页面只负责展示。

## 13. 后续边界

当且仅当 U0–U3 证明统一合同稳定，才重新评估：

- `FlowSpec` 是否需要显式 `dependsOn/join`；
- 是否需要持久 Workflow Definition/Revision；
- 是否把 governance proposal 纳入首等 Run；
- 是否让 LLM 产生 Graph Patch Proposal；
- 是否把 Source Expansion 或 Memory Responsibility 再平衡接入反馈；
- 是否提供统一控制 API。

这些都不是当前最小实现的隐含授权。
