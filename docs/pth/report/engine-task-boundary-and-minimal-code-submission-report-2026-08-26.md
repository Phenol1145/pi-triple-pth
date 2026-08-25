# FRACTA Engine 任务边界与 Code 层最小提交能力复审报告

> 状态：**已裁决（V1 任务能力范围）**  
> 日期：2026-08-26  
> 代码基线：`116be53`（`pi-triple-pth/main`）；外部边界基线：`3ed14e5`（`dsh-pth-interface/main`）  
> 工作类型：架构复审、领域边界与基础版本范围裁决；本报告不实现代码  
> 上位约束：[仓库定位矩阵](../../POSITIONING.md)、[FRACTA engine 领域词汇](../../../CONTEXT.md)、[ADR-0004：TCE 的 C 是 Code](../../adr/0004-tce-code-layer-ptc-capability-first.md)  
> 关联设计：[任务生命周期与上下文](../design/task-lifecycle-and-context-design.md)、[W8 任务派发](../design/w8-task-dispatch-design.md)、[网络信息基础设施 V1 报告](./network-information-foundation-v1-architecture-report-2026-08-26.md)  
> 被复审材料：[多角色共享任务设计](../design/task-logic-multi-role-collaboration-design.md)、[多角色共享任务实施方案](../plan/task-logic-multi-role-collaboration-implementation-plan.md)

## 0. 执行摘要

本轮复审的核心问题是：FRACTA engine 已经拥有角色化 worker、任务树、并发、租约、重试、
暂停、结果回流和分层监控后，是否还应在 PTC Code 层增加 `tasks.fanout`、participant、barrier
以及通用任务管理能力。

结论是：**不应。**

正确的系统边界是：

```text
用户真实需求
  ↓
外部 Agent 应用（例如 dsh-pth-interface）
  ├─ 对话与必要澄清
  ├─ 冻结根目标、范围、约束与验收标准
  └─ 编译 Entry Task Submission
  ↓
FRACTA engine
  ├─ 入口路由与角色化 LLM 推理
  ├─ worker replica、claim、lease、retry、pause、cancel
  ├─ 持久任务树、结果回流与 transcript
  └─ 每个 RoleRun 内运行 TCE Code
          ↓
      Code 组合已授权 typed capabilities
          ↓
      Execute 路由到 loop、任务服务或外部执行面
```

本报告作出以下十二项裁决：

1. **外部 Agent 应用负责用户需求编译。** 它面向用户，不承担 engine 内部 worker 编排。
2. **FRACTA engine 是 LLM inference engine。** 角色、replica、任务树和完整生命周期必须继续归
   engine 所有，不能迁到外部应用或 Code。
3. **TCE Code 是单个 RoleRun 的能力组织语言。** 它表达“当前 worker 还需要完成什么工作”，
   不是第二套任务控制面或用户级 workflow engine。
4. **Code 只需要一个持久化子任务委派能力。** 沿用 `tasks.delegate`，明确它是当前 RoleRun 在
   授权范围内委派直接子任务；不要用 `submit` 混淆外部 Entry Task 发布与内部 delegation。
5. **委派不能只是 fire-and-forget。** Engine 必须原子建立 required dependency、将父任务置为
   不可认领的等待态、释放 lease、可靠回流结果、重新唤醒父 RoleRun，并保证重放收敛。
6. **Code 不获得通用任务管理能力。** 不向普通 worker 暴露 list、poll、claim、lease、retry、
   requeue、reprioritize、任意 cancel、worker/replica 控制或跨 lineage 访问。
7. **基础版不实现 `tasks.fanout`。** 多次持久化子任务提交已经能够表达动态并行，而且允许同一
   role 承接多个不同检索分支，更适合高广度网络研究。
8. **基础版不实施 participant schema。** 不改变多 role tag 的现有歧义校验，不创建
   `task_participants`，不扩展 Flow/Trigger。
9. **语言负责声明与分支，engine 负责生命周期。** TypeScript 可用数组、循环和条件逐项声明；
   不能把跨 RoleRun 等待伪装成普通内存 `Promise`。未来 Python 等宿主投影同一能力契约。
10. **现有 L1–L3 监控继续复用。** 不增加 fan-out 专用 GuardRegistry 或第四层 watchdog；但提交
    仍须进入现有资源预算与 admission，增加 per-parent/per-lineage 上限以防队列爆炸。
11. **幂等、CAS、原子终态和 lineage 盖章不是“新护栏”。** 它们是 durable submission 成立所
    必需的协议不变量，必须在写入和状态迁移路径同步保证。
12. **复杂研究逻辑仍然后置。** V1 只钉任务边界与提交原语；ResearchPlan、EvidenceLedger、
    Claim–Citation Graph、自动停止和研究产品工作流留到后续版本。

一句话结论：

> **当前最小而完整的演进，不是给 Code 增加任务管理器，而是把现有 `tasks.delegate` 提升为
> 可幂等重放、可恢复、由 engine 托管依赖与结果信封的持久化子任务委派原语。**

## 1. 复审背景：此前混淆了哪两个层次

此前的多角色共享任务建议隐含了以下理解：

```text
用户需求
  → Code 决定完整多角色拓扑
  → engine 只按 Assignment 执行和限制并发
```

这不符合项目的真实产品模型。正确理解是：

```text
用户需求
  → 外部 Agent 编译 Entry Task
  → engine 执行角色化推理
  → 某个 RoleRun 在 Code 中决定是否继续派生子任务
  → engine 可靠执行并回流这些子任务
```

这里存在四种不能混用的“编排”：

| 概念 | 输入 | 输出 | 所有者 |
|---|---|---|---|
| 用户需求编译 | 模糊、会话化的 User Request | 自包含 Entry Task Submission | 外部 Agent 应用 |
| 推理编排 | 已编译 Task、role、历史 observation | RoleRun、子任务树、最终结果 | FRACTA engine |
| 能力编排 | 当前 RoleRun 的目标与已授权能力 | PTC Code 及 capability calls | Code |
| 执行路由 | 已审核的 capability call | loop 状态变化或外部副作用 | Execute / capability implementation |

外部应用编译的是 **engine 可消费的入口任务**，并不预先替 engine 写完整的内部任务图；Code
声明的是 **当前任务还需要派生什么工作**，并不接管任务队列和生命周期。

## 2. 仓库事实审计

### 2.1 `dsh-pth-interface` 是用户侧需求编译与操作应用

`dsh-pth-interface@3ed14e5` 提供了明确的外部边界证据：

- `README.zh.md:5-13` 把 interface-mode Agent 限定为只持有 `pth_*` 工具，无 shell、文件、网络
  或子代理能力；
- `profiles/headless/cordis.patch.yml:21-85` 逐项关闭 bash、fs、goal、plan、subagent、workflow
  和 web 等模型工具；
- `lib/index.js:248-253` 要求任务文本包含背景、约束、验收标准和结果字段，并保持自包含；
- `lib/index.js:280-309` 的 `pth_submit` 只把 `title/text/tags` 发布到 PTH HTTP API；
- `lib/index.js:114-200` 把一个 PTH taskId 投影成一个 dsh background job，并由非模型 watcher
  完成状态通知。

因此，dsh background job 只是用户体验投影，不是第二套调度器。产品层面，interface Agent 的
职责应被描述为：

> **User Request → Entry Task Submission 的会话式编译器与生命周期代理。**

当前实现仍然是薄编译器：它只产生 `title/text/tags`，还没有独立 `goal`、结构化验收契约或正式
版本化的 Entry Task schema。这是 interface 的后续完善方向，但不能因此把需求编译职责塞回
engine。

### 2.2 FRACTA engine 拥有角色化推理和任务生命周期

[仓库定位矩阵](../../POSITIONING.md)已经规定，engine 是 worker implementation 与 LLM-facing
interface 的唯一宿主。当前代码也具备：

- role × replica 的 worker 执行单元；
- 每角色副本与全局 worker 数限制；
- TaskLoop 并发认领；
- task leaseId、单调 generation、deadline 和过期回收；
- retry、pause、answer、递归取消；
- delegate/await/resume 形成的持久任务树；
- task、worker、进程、数据库和容器的分层观测。

这意味着“多角色推理”已经是 engine 的内生能力。Code 可以触发一个新的子任务，但不应该决定
claim 方式、租约世代、重试次数、worker 副本或容器调度。

### 2.3 PTC Code 当前已经是窄能力面

[任务生命周期设计](../design/task-lifecycle-and-context-design.md)记录了当前四个相关原语：

| 原语 | 当前语义 | 本报告判断 |
|---|---|---|
| `tasks.delegate` | 异步创建 durable child，立即返回 taskId | 保留并增强为持久化委派 |
| `tasks.await` | 登记直接子任务等待，释放父 lease，等待事件回流 | 语义保留，逐步收入 runtime |
| `tasks.resume` | 父重跑后读取 waiting/results/questions 快照 | 兼容保留；目标态由委派回执返回有界快照 |
| `tasks.answer` | 父任务回答直接 child 的暂停问题 | 保留为窄消息闭环，不算通用任务管理 |
| `tasks.penetrate` | 已注册边上的同进程嵌套子 agent 性能捷径 | 非基础能力，后置评估 |

同一文档还明确：通用 `tasks.peek/submit` 已从 PTC 窄端口摘除；服务端的 publish/cancel/list/get
和 HTTP 控制面与 Code 能力面是不同边界。这个既有裁决应继续坚持，而不是以 fan-out 名义重新把
任务控制面暴露给模型。

### 2.4 当前等待协议为什么显得像“管理 API”

当前 `tasks.await/resume` 并非传统轮询，而是对“程序没有断点续跑”这一实现限制的显式补偿：

1. `delegate` 创建子任务并返回 taskId；
2. `await` 发现子任务未终态时登记 `dispatchWait`，抛出 suspension；
3. runner 将父任务放回 pending 并释放 lease；
4. child terminal event 由 notifier 写入父任务 `childResult`；
5. 父任务重新认领，从头运行；
6. 程序调用 `resume()` 读取结果并避免重复派生。

这一机制的目标方向是事件驱动和不占 worker 等待；但当前实现把父任务立即放回 `pending`，候选
查询又未排除带 `dispatchWait` 的任务，存在反复 claim 并耗尽 attempt 上限的风险。目标态必须有
不可认领的 `waiting_dependency`（或等价持久谓词），由依赖满足后再转回 pending。管理仪式可以
从 LLM 可见面隐藏，但 engine 内部的依赖、挂起、回答、回流与恢复状态机不能删除。

## 3. 统一领域模型

### 3.1 规范术语

| 术语 | 定义 | 权威所有者 |
|---|---|---|
| User Request | 用户在会话中的真实意图，允许不完整和上下文相关 | 外部 Agent 应用 |
| Entry Task Submission | 外部 Agent 编译出的自包含入口请求 | 外部 Agent → engine |
| Task | engine 内可持久化、可路由、可追踪的推理工作单元 | engine |
| Child Task Submission | 当前 RoleRun 声明需要派生的 durable child | Code → engine |
| Task Dependency | 父任务与 required child 之间的持久依赖 | engine |
| RoleRun | 某个 role 对某 Task 的一次推理运行 | engine |
| Attempt | 由 lease 隔离的一次可重试执行尝试 | engine |
| Worker Replica | 为某 role 提供 RoleRun 并发容量的运行单元 | engine |
| Task Observation | 注入后续 RoleRun 的 child result、failure 或 publisher question | engine → Code |
| Capability Call | Code 对当前 role 已获授 typed capability 的调用 | TCE |

必须避免以下混用：

- Task 不是原始 User Request；它是应用层编译后的 engine 输入。
- Task 也不是传统 queue job；它包含 LLM inference lifecycle 和结果语义。
- Role 不是 Assignment；同一 role 可以处理多个不同 child tasks。
- Worker Replica 不是外部 Agent，也不等于 batch 进程。
- Child Task Submission 不是任务管理；它只声明新的工作需求。
- Code 不是第二套 workflow engine。

### 3.2 边界责任矩阵

| 能力 | 外部 Agent | Engine | PTC Code | Execute / implementation |
|---|---:|---:|---:|---:|
| 用户对话与澄清 | 主责 | — | — | — |
| 编译入口目标、约束与验收 | 主责 | 校验 | — | — |
| 选择入口角色 | 声明/建议 | 权威校验 | — | — |
| 内部子任务派生 | — | 授权与持久化 | 声明 | — |
| claim、lease、retry | — | 主责 | 不可见 | — |
| 父子依赖与结果回流 | 展示 | 主责 | 消费 observation | — |
| 研究查询与下一步策略 | — | 承载 | 主责 | 不决定 |
| provider、凭据与 egress | — | 授权上下文 | 不可见 | 主责 |
| 用户取消与回答 | 发起/展示 | 权威执行 | 仅接收相应 observation | — |
| 任务与运行状态展示 | 主责 | 权威状态源 | — | — |

## 4. 方案比较

### 4.1 方案 A：Code 获得通用任务管理面

能力可能包括 submit、list、status、poll、retry、cancel、reassign、priority、fanout、barrier 和
participant 管理。

优点是表达显式，模型可以自行控制几乎全部生命周期。缺点是：

- 复制 engine 已有的状态机和控制面；
- 迫使模型理解 lease、retry、终态竞态和取消传播；
- 容易诱导轮询，浪费 RoleRun 步数和 token；
- 扩大跨 lineage 越权与误取消风险；
- TypeScript、Python 等每个宿主语言都要复制同一套管理 API；
- 工具面扩大，违背 capability interface first 与最小信息原则；
- Code 和 dispatcher 可能同时操作状态，形成双主。

**裁决：否决。**

### 4.2 方案 B：只有 fire-and-forget 提交

Code 创建 child 后只拿 taskId，父任务可以立即结束，不建立 durable dependency。

优点是接口最小。缺点是父角色无法可靠综合子结果；父任务终态后 notifier 会拒绝回写，深度研究
只能退化成互不关联的后台任务。

**裁决：不完整。** 仅适合明确 detached 的通知型工作，不应成为默认语义。

### 4.3 方案 C：持久化子任务提交，生命周期由 engine 托管

Code 只调用一个子任务委派能力；engine 自动建立 required dependency、处理挂起与重跑、让重复
delegate 返回当前结果信封，并阻止父任务提前终态。

优点是：

- 保留最小 Code 表面；
- 保留 engine 对任务生命周期的单一所有权；
- 允许 LLM 用普通语言控制流动态组织多次提交；
- 同一 role 可以承担任意多个不同子问题；
- 支持深度研究的“观察结果后再决定下一轮”；
- 可以复用现有 delivery、lease、notifier、取消和监控机制。

代价是需要补齐委派幂等、required dependency、持久等待、结果信封和恢复扫描。

**裁决：推荐。**

## 5. 为什么 `tasks.fanout` 不属于基础版本

`tasks.fanout` 真正独有的语义只有：

1. N 路 child 全有或全无地原子创建；
2. 多个角色共享一个独立 group/taskId 和终态；
3. engine-native `all/quorum/any` barrier；
4. group 级 role revision、预算与并发冻结；
5. group 级公平配额或取消策略。

这些都是可以成立的高级需求，但当前没有证据表明它们是网络 V1 或基础多角色推理的前置条件。
相反，现有多角色共享任务设计会引入以下问题。

### 5.1 它优化的是广播，不是一般协作

方案要求各 participant 看到同一份完整 Task，并各自产生 contribution。这适合多个不同角色对
同一问题做 ensemble 或审阅，但不适合一般的树状分解：不同子任务通常需要不同目标、不同上下文
和不同结果契约。

### 5.2 `(taskId, roleId)` 无法表达同一角色的多分支

当前提案以 `(tenant_id, task_id, role_id)` 作为 participant 主键。因此同一 Task 中，同一 role
只能出现一次。复杂网络检索却经常需要：

```text
scout(query=A)
scout(query=B)
scout(query=C)
spider(url=1)
spider(url=2)
```

多次 child submission 天然支持这一结构；participant=role 会把“角色类型”和“具体工作实例”
错误合并。

### 5.3 它把 Code 可表达的控制流固化成 engine 协议

`all/quorum/any/skipOnReject`、Flow 扩展、Trigger 扩展和 participant 聚合器会把一组常见语言
组合提前固化为服务端 DSL。对于以不同宿主语言发挥各自优势的规划，优先把数组、循环、条件和
结果综合留在 Code，更符合项目方向。

### 5.4 它的横向改动过大

现有实施计划需要同时修改 contracts、数据库 schema、tag 路由、存储、TaskLoop、Dispatcher、
Flow、Trigger、HTTP、CLI、console、事件和指标。基础需求尚可由已有任务树满足时，这一 P0–P7
改动面不符合 YAGNI。

### 5.5 重新考虑 group primitive 的触发条件

只有实际出现下列硬需求时，才重新评估批量/group submission：

- 多个 child 必须全部创建或全部不创建；
- 外部消费者确实需要独立 group ID；
- 服务端必须承诺 quorum/any，而不是由父 RoleRun 综合；
- 必须在执行前原子预留 group 预算；
- 必须提供 task-local 公平配额或最大并发；
- 实测逐项持久化提交产生不可接受的事务开销。

即使届时增加 group primitive，它也应是 engine 的声明式提交能力，不是 Code 的通用任务管理器。

V1 接受逐项委派的部分进度：进程在第 N 次创建前失败，可能已经留下前 N−1 个 sibling。父任务
重跑后依靠 stable key 继续 upsert，最终收敛为同一组逻辑 child。这是 at-least-once/replay 模型，
不承诺 group 原子性或 exactly-once；若业务不能接受部分创建，就已满足重新评估 group primitive
的触发条件。

## 6. V1：Code 层最小持久化委派契约

### 6.1 能力定位

目标能力继续命名为 `tasks.delegate`。外部 Agent 对 Entry Task 使用 publish/submit；RoleRun
对自己获准创建的直接子任务使用 delegate。两者故意不用同一个动词，以保持用户入口、组织权和
任务存储边界清晰；不应恢复历史上可直连 TaskStore 的通用 `tasks.submit`。

概念接口如下：

```ts
interface ChildTaskSubmissionV1 {
  /** 当前父任务作用域内稳定、可复算的逻辑提交键。 */
  submissionKey: string;
  /** 必须通过当前 role 的组织权矩阵。 */
  to: string;
  title: string;
  /** 自包含的局部工作说明。 */
  text: string;
  /** 父方整理的有界上下文快照。 */
  context?: Record<string, unknown>;
  /** 只能是父任务 domains 的子集。 */
  domains?: string[];
  expect?: "result" | "artifact" | "report";
  /** V1 默认 required；detached 先不开放给普通 worker。 */
  dependency?: "required";
}

interface ChildTaskRefV1 {
  taskId: string;
  submissionKey: string;
  roleId: string;
  path: readonly string[];
  state: "submitted" | "running" | "paused" | "terminal";
  observation?: ChildOutcomeEnvelopeV1;
  question?: PublisherQuestionEnvelopeV1;
}

interface ChildOutcomeEnvelopeV1 {
  status: "completed" | "rejected" | "cancelled" | "escalated";
  summary: string;
  provenance: readonly string[];
  artifactRefs: readonly string[];
  error?: { family: string; message: string; retryable: false };
}

interface PublisherQuestionEnvelopeV1 {
  questionId: string;
  prompt: string;
  childTaskId: string;
}
```

Code 只能提供上面的工作声明。以下字段必须由 engine 依据当前 RoleRun 身份盖章，禁止自报：

- tenant 与 principal；
- parent taskId / roleId；
- path 与 lineageId；
- 根 goal；
- replyTo；
- domainBinding 收窄结果；
- work mode；
- role revision 与运行授权上下文。

### 6.2 `submissionKey` 是最小新增字段

当前父任务在 await 后会从头重跑；如果再次 delegate，同一逻辑子任务可能被重复创建。
`submissionKey` 与冻结的规范摘要必须同时满足：

```text
(tenantId, parentTaskId, submissionKey) → (唯一 child taskId, immutable specDigest)
```

同一父任务重跑并提交相同 key 时，engine 必须返回原 ChildTaskRef；不同 key 即使目标 role 相同，
也必须创建不同 child。相同 key、相同 canonical specDigest 是幂等重放；相同 key、不同 digest 必须
返回 conflict，不能静默沿用第一次内容。现有外部 Task 的 tenant-scoped idempotency 只做首写获胜，
尚未校验 digest，因此不能原样复用。

key 应代表稳定业务意图，例如：

```text
search:official-docs:q1
search:papers:solid-electrolyte
fetch:https-example-com-doc-sha256
verify:company-claim-7
```

LLM 自行生成的 key 可能在重跑时漂移。V1 应优先要求调用点使用语义固定 key；若省略 key，只能由
runtime 根据 canonical spec hash 派生，但这会把两个故意相同的工作合并，因此不得成为默认捷径。
具体列设计和迁移属于后续实施计划，本报告冻结的是冲突语义。

### 6.3 Engine 必须自动承担的语义

“只有提交”能够成立，依赖以下 engine 语义：

1. 校验组织权、目标 role、tag 与 domain 子集；
2. 以稳定 key 做幂等创建或返回既有 child；
3. 原子写入 child 与 required dependency，并扣减现有 role/lineage 预算；
4. required child 未终态时，父任务进入不可认领的 dependency waiting 状态，不能 completed；
5. 父 RoleRun 到达提交点或 done 时释放 lease，不占 worker 等待；
6. PG dependency row 是真相源，事件只做低延迟提示；重启和漏事件由 reconciliation 扫描收敛；
7. child terminal 后持久化 outcome envelope，并在依赖可继续时触发父任务 requeue；
8. 父重跑再次提交同 key 时，不重复派生，并获得该 child 的当前状态或终态快照；
9. result 正文不自动全量注入 prompt，只回流有界 summary/provenance/artifactRefs/error 信封；
10. child paused 时回流 publisher question；`tasks.answer` 继续提供直接父子的窄回答通道；
11. 根任务取消时自动沿 required edges 递归 fence；父主动 rejected 时取消未终态 required 后代；
12. child rejection 只表示依赖已终结并唤醒父，不自动 reject 父；
13. timeout、escalation 与 lease recovery 由 engine 协议处理；当前未兑现的 timeout 不算已实现功能；
14. task terminal、result、dependency transition 和 terminal outbox 保持事务一致；
15. per-parent、per-lineage child 数量和未决依赖数有硬上限，拒绝无界任务扩增。

### 6.4 Code 的语言级组织方式

目标表面可以让模型使用宿主语言本身逐项声明分支：

```ts
const children = queries.map((query, index) =>
  tasks.delegate({
    submissionKey: `search:${index}:${stableDigest(query)}`,
    to: "scout",
    title: `检索分支 ${index + 1}`,
    text: buildSelfContainedSearchTask(query),
    expect: "report",
  }),
);

if (children.some((child) => child.state !== "terminal")) {
  return done({ summary: "已声明检索分支，等待 required dependencies" });
}

return synthesize(children.map((child) => child.observation));
```

这里的 `done` 不会在 required child 尚未终结时提交父任务终态；engine 会将父任务持久化为
`waiting_dependency` 并释放 lease。父任务被唤醒后从头重跑，同一 key 的 `delegate` 是 upsert +
current outcome snapshot，因此最终可以综合结果。

V1 **不承诺**原生 `Promise`、continuation 或 `Promise.all` 能跨 RoleRun 存活。当前 runner 会重置
kernel 并从头执行；若普通 Promise 等待就会占住 lease，若首次调用抛 suspension 又无法声明其余
sibling。`tasks.await/resume` 因而必须在兼容期保留，直到上述 replay 模型和终态 barrier 完整落地。

未来 Python 成为合格 PTC 宿主时，也先投影同一个 replay-safe delegate 契约；只有运行时具备可
持久化 continuation 后，才可以把它包装成 `asyncio.gather` 等语言习惯，而不复制任务管理体系。

### 6.5 Code 明确不获得的能力

V1 不向普通 worker Code 暴露：

- 任意任务 list/search/get；
- status polling；
- claim、renew、release lease；
- retry、requeue 或直接修改 status；
- reprioritize 或修改路由；
- 任意 cancel；
- worker、replica、batch 或 container 管理；
- quorum/any、participant、barrier 控制；
- 跨 tenant 或跨 lineage 读取；
- 绕过组织权的任意 role submission。

这些能力仍可存在于 engine 内部服务、外部 operator/control API 或专门治理角色的窄权限面，但
不能因为“Code 可以组织逻辑”就普遍注入每个 RoleRun。

## 7. TCE 映射

[ADR-0004](../../adr/0004-tce-code-layer-ptc-capability-first.md)要求 Tool → Code → Execute，能力
契约第一性，禁止复活 Command 对象双轨。子任务提交应按下表映射：

| TCE 层 | 子任务提交落点 |
|---|---|
| Tool | 可选的 `tasks.delegate` schema 投影，帮助模型发现能力 |
| Code | 受静态审核的 typed capability call；调用集必须属于当前 role grants |
| Execute | 审核后路由到 engine-internal tasking implementation，而不是让 Code 直连 TaskStore |
| Engine lifecycle | 持久依赖、claim、lease、retry、回流和取消；不是模型可调用的管理 API |

这里没有新增 `TaskSubmissionCommand` 或其他 Command DTO。Code 仍然调用第一性的 PTC capability；
能力实现负责把审核后的调用转给 tasking service。任务持久化属于 engine 内部状态效果，不需要伪装
成外部网络或进程执行面。

`done`、`pause` 仍是 loop control capability；`tasks.answer` 是直接父子问题的窄消息通道。它们与
child delegation 的关系是：若存在未解决的 required dependency，engine 对父任务的 `done` 执行
同事务 terminal fencing，而不是要求模型主动检查所有子任务状态。

## 8. 父子任务生命周期

### 8.1 目标序列

```text
Parent RoleRun #1
  → Code 提交 child A / B / C（各有稳定 submissionKey）
  → engine 原子建立 required dependencies
  → Parent 到达 done / dependency suspension point
  → engine 发现未解决依赖，父任务进入 waiting_dependency
  → 释放 parent lease，等待期不占 worker

Children A / B / C
  → 沿用正常 candidates / claim / lease / run / retry
  → 各自产生 terminal result 或 structured failure

Durable dependency resolver
  → PG 中持久化 dependency outcome envelope
  → Activity event 只做低延迟唤醒提示
  → 漏事件/重启后由 reconciliation 扫描恢复
  → required dependencies 均终结时 requeue Parent

Parent RoleRun #2
  → 重放 delegate，按 submissionKey 取得当前状态/有界 outcome envelope
  → Code/LLM 综合结果或提交下一轮 child
  → required dependencies 全部解决后 done
  → engine 提交父 Task 终态和 terminal outbox
```

### 8.2 正确性不变量

以下是不允许由监控事后修复的协议不变量：

1. `(tenantId, parentTaskId, submissionKey)` 唯一映射一个 child 和 immutable specDigest；
2. parent、lineage、goal、tenant 与 domain 只能由服务端盖章；
3. child creation 与 dependency creation 原子；
4. lease generation/CAS 拒绝过期 Attempt 的 outcome；
5. required dependency 未解决时父任务不可认领、不可 completed；
6. child result 只能由有效 terminal commit 产生；
7. parent terminal fencing 与 dependency 判定原子；
8. Task terminal、result 和 terminal outbox 原子；
9. recursive cancel 后拒绝所有晚到 child outcome；
10. 进程内事件丢失不能改变依赖真相，reconciliation 必须最终唤醒父任务；
11. admission 在 child 写入前执行，lineage 不得无界扩张；
12. 产物通过不可变 artifactRef 回流，不提供共享可写 workspace。

它们是 Task/Dependency 状态机的定义，不是 fan-out 专用护栏。

### 8.3 失败语义

V1 默认由父 RoleRun 处理 required child 的结构化失败：

- child 可重试错误由 engine 按既有策略重试；
- child terminal rejection 作为 observation 回流；
- 父角色可以调整任务描述、换目标角色或给出降级结论；
- 父任务最终是否 rejected，由父角色产出和 engine 的 terminal contract 决定；
- child paused/question 不视为终态，由父方通过 `tasks.answer` 或外部 Agent 问答闭环处理；
- 根任务取消沿 required edges 递归；父主动失败时一并取消未终态 required 后代，避免孤儿；
- V1 不引入 `skipOnReject`、quorum 或 any 等额外聚合 DSL。

这样保留了 LLM 在 Code 中根据证据和上下文作出下一步决策的能动性。

## 9. 当前实现缺口

### 9.1 多 sibling 在首次挂起时可能丢失 handle

当前第一次 `tasks.await(childA)` 遇到未终态 child 时会立即挂起父任务，并只登记 childA。
此前已经 delegate 但尚未来得及 await 的 childB/C taskId 只存在于本轮瞬时 Code；重跑后
`tasks.resume()` 只返回已登记 waiting/results/questions，无法恢复未登记 handles。

这会导致两类失败：

- 父任务重跑后重复 delegate childB/C；
- childB/C 已经在运行，但父任务无法可靠收集其结果。

### 9.2 `delegate` 缺少父作用域幂等键

当前 `TaskControlService.delegate()` 发布 child 时没有透传稳定 idempotency key。父任务因 await、
lease recovery 或进程重启从头运行后，无法证明本轮派生与上一轮是同一个逻辑提交。

### 9.3 结果回流仍需模型显式 `resume`

`TaskDispatchNotifier` 已能把 child terminal result 或 paused question 写入父任务，但当前 runner
不会在重复 `delegate` 时返回稳定的当前状态/终态信封；模型必须记得调用 `tasks.resume()`。这增加了
提示负担，也把续接机制误呈现成任务管理能力。目标态不应把全部 child raw result 自动塞进 prompt，
而是返回有界的 status/summary/provenance/artifactRefs/error，正文按需读取并计入认知预算。

### 9.4 `await` 契约存在未兑现字段

当前 `TaskAwaitInput` 暴露 `timeoutMs` 与 `detach`，但主要执行路径并没有完整实现相应行为。
这进一步说明基础版应先收口持久提交与自动依赖，不应继续扩张模型可见的任务管理选项。

### 9.5 当前 pending/requeue 会造成忙认领

现有 await suspension 会把父任务立即改回 pending，而 claim candidates 未按 `dispatchWait` 排除它。
父任务可能在 child 完成前被重复认领，每次增加 claims count，最终触及 attempt 上限。V1 不能只把
await 隐藏起来，必须补不可认领的 dependency waiting 状态（或数据库等价谓词），且只在最后一个
required dependency 终结后恢复候选资格。

### 9.6 进程内事件不是可靠依赖真相

当前 child → parent 快速回流依赖进程内 `ActivityHub`；其缓冲有界，进程重启也会丢失。Notifier
只有订阅，没有启动补偿扫描。若终态事件落在订阅缺口，父任务可能永久保留 `dispatchWait`。
因此 PG dependency row/outcome 才能是真相源；事件只负责低延迟提示，startup/periodic
reconciliation 负责最终收敛。

### 9.7 父终态尚未检查 required child

当前 Task commit 只验证自身 lease CAS，delegate 本身也不创建 required dependency。父 RoleRun
如果没有显式 await，仍能在 child 未终态时直接 completed。目标实现必须把 dependency 检查放进
同一终态事务，不能在 runner 中先查再提交，否则存在 TOCTOU 竞态。

### 9.8 当前预算不限制任务树膨胀

worker 并发限制只限制消费速度，不能阻止一个 Code step 一次写入大量 child。认知预算目前也不等
价于 child admission。V1 必须把 child 数、未决 dependency 数和 lineage 消耗纳入现有 role/resource
预算或硬上限；这是写入前资源不变量，不是新的监控层。

## 10. 监控、护栏与协议不变量

### 10.1 现有分层监控足够承接观测

[概念文档](../concepts.md)已经定义：

- L1：任务/role/worker 的 steps、tokens、失败、trace、状态与耗时；
- L2：worker 子进程、心跳、队列、数据库连接和慢查询；
- L3：容器 CPU、内存、网络、磁盘、sandbox kernel 和数据服务资源。

Batch watchdog、task lease recovery 和容器健康检查也已经存在。V1 不需要增加第四层监控或
fan-out 专用控制器。N30 仍是只读 observation plane；它不能替代状态迁移，也不应因告警直接触发
pause/retry/restart。

### 10.2 现有 GuardRegistry 不承载任务状态机

项目中的 GuardRegistry 特指 agent-loop 内的“signal → verdict → guide/soft/hard”行为收敛，例如
重复动作、空 done、未知工具或负结果循环。把 dependency CAS、幂等键或 terminal fencing 塞进
GuardRegistry 会混淆领域模型。

### 10.3 只扩字段，不扩层

建议在现有任务树观测面增加：

- parentTaskId / lineageId；
- submissionKey；
- pendingDependencyCount；
- child latency、terminal status 与 error family；
- parent suspension/requeue count；
- duplicate submission dedupe count；
- submission key conflict 与 admission rejection count；
- waiting_dependency age 与 reconciliation repair count；
- recursive cancel 与 stale outcome rejection 计数。

L2/L3 和容器级指标保持不变。

结论：

> **不增加新的防护层，但不能用监控替代幂等、事务和状态机正确性。**

### 10.4 资源 admission 不是新护栏

用户提出的“已有任务级、进程级、容器级监控是否足够”，答案是：**观测层足够，不必新增一套
fan-out watchdog；写入前约束仍然必需。** per-parent/per-lineage child 上限、预算扣减和终态 fencing
属于既有 engine resource/lifecycle contract 的扩展。没有它们，监控只能在队列已经爆炸后报警，
无法保证系统在预算内接受任务。

## 11. 复杂网络检索示例

“Code 只有提交能力”仍然能够支持未来高深度、高广度研究。

### 11.1 外部 Agent 编译入口任务

用户请求：

> 调研某技术在 2024–2026 年的发展，覆盖论文、官方文档、公司声明和反面证据，区分事实、
> 推断与争议，并输出带来源的综合报告。

外部 Agent 编译：

- 不可改写的 root goal；
- 时间和主题范围；
- 来源类别与最低权威性要求；
- 非目标与预算；
- 验收标准和结果结构；
- 一个入口 researcher role。

### 11.2 Engine 与 Code 形成自适应任务树

入口 researcher 首轮使用 `net.search/fetch/extract` 做初始探索，然后根据中间结果动态提交：

```text
scout:papers:q1
scout:official-docs:q1
scout:company-claims:q1
scout:counter-evidence:q1
spider:paper-a-pdf
spider:official-doc-b
```

这些 child 可以目标相同 role，但拥有不同 submissionKey、text、context 和 expect。Engine 使用
现有 worker pool 并行执行。结果回流后，父 researcher 识别证据缺口和矛盾，再提交第二轮任务：

```text
verify:claim-7
trace:entity-x-history
compare:paper-a-vs-standard-b
```

当 coverage、预算或饱和条件满足后，父角色完成去重、证据分级、矛盾标注与综合。

### 11.3 深度和广度来自哪里

- **广度**来自多个 provider、多个查询、多个可并行 child，以及允许同一 role 多实例处理不同
  分支；
- **深度**来自父 RoleRun 根据回流 observation 继续提出下一轮工作，而不是一次预声明完整
  participant 列表；
- **安全和成本边界**来自 Execute policy、role grant、任务预算和 engine 生命周期；
- **权威性**来自来源身份、处理链和证据策略，不来自 fan-out 数量。

因此，复杂检索需要的是低阶网络原语、可靠子任务回流和 LLM 的迭代决策能力，不需要 Code 获得
任务控制面。

本例只证明架构可扩展性。本轮不实现 ResearchPlan、Frontier、EvidenceLedger、自动证据充分性
判断、长报告编排或 Search/Research → Intake 自动晋升。

## 12. 对 `dsh-pth-interface` 的连带建议

这些改进属于外部应用边界，不阻塞 engine V1，但应在后续单独实施。

### P0：入口任务契约

- `pth_submit` 透传独立 `goal`；
- 增加 `idempotencyKey` 与请求 fingerprint 冲突检查，避免 HTTP 超时重试产生重复入口任务；
- 明确只选择一个入口 role，不能把多个 tags 解释为广播；
- 修正“无 tags 使用默认路由”的文案与 strict router 不一致；
- system prompt 把自身描述为 Entry Task 编译 Agent，而不只是“任务池操作员”。

### P0：暂停问答闭环

- 增加 `pth_answer(taskId, answer)`；
- watcher 将 paused/waiting-human 映射为需要用户处理的通知；
- 外部 Agent 向用户提问并把回答回传 engine。

### P1：生命周期代理

- `pth_cancel` 透传 recursive，并明确入口取消默认作用于整棵任务树；
- 统一 cancelled/rejected 到 dsh job killed/failed 的状态映射；
- 修正文档中的工具数量和旧“等待”文案。

### P2：结构化 Entry Task 编译

未来可以版本化：

```ts
interface EntryTaskSubmissionV1 {
  goal: string;
  title: string;
  text: string;
  tags: string[];
  domains?: string[];
  acceptance?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  idempotencyKey?: string;
}
```

该接口仍不暴露 participant、worker 数、lease、retry、fan-out、barrier 或 engine 内部任务图。

## 13. 推荐迁移路径

本节只定义先后关系，不是逐文件实施计划。

### M0：冻结范围

- 暂停多角色共享任务实施方案 P0–P7；
- 不改变 tag 的单入口路由语义；
- 不创建 `task_participants`；
- 不扩展 Flow/Trigger；
- 把现有设计保留为未来 group primitive 的备选材料。

### M1：持久化提交

- 在现有 `TaskDelegateInput` 增加稳定 `submissionKey`；
- 建立父任务作用域唯一性和 canonical submission digest 校验；
- 复用现有 parent/path/lineage/goal/domain 盖章；
- 保证同 key 同 digest 返回同一 ChildTaskRef，同 key 异 digest 明确 conflict；
- 将 child admission 纳入现有 role/lineage 预算和硬上限。

### M2：Engine 自动依赖和回流

- child submission 默认建立 required dependency；
- PG dependency row 作为真相源，并提供 startup/periodic reconciliation；
- required child 未终态时拦截父 `done`，转入不可认领的 waiting_dependency；
- 父等待时释放 lease；
- child terminal 自动回流并 requeue；
- 重放 delegate 时按 submissionKey 返回有界 outcome envelope；正文经 artifactRef 按需读取；
- 保留 `tasks.answer` 的直接父子问题闭环；
- `tasks.await/resume` 暂时兼容，待覆盖验证后再从模型可见面退役。

### M3：语言级多提交

- TS 使用数组、循环和条件逐项构造多个 child delegations；
- runtime 通过持久等待与重放保证等待不占 worker，不承诺内存 Promise continuation；
- 同一父任务可以向同一 role 提交多个不同 key；
- 后续 PTC 宿主共享同一能力契约。

### M4：外部 interface 闭环

- 补 goal、idempotency、answer、recursive cancel 和 paused notification；
- 更新 interface 的世界观和机器可读 output schema。

### M5：观察后再决定高级 group 语义

- 用真实网络研究和开发任务观察子任务数量、事务开销、失败模式与父任务重跑成本；
- 只有 §5.5 的触发条件成立时，再设计 batch/group primitive；
- 不以“语法更短”为理由下沉 engine DSL。

## 14. 验收矩阵

后续实施至少应覆盖以下行为：

| 场景 | 预期 |
|---|---|
| 父重跑后重复提交同 key | 返回同一 child，不重复创建 |
| 同 key、不同 canonical spec | 返回 conflict，不静默复用旧 child |
| 同父、不同 key、同一 role | 创建多个独立 child |
| 越权 role submission | 在写任务前 fail-fast |
| 请求 domain 超出父 scope | 拒绝且不产生 child |
| child 运行期间 | 父 worker lease 已释放，不占并发 |
| child 运行期间重复扫描候选 | waiting parent 不可 claim，不增加 claims count |
| child terminal | 父自动 requeue，并收到有界 outcome envelope |
| 终态事件在进程重启时丢失 | reconciliation 依据 PG 真相最终唤醒父任务 |
| required child 未终态时父 done | 父不得提前 terminal |
| child terminal rejection | 失败回流，由父 RoleRun 决定下一步 |
| child paused/question | 父可经窄 `tasks.answer` 回答，或上送外部 Agent |
| 旧 lease generation 晚到 outcome | CAS 拒绝写入 |
| 根任务 recursive cancel | 全部后代被 fence，晚到写回无效 |
| 父主动 rejected | 未终态 required 后代取消，不留下孤儿 |
| 单父/lineage 超过 child 上限 | 写入前 admission 拒绝，不靠事后监控 |
| 未获授 tasks capability 的 role | 能力不注入或静态审核拒绝 |
| 单角色、无 child 的旧任务 | 行为完全兼容 |
| 进程/容器异常 | 现有 L2/L3 监控与 watchdog 可发现 |
| 网络副作用 | 仍通过 Execute-owned network gateway |

## 15. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 自动 required dependency 形成隐式等待 | 父任务看似“无响应” | trace/status 显示 pendingDependencies；外部 job 展示子树进度 |
| 父重跑重复执行其他副作用 | 重复网络或写操作 | submissionKey、现有能力幂等约束、不可变 artifactRef；后续再评估断点续跑 |
| LLM 生成不稳定 key | 重复 child 或 key 冲突 | 语义固定 key + canonical digest；缺 key 时才允许受限 hash 派生 |
| 子任务无限派生 | 成本和深度失控 | 写入前 child/lineage admission、现有任务预算与监控 |
| outcome 回流撑大上下文 | 父 RoleRun token 增长与 prompt injection | 有界信封、来源标记、artifactRef、按需读取与认知预算 |
| 进程事件丢失 | 父任务永久等待 | PG dependency 真相 + startup/periodic reconciliation |
| 逐项创建中途崩溃 | 只留下部分 sibling | 接受 V1 at-least-once/replay；stable key 重跑最终收敛 |
| `await/resume` 兼容期存在双语义 | 模型和实现混乱 | 明确目标契约、增加迁移 trace，不在同一批删除兼容原语 |
| 外部 Agent 编译能力不足 | 入口任务仍然模糊 | 先补 goal、acceptance、answer，不把职责回塞 engine |
| 未来确需 group 原子性 | 多次提交无法满足 | 以 §5.5 的证据触发独立 group 设计，而非提前建设 |

## 16. 实现证据索引

本报告区分“当前已实现事实”与“V1 目标语义”。下表给出关键判断的代码锚点，避免把提案写成
现状；行号对应页首基线。

| 判断 | 证据锚点 |
|---|---|
| engine 是 worker 与 LLM interface 宿主 | `CONTEXT.md:7-13,33-35`；`docs/POSITIONING.md:10-14,56-65` |
| dsh 只暴露 `pth_*` 且关闭 shell/fs/web/subagent | `/Users/anzhize/dsh-pth-interface/lib/index.js:1-9`；`/Users/anzhize/dsh-pth-interface/profiles/headless/cordis.patch.yml:21-95` |
| dsh 当前只编译 `title/text/tags` | `/Users/anzhize/dsh-pth-interface/lib/index.js:221-253,280-333` |
| dsh background job 只是投影/通知 | `/Users/anzhize/dsh-pth-interface/lib/index.js:114-199` |
| TCE 是 Tool → Code → Execute，PTC capability 第一性 | `CONTEXT.md:105-111`；`docs/adr/0004-tce-code-layer-ptc-capability-first.md:23-34` |
| 当前只有 TS 是生产 PTC 宿主 | `CONTEXT.md:129-139` |
| child delivery 的 lineage/goal/path 由服务端盖章 | `packages/pth-contracts/src/tasking-types.ts:53-90`；`src/pth/tasking/task-control-service.ts:213-242` |
| `delegate` 受组织权约束且只发布一个 child | `src/pth/tasking/delegation-policy.ts:49-69`；`src/pth/tasking/task-control-service.ts:113-256` |
| 当前 delegate 没有 stable submission key | `packages/pth-contracts/src/tasking-types.ts:92-116`；`src/pth/tasking/task-control-service.ts:244-256` |
| 当前 await 登记等待并让 runner 重跑 | `src/pth/tasking/task-control-service.ts:419-483`；`src/pth/bootstrap/task-loop.ts:604-630` |
| pending candidates 未排除等待父任务 | `src/pth/tasking/adapters/pg-task-repository.ts:145-174,275-290` |
| 当前父终态 commit 不检查 required child | `src/pth/tasking/adapters/pg-task-repository.ts:220-274` |
| child 回流依赖进程内事件且无补偿扫描 | `packages/pth-kernel-execution/src/execution/activity-hub.ts:1-6,30-55`；`src/pth/kernel/assembly.ts:192-213` |
| notifier 拒绝回写已终态父任务 | `src/pth/tasking/task-dispatch-notifier.ts:60-136` |
| 现有入口幂等未校验异内容冲突 | `packages/pth-kernel-storage/src/task-store-pg.ts:181-213`；`test/pth-kernel-storage/task-store-pg.test.ts:52-64` |
| N30 是只读 observation plane | `docs/pth/design/n30-runtime-observatory-design.md:15-35,72-83,495-497` |
| GuardRegistry 是 agent-loop 行为收敛 | `packages/pth-kernel-execution/src/execution/guardrails.ts:1-17,81-137` |
| participant/fanout 仍是未实施提案 | `docs/pth/design/task-logic-multi-role-collaboration-design.md`；`docs/pth/plan/task-logic-multi-role-collaboration-implementation-plan.md` |

特别注意：现有 external idempotency 命中同 key 后直接返回首写任务，即使正文不同；而协议文档曾
描述同 key 异 digest 应 conflict。M1 必须先统一代码与协议，不能把现有实现直接复制到 child scope。

## 17. 最终决策记录

| 决策 | 裁决 |
|---|---|
| 用户需求编译归属 | `dsh-pth-interface` 等外部 Agent 应用 |
| 多角色 LLM 推理归属 | FRACTA engine |
| Code 的任务写能力 | 一个受组织权约束的持久化直接子任务委派能力 |
| 任务管理 API | 不注入普通 worker Code |
| 当前能力演进 | 增强 `tasks.delegate`；不引入易混淆的通用 `submit` |
| `tasks.await/resume` | 语义保留，逐步收入 runtime；兼容期不急删 |
| `tasks.answer` | 保留直接父子问题闭环；不扩大为通用管理面 |
| `tasks.penetrate` | 性能捷径，非 V1 基础能力 |
| `tasks.fanout` | V1 不实施 |
| participant schema | V1 不实施 |
| 多 role tags = 广播 | 否；保持单入口严格路由 |
| 父子等待 | PG 持久 dependency、不可认领等待态、可靠回流和 reconciliation |
| 多任务组合 | 由宿主语言逐项声明与重放表达；V1 无持久 Promise |
| 监控 | 复用现有 L1–L3，只扩任务树字段 |
| 新护栏 | 不新增专用层；补协议、事务与资源 admission 不变量 |
| Deep Research | 后续版本 |
| `kernel-ts` | 继续作为 engine-internal PTC orchestration runtime |

最终建议：

> **让 Code 负责“提出下一批工作”，让 engine 负责“可靠完成并把观察送回来”。任务委派是
> LLM 能动性的边界，任务管理是 engine 正确性的边界。**
