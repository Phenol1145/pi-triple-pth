# N28：Role 谱系、记忆责任与 Worker 容量编排设计

> 日期：2026-08-18
>
> 状态：**可行性验证 GO**（n28-feasibility-report.md，envelope 已落盘）；生产化（持久化 lease / Region / outbox / 权重标定 / 重建）未开始
>
> 上位设计：[N16 角色/领域组合设计](./n16-v1.2-role-domain-composition-design.md)
>
> 关联设计：[N26 自主知识摄入](./n26-autonomous-knowledge-intake-design.md)
>
> 术语事实源：[CONTEXT.md](../../../CONTEXT.md)
>
> 实施计划：[N28 可行性优先实施计划](../plan/n28-role-memory-orchestration-implementation-plan.md)

## 0. 执行摘要

PTH 当前已经有 Role 谱系、同角色多副本、KnowledgeContext、KnowledgeBroker、Skill 两级展开和
ToolReg 工具面预算，但这些能力尚未组成一个可证明的“单 Worker 固定认知负载”系统：

- 类型树节点实际是角色定义，运行时却缺少稳定的 WorkerReplica 身份；
- `memoryScope=own|all` 把旧式访问过滤称为记忆域，不能表达可重叠责任区；
- 初始 KnowledgeContext、运行期 memory/knowledge 检索、Skill 和 Tool 各自限额，缺少任务级统一账本；
- 责任分区一旦成为硬过滤，就可能让责任区外但合法相关的知识不可达；
- N26 可以持续增加知识，但尚不能据此判断应该由哪个 WorkerReplica 维护、优先检索和消化。

本设计作出六项裁决：

1. **Worker Tree 正式解释为 Role Lineage。** Role Definition 是持久工作方式；WorkerReplica
   是运行实例。两者不再混称。
2. **记忆责任与角色谱系正交。** WorkerReplica 通过 Memory Responsibility 负责若干
   MemoryRegion；同角色副本可以分担不同区域，区域与责任都允许重叠。
3. **MemoryRegion 不复制正文。** 它是版本化逻辑选择器与索引单元；成员关系只保存引用或
   可重建投影。现有 setting/wiki/skill/log 四类记忆不变，Region 不是第五类记忆。
4. **责任不是授权。** tenant、space、status、Execution Grant 组成 Memory Visibility；所有
   扩检波次都先执行同一可见性过滤，责任区不得扩大权限。
5. **检索采用分层扩检。** primary → overlap → explicit fallback/unclassified → bounded global；因此错误绑定
   可以降低效率，但不能静默制造知识不可达。
6. **容量分为长期责任负载与任务认知负载。** 每个 WorkerReplica 的责任区域权重有硬上限；
   每次任务的 memory、Skill、Tool 工作集也由统一 Cognitive Budget 约束。

第一阶段只做一个窄集成 vertical slice，证明上述模型在真实 batch、KnowledgeContext/Broker
和 agent 工具面能够闭环。它不建新表、不做自动分区、不做 Role 自动分化，也不改变 N26 的
摄入、核验和晋升边界。只有全部可行性假设通过，才进入持久化与自动均衡设计。
由于该切片会接触 Broker、Context、TaskLoop 与 agent-loop，代码实施以 N27 R1–R6 最终复验
`ACCEPTED` 为硬前置。报告必须引用一个已经包含 R6 的 main commit，并明确写出 R1–R6 已合并；
仅有“R6 在验收车道执行”的旧元数据不满足 Gate 0。在此之前本文只冻结实验与 No-Go 条件。

## 1. 问题边界

### 1.1 要解决的问题

目标系统需要同时满足：

- 单个 WorkerReplica 长期承担的记忆责任负载稳定有界；
- 单次任务实际可见的记忆、Skill 和工具数量稳定有界；
- 同一 Role 的多个副本可以承担不同且重叠的 MemoryRegion；
- 知识正文只保存一份，不因分区或副本扩展而复制；
- 责任区命中不足时自动扩检，合法知识不会因编排错误而不可达；
- tenant、space、official status 和 grant 在任何 fallback 中都不被放宽；
- N26 新增的 official knowledge 能进入至少一个 Region 或显式 `unclassified` 区；
- 后续可以根据责任负载增加 WorkerReplica，而不是先制造新的 Role。

### 1.2 第一阶段非目标

可行性阶段明确不做：

- PostgreSQL Region、Responsibility 或 membership 表；
- membership transactional outbox 和重启恢复；
- embedding、向量库或真实语义检索精度优化；
- 自动发现、拆分、合并或迁移 Region；
- 自动创建、合并、退役 Role Definition；
- 长期 autoscaler、稳定性控制或成本最优调度；
- 修改 N26 Source/Intake/Verification/Promotion 状态机；
- 把实验阈值直接宣布为生产默认值。
- 在 N27 最终验收前合并任何 N28 运行时代码。

## 2. 领域模型

### 2.1 两张互相正交的图

PTH 同时维护两种关系，不能把它们压成一棵树：

~~~mermaid
flowchart LR
    subgraph RL["Role Lineage：工作方式如何分化"]
      O["origin"] --> A0["actuator"]
      A0 --> R["researcher"]
      R --> A["analyst"]
      A --> S["solver"]
    end

    subgraph MR["Memory Responsibility：运行副本当前负责什么"]
      W1["WorkerReplica A\nrole=researcher"] -->|primary| A["algebra region"]
      W1 -->|overlap| N["numerical-methods region"]
      W2["WorkerReplica B\nrole=researcher"] -->|primary| G["geometry region"]
      W2 -->|overlap| N
      E["one memory entry"] -.membership.-> A
      E -.membership.-> N
    end
~~~

Role Lineage 稳定表达“怎么工作”。Memory Responsibility 随负载、覆盖和副本生命周期变化，
表达“当前优先负责哪块记忆”。同一 Role 的副本不需要为不同记忆区域复制 Role Definition。

### 2.2 核心契约

首个可行性切片采用以下逻辑契约；字段名是后续实施计划的统一接口：

~~~typescript
export interface RoleDefinitionRef {
  roleId: string;
  revision: string;
}

export interface WorkerReplicaRef {
  /** 全系统唯一 UUID；batchId 只表达宿主生命周期，不参与消歧。 */
  workerId: string;
  batchId: string;
  role: RoleDefinitionRef;
}

export interface MemoryRegionSelector {
  domains?: readonly string[];
  memoryTypes?: readonly MemoryType[];
  kinds?: readonly string[];
  anchorsAny?: readonly string[];
  anchorPrefixes?: readonly string[];
}

export type MemoryType = "setting" | "wiki" | "skill" | "log";

export interface MemoryRegion {
  regionId: string;
  revision: number;
  mode?: "selector" | "unclassified";
  selector: MemoryRegionSelector;
  estimatedWeight: number;
}

export type MemoryResponsibilityKind = "primary" | "overlap" | "fallback";

export interface MemoryResponsibility {
  workerId: string;
  regionId: string;
  regionRevision: number;
  kind: MemoryResponsibilityKind;
  priority: number;
  epoch: number;
}

export interface ResponsibilityCapacity {
  maxRegions: number;
  maxPrimaryWeight: number;
  /** overlap 与 fallback 都计入，避免非主责任绕过固定负载。 */
  maxSecondaryWeight: number;
}

export interface CognitiveBudget {
  maxMemoryEntries: number;
  maxMemoryChars: number;
  maxSkillIndexEntries: number;
  maxActiveSkills: number;
  maxSkillChars: number;
  maxTools: number;
}

export interface WorkerLoadEnvelope {
  responsibility: ResponsibilityCapacity;
  task: CognitiveBudget;
}
~~~

`RoleDefinitionRef.revision` 在可行性切片中由规范化 Role Definition 内容摘要派生；无关的
Discipline Catalog 或其他 Role 变化不得改变它。首版不要求现有
`WorkerRole` 存储结构立即迁移。`WorkerRole` 可以暂时保留为兼容别名，但新代码只使用
Role Definition / WorkerReplica 术语。

Selector 的语义固定为“组间 AND、组内 OR”：`domains` 只读取条目 `meta.domains` 中经 Catalog
验证的 DomainId，`memoryTypes` 读取 `DirectoryEntryInput.memoryType`，`kinds` 读取条目 kind，anchor
条件只读取 anchors；不得用任意 anchor 冒充 DomainId，也不得临时从 kind 猜测四类记忆。
空 selector 非法，只有系统生成的 `region:unclassified` 可以没有 selector。

### 2.3 四类记忆与 Region 的关系

现有记忆本体仍是：

| 类型 | 语义 |
|---|---|
| setting | 系统不可变核心档案 |
| wiki | 术语与定义 |
| skill | 可执行程序知识与 SOP |
| log | 运行经历、审计与任务洞察 |

MemoryRegion 可以跨越这些类型，也可以只选择其中一种。例如数学区域可以包含 wiki 定义、
domain-method、skill 和 task-insight。Region 是“谁优先负责及从哪里先找”的视图，不改变条目的
kind、生命周期、证据或可见性。

## 3. WorkerReplica 与 Role Lineage

### 3.1 身份不变量

- Role Definition 具有稳定 `roleId + revision`，可被多个副本引用；
- WorkerReplica 具有全系统唯一 UUID `workerId`；`batchId` 只标识宿主生命周期，不参与责任寻址；
- task routing/claim 仍按 `roleId`，具体执行身份、heartbeat、audit 和控制按 `workerId`；
- 同一 WorkerReplica 一次最多执行一个任务；
- pause/remove 一个 WorkerReplica 不得影响同 Role 的其他副本；
- busy replica 的 remove 必须先进入 draining，任务 `finally` 完成后由同一 slot 状态机停止下一轮、
  释放 kernel 并从 slot 集合移除；不能只把内存状态改成 `stopped`；
- Execution Grant 的 principal 使用 `worker:<workerId>`，role 仍以角色声明单独携带；
- Role Lineage 的 parent 表达派生来源，不表达副本、负载或 MemoryRegion。

### 3.2 为什么第一阶段不改 TaskLease 持久化

可行性验证需要证明运行时身份和责任编排成立，但不需要立即修改 PG task schema。首个切片让
batch、TaskLoop、audit、heartbeat 和 Execution Grant 携带 `workerId`，TaskLease 的路由与 CAS
仍按现有 `roleId` 工作。若 H1 通过，生产化阶段再把 WorkerReplica identity 纳入持久 lease 和
恢复协议，避免在模型未证实前扩大 migration 面。

## 4. MemoryDirectory 与成员关系

### 4.1 Directory Snapshot

MemoryDirectorySnapshot 是不可变、确定排序的 Region/Responsibility/membership 视图。可行性
阶段用内存构建器生成，输入相同则 snapshot ID、成员关系和 Region weight 必须完全相同。
构建器以固定 `tenantId + epoch` 工作，并接收本快照有效的 `WorkerReplicaRef[]`。它拒绝负数/NaN
权重、重复 Region、未知 revision、同一 worker/Region 重复责任、指向无效副本的责任、epoch
不匹配以及没有有效 primary owner 的 Region。责任到期时间留到生产化
租约设计，不在可行性接口中放一个未执行的可选字段。

可行性阶段责任的有效期定义为 `Directory epoch ∩ WorkerReplica batch lifetime`：epoch 更新或副本
退出即失效。生产化若需要跨 batch 续租，再新增持久 lease/expiry；本轮不放一个无人执行的时间戳。

~~~typescript
export interface RegionMembership {
  tenantId: string;
  entryId: string;
  entryRevision: number;
  contentHash: string;
  indexHash: string;
  regionIds: readonly string[];
}

/** 由 tenant-scoped repository/projection 提供；revision 不得从松散 meta 猜测。 */
export interface DirectoryEntryInput {
  entry: KnowledgeMemoryEntry;
  revision: number;
  memoryType: MemoryType;
}

export interface MemoryDirectorySnapshot {
  tenantId: string;
  epoch: number;
  snapshotId: string;
  corpusFingerprint: string;
  workers: readonly WorkerReplicaRef[];
  regions: readonly MemoryRegion[];
  responsibilities: readonly MemoryResponsibility[];
  memberships: readonly RegionMembership[];
  unclassifiedEntryIds: readonly string[];
}
~~~

一个 Directory Snapshot 只属于一个 tenant；成员关系保存条目复合身份、revision、content hash 与
`regionId[]`，但不保存正文。跨域条目可以命中多个 Region，条目正文仍只有一份。
`DirectoryEntryInput.entry.tenantId` 与 `revision` 必须分别来自 repository 的顶层租户字段和正整数
版本；缺失、非整数或与冻结输入不一致均 fail-closed，不允许把 tenant 复制进 meta，也不允许以
`meta.version ?? 1` 补造。`memoryType` 由 Knowledge 边界的规范化分类投影提供，本切片不另造
kind→四类记忆的第二套真相。
任何 official 条目若未命中声明 Region，必须进入虚拟 `region:unclassified` 并产生 coverage 信号；
该虚拟 Region 必须显式出现在 `regions[]` 并有 primary 责任人，不允许静默消失。所有非虚拟
Region 也必须至少有一个 primary 责任人；跨 tenant 条目不能进入同一 snapshot。

### 4.2 责任容量

可行性阶段使用可解释的估算权重，而不是宣称生产成本模型已经确定：

~~~text
regionWeight = entryCount + ceil(totalContentChars / 4096) + selectorClauseCount
~~~

一个 WorkerReplica 的 primary、secondary（overlap + fallback）和 Region 数分别对照
ResponsibilityCapacity。分配超限
时必须 fail-closed；编排器应增加副本或重新划分 Region，而不是静默扩大上限。该公式只用于
验证容量门能够工作，Go 之后才使用实际索引字节、查询延迟和摄入速率校准。

## 5. 分层检索

### 5.1 Retrieval View

一次任务冻结 Directory Snapshot，并为当前 WorkerReplica 生成 Retrieval View：

~~~text
Wave 0  primary responsibilities
Wave 1  overlap responsibilities
Wave 2  explicit fallback + unclassified regions
Wave 3  bounded global official search
        → merge → dedupe → rank → Task Working Set
~~~

每一波都执行相同的服务端授权谓词：

~~~text
tenant == grant.scope.tenantId
AND status == official
AND space is visible from grant.scope.space
AND requested operation is included in grant.capabilities
~~~

责任区仅改变搜索顺序。已知 entry ID 的 `get(id)` 不受责任区限制，但仍必须通过上述授权。

### 5.2 扩检与停止条件

生产化最终可以在同时满足以下条件时提前停止：

- 已得到足够候选；
- 至少一个候选达到相关性阈值；
- 没有目录滞后、冲突或明确的低置信度信号；
- 候选仍可在 Cognitive Budget 内形成工作集。

但可行性切片为避免局部诱饵造成伪阳性，固定执行全部四个有界波次，再统一 merge、dedupe 和 rank；
早停优化不在本轮验收范围。每个 wave port 必须先应用 Region 与 query 条件，再执行 limit，并明确
返回 `completeForQuery`；否则结果必须标记 `retrieval-incomplete`，不能伪装成无知识。

零命中、低相关性、错误绑定或 `unclassified` 目标都必须进入下一波。可行性模式下 Directory/provider/
authorized-read 任一不可用都在首次 LLM 调用前返回 `retrieval-failed`；不得悄悄退回旧 raw path。
若生产化以后允许 global-only 降级，必须使用显式 sentinel snapshot 与同一授权/预算链，不能用缺失依赖
表示。成功穷尽且无命中返回
`exhausted-empty`；目录或后端失败返回 `retrieval-failed`；候选截断且完整性未知返回
`retrieval-incomplete`，三者不得都表现为一个空数组。

### 5.3 Retrieval Trace

~~~typescript
export interface RetrievalWaveTrace {
  wave: 0 | 1 | 2 | 3;
  regionIds: readonly string[];
  candidateCount: number;
  visibleCount: number;
  selectedCount: number;
  scannedCount: number;
  completeForQuery: boolean;
  reason: string;
}

export interface PendingRetrievalTrace {
  directorySnapshotId: string;
  workerId: string;
  queryFingerprint: string;
  waves: readonly RetrievalWaveTrace[];
  globalFallback: boolean;
  omitted: Readonly<Record<string, number>>;
  status: "found" | "exhausted-empty" | "retrieval-incomplete" | "retrieval-failed";
}

export interface RetrievalTrace extends PendingRetrievalTrace {
  traceId: string;
  callIndex: number;
}
~~~

Retriever 只产生 `PendingRetrievalTrace`；任务账本在录入时按任务内调用顺序分配 `callIndex`，并由
`taskId + directorySnapshotId + workerId + queryFingerprint + callIndex` 生成稳定 `traceId`。完成后的
`RetrievalTrace` 是可行性判断和后续自动均衡的观测面，不是新的知识或授权事实源。

## 6. Cognitive Budget 与 Task Working Set

### 6.1 两个时间尺度

| 时间尺度 | 受限对象 | 何时检查 |
|---|---|---|
| WorkerReplica 生命周期 | Region 数、primary weight、overlap weight | 分配、续租、重平衡前 |
| 单次任务 | Memory entries/chars、Skill index/active/chars、Tool face | 任务开始冻结及每次按需展开时 |

系统上限与 Role 声明同时存在时取更严格值；Role 或 WorkerReplica 不能自行扩大系统上限。

### 6.2 Task Working Set

~~~typescript
export interface TaskWorkingSetPolicy {
  taskId: string;
  worker: WorkerReplicaRef;
  directorySnapshotId: string;
  budget: CognitiveBudget;
  skillIndexIds: readonly string[];
  toolNames: readonly string[];
}

export interface TaskWorkingSet {
  taskId: string;
  worker: WorkerReplicaRef;
  directorySnapshotId: string;
  memoryEntryIds: readonly string[];
  skillIndexIds: readonly string[];
  activeSkillIds: readonly string[];
  toolNames: readonly string[];
  usage: {
    memoryEntries: number;
    memoryChars: number;
    skillIndexEntries: number;
    activeSkills: number;
    skillChars: number;
    tools: number;
  };
  omitted: Readonly<Record<string, number>>;
  retrievalTraces: readonly RetrievalTrace[];
}
~~~

任务开始时冻结的是 TaskWorkingSetPolicy：Directory snapshot、预算、Skill 索引候选和 Tool face
在本任务中不再变化。Task Working Set 本身随合法的 memory/knowledge 展开和 `skills.get` 单调增长，
每次增长都先消费同一个任务账本，并可随时导出确定性 snapshot。初始 KnowledgeContext、后续
memory/knowledge 展开、`skills.list/get` 和静态+ToolReg 工具面都使用这一本账。基础 pinned tools
也计入 `maxTools`；如果 pinned tools 自身已超限，任务在调用 LLM 前失败，而不是把超额隐藏到
“系统工具”。

每次实际暴露 Memory/Knowledge 结果时，都把对应的 `PendingRetrievalTrace` 交给同一任务账本完成编号；
`TaskWorkingSet.retrievalTraces` 按调用序号保存不可变 trace（仅 ID、计数、wave 与状态，不含正文）。
初始 KnowledgeContext 是第一条，后续 `memory.retrieve` 各追加一条；`get`/已知 ID 展开不伪造检索 trace。

`maxMemoryChars` / `maxSkillChars` 计的是实际返回给 agent 或注入 prompt 的规范化序列化投影，
不是只计正文：Memory 投影包含 id、summary/content、会暴露的 evidence/meta；function recall 包含
key、source 与 spec；Skill 包含实际返回的 `MemoryEntry` 投影。metadata-only 行也按其投影字节计费。
同 ID 从摘要展开到全文只补收规范化投影的正差额。无法稳定投影或投影超限的结果在暴露前拒绝，
避免用巨大 metadata/spec 绕过字符预算。

可行性阶段使用以下实验预算：

~~~typescript
export const N28_FEASIBILITY_BUDGET: WorkerLoadEnvelope = {
  responsibility: {
    maxRegions: 3,
    maxPrimaryWeight: 80,
    maxSecondaryWeight: 40,
  },
  task: {
    maxMemoryEntries: 8,
    maxMemoryChars: 4096,
    maxSkillIndexEntries: 8,
    maxActiveSkills: 4,
    maxSkillChars: 8192,
    maxTools: 16,
  },
};
~~~

这些数值是实验常量，不进入生产配置默认值。

## 7. 可行性切片架构

### 7.1 真实接入点

切片必须接入以下现有生产类，而不是复制一套评测算法：

- batch 的生产 slot/controller 组件：生成 WorkerReplicaRef，并在 heartbeat/control/remove-cleanup 使用
  workerId；`batch-process.ts` 与有限生命周期测试/评估器必须调用同一组件；
- TaskLoop / AgentTaskRunner：携带 replica，冻结本任务 Working Set；
- KnowledgeContextProvider：按同一个 layered retriever 生成初始上下文；
- KnowledgeBroker：运行期 search 使用同一个 layered retriever 与授权过滤；
- agent-loop：LLM 实际收到的 tool schemas 必须等于 Working Set；
- `skills.list/get`：实际 facade 必须执行同一个 Skill 预算；
- memory/knowledge facade：所有返回计入同一个任务账本。

### 7.2 可替换部分

可行性阶段允许使用：

- 纯内存 Directory Snapshot；
- 确定性 MemoryEntry/Skill/Tool fixture；
- 记录 prompt 和 tool schemas 的 stub LLM；
- 现有 anchor/kind/queryText 排名；
- 无持久化的 responsibility assignment。

这些 stub 只替代外部数据与长期状态，不得替代要验证的运行路径、授权检查、预算器或 agent 暴露面。

## 8. 可行性假设与判定阈值

| 假设 | Go 条件 | No-Go 条件 |
|---|---|---|
| **H1 Role/Worker 可分离** | 同一 Role 的两个副本具有不同 workerId、相同 role ref；通过 batch 实际消费的共享 slot/controller 可独立 pause/remove（含 busy remove 收尾）；heartbeat、audit 和 grant 能定位实例 | 任一关键运行身份仍只能用 roleId 表达，控制一个副本影响同 Role 其他副本，或停止状态没有释放 slot/kernel |
| **H2 Region 可重叠且不复制正文** | 100 条授权 fixture 覆盖 `setting/wiki/skill/log` 四类且全部属于声明 Region 或 `unclassified`；跨域条目命中至少两个 Region；所有 primary owner 都是快照中的有效副本；entry 数不因 membership 增加 | 任一 MemoryType 未进入投影、任一条目静默无区域、责任指向无效副本、revision/hash/epoch 校验失效，或为重叠复制正文 |
| **H3 错误绑定不造成不可达** | 12 个冻结 gold query 全部召回目标，覆盖 primary、overlap、局部诱饵后的 global-only、unclassified；每个成功 gold case 都完整执行四个有界波次且每波声明 query 完整性 | 任一目标因责任绑定错误不可达、少执行波次、候选截断被误报成无知识，或只有无界 retrieve 才能找到 |
| **H4 授权在 fallback 中不变** | 通过真实 Broker/Context 与统一 `isVisible` 覆盖跨租户、public 祖先/子空间、private 同/异空间、draft、archived；泄漏为 0，invalid/expired/missing-capability grant 调用 wave port 为 0 | 任一 fallback 或 get/query/retrieve/recall 旁路返回越权条目，或鉴权失败后仍触发检索后端 |
| **H5 统一预算是硬上限** | 1,000 组确定性生成输入均满足责任权重、memory、Skill、Tool 全部上限；对实际序列化投影计费，摘要到全文只补收差额；两个独立 ledger 在重排输入下输出与 omitted trace 相同 | 任一轴超限、排序不确定、metadata/spec 不计费、同 ID 展开免费或存在旁路 |
| **H6 工作集真实进入 agent 面** | stub LLM 看到的 memory 摘要、Skill facade、tool schemas 与冻结 Working Set 完全一致，集合外调用被拒绝 | 预算器只生成报告，但 agent 仍能看到或调用全量 Skill/Tool/Memory |

### 8.1 直接 No-Go 条件

以下任一项出现即停止生产化，不以总分抵消：

1. fallback 产生 tenant、space、status 或 grant 泄漏；
2. gold 条目因责任区绑定错误不可达；
3. agent 实际可见面绕过统一预算；
4. 同 Role WorkerReplica 不能独立寻址；
5. 相同输入和 snapshot 产生不同 Retrieval View 或 Working Set；
6. 为实现重叠责任而复制知识正文。
7. Directory 复合租户身份、entry revision/content hash、primary owner 或 epoch 校验不成立；
8. 检索失败、未完整与合法 no-answer 无法区分。
9. invalid/expired/missing-capability grant 仍触发任何检索 wave；
10. 正向 gold case 未执行完整四波，或 H1 只验证测试替身而未验证 batch 实际消费的控制组件；
11. 实际暴露的 Memory/Skill 规范化投影超过字符预算，或 busy-remove 后 slot/kernel 未释放。

### 8.2 Go 后的下一步

只有 H1–H6 全部通过，才进入生产化修缮：

1. 建立 Region、Responsibility 和 membership 的 PG revision/CAS 模型；
2. 用 transactional outbox 更新 membership 投影并支持旧 snapshot 并行读取；
3. 将 workerId 纳入 TaskLease、恢复与审计的持久协议；
4. 使用真实 corpus 的索引字节、检索延迟和摄入速率校准权重；
5. 实现 make-before-break 的 Region 重平衡与 WorkerReplica 扩缩容；
6. 最后才评估持久工作方式差异是否足以提出 Role 分化。

若任一假设失败，先修改模型并重新执行同一冻结实验；不直接进入数据库或自动扩缩容实施。

## 9. 与 N16、N26 的关系

- N16 的 Operational Role × Discipline Scope × KnowledgeContext × Capability Grant 保持成立；
  MemoryRegion 使用 domain 作为选择器之一，但不会把 Discipline 物化为 Role。
- N26 Knowledge Intake 继续负责 source → revision → candidate → official。official 条目完成晋升后，
  生产化阶段才通过 durable projection 更新 Region membership。
- spider、researcher、memory-keeper 等仍是处理阶段所需 Role Definition；它们不拥有 Directory
  或 Responsibility 的权威状态。
- 人类仍是唯一 Source Trust 授予者；自动责任分配不能扩大来源信任、Memory Visibility 或工具权限。

## 10. 决策记录策略

可行性切片不创建持久 schema，全部新接口都可通过依赖注入关闭，因此先以本设计记录裁决，
不新增 ADR。若 H1–H6 全部通过并准备把 WorkerReplica identity 与 Memory Responsibility 写入
持久契约，再建立 ADR，冻结以下难逆决策：

- Role Lineage 与 WorkerReplica 生命周期分离；
- Memory Responsibility 与 Memory Visibility 分离；
- 重叠 Region 不复制正文且检索保留有界全局兜底。
