# 持久化子任务委派设计（Persistent Child Delegation V1）

> 状态：**已裁决（V1 实施方向）**
> 日期：2026-08-26
> 上位报告：[任务边界与 Code 层最小委派能力复审报告](../report/engine-task-boundary-and-minimal-code-submission-report-2026-08-26.md)
> 取代：~~多角色共享任务设计~~（已转为历史备选，仅作未来 group primitive 参考）

---

## 1. 背景与结论

FRACTA engine 已经拥有角色化 worker、任务树、并发、租约、重试、暂停、结果回流和分层监控。
基础版本不需要在 Code 层增加 `tasks.fanout`、participant、barrier 或通用任务管理能力。

正确的最小演进是：

> **把现有 `tasks.delegate` 提升为可幂等重放、可恢复、由 engine 托管依赖与结果信封的
> 持久化子任务委派原语。**

一句话边界：

- 外部 Agent 应用负责“用户需求 → Entry Task Submission”编译；
- engine 负责角色化推理、任务树、生命周期与结果回流；
- Code 只负责“当前 RoleRun 还需要派生什么工作”。

## 2. 边界责任

| 能力 | 外部 Agent | Engine | PTC Code | Execute |
|---|---|---:|---:|---:|
| 用户对话与澄清 | 主责 | — | — | — |
| 编译入口目标、约束与验收 | 主责 | 校验 | — | — |
| 选择入口角色 | 声明/建议 | 权威校验 | — | — |
| 内部子任务派生 | — | 授权与持久化 | 声明 | — |
| claim、lease、retry | — | 主责 | 不可见 | — |
| 父子依赖与结果回流 | 展示 | 主责 | 消费 observation | — |
| provider、凭据与 egress | — | 授权上下文 | 不可见 | 主责 |

## 3. 核心概念

| 术语 | 定义 |
|---|---|
| Entry Task Submission | 外部 Agent 编译出的自包含入口请求 |
| Child Task Submission | 当前 RoleRun 声明需要派生的 durable child |
| Task Dependency | 父任务与 required child 之间的持久依赖 |
| RoleRun | 某个 role 对某 Task 的一次推理运行 |
| Attempt | 由 lease 隔离的一次可重试执行尝试 |
| Task Observation | 注入后续 RoleRun 的 child result、failure 或 publisher question |
| submissionKey | 父任务作用域内稳定、可复算的逻辑提交键 |
| waiting_dependency | 父任务存在未终结 required child 时的持久、不可认领状态 |
| Outcome Envelope | child 终态后回流给父的有界结果信封 |
| Dependency Consumption | 后续 Parent Attempt 通过 `tasks.delegate` 重放同 submissionKey 并取得终态 observation 的 Attempt 级标记 |

必须避免的混用：

- Task 不是原始 User Request；
- Task 不是传统 queue job；
- Child Task Submission 不是任务管理；
- Code 不是第二套 workflow engine；
- Role 不是 Assignment；同一 role 可承接多个不同 child tasks。

## 4. Code 层最小契约：`tasks.delegate`

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

以下字段必须由 engine 依据当前 RoleRun 身份盖章，禁止自报：

- tenant 与 principal；
- parent taskId / roleId；
- path 与 lineageId；
- 根 goal；
- replyTo；
- domainBinding 收窄结果；
- work mode；
- role revision 与运行授权上下文。

## 5. `submissionKey` 语义

```
(tenantId, parentTaskId, submissionKey) → (唯一 child taskId, immutable specDigest)
```

- 同一父任务重跑并提交相同 key → 返回原 ChildTaskRef，不重复创建；
- 相同 key、相同 canonical specDigest → 幂等重放；
- 相同 key、不同 canonical specDigest → 返回 conflict，不静默沿用第一次内容；
- 不同 key，即使目标 role 相同 → 创建不同 child。

key 代表稳定业务意图，例如：

```text
search:official-docs:q1
search:papers:solid-electrolyte
fetch:https-example-com-doc-sha256
verify:company-claim-7
```

LLM 自行生成的 key 可能在重跑时漂移。V1 优先要求调用点使用语义固定 key；
若省略 key，只能由 runtime 根据 canonical spec hash 派生，且不得成为默认捷径。

## 6. Engine 自动承担的语义

1. 校验组织权、目标 role、tag 与 domain 子集；
2. 以稳定 key 做幂等创建或返回既有 child；
3. 原子写入 child 与 required dependency，并扣减现有 role/lineage 预算；
4. required child 未终态时，父任务进入不可认领的 `waiting_dependency`，不能 completed；
5. 父 RoleRun 到达提交点或 done 时释放 lease，不占 worker 等待；
6. PG dependency row 是真相源，事件只做低延迟提示；重启和漏事件由 reconciliation 扫描收敛；
7. child terminal 后持久化 outcome envelope，并在依赖可继续时触发父任务 requeue；
8. 父重跑再次提交同 key 时，不重复派生，并获得该 child 的当前状态或终态快照；
9. result 正文不自动全量注入 prompt，只回流有界 summary/provenance/artifactRefs/error 信封；
10. child paused 时回流 publisher question；`tasks.answer` 继续提供直接父子的窄回答通道；
11. 根任务取消时自动沿 required edges 递归 fence；父主动 rejected 时取消未终态 required 后代；
12. child rejection 只表示依赖已终结并唤醒父，不自动 reject 父；
13. timeout、escalation 与 lease recovery 由 engine 协议处理；
14. task terminal、result、dependency transition 和 terminal outbox 保持事务一致；
15. per-parent、per-lineage child 数量和未决依赖数有硬上限，拒绝无界任务扩增；
16. required dependency 首次创建时记录父 Attempt generation；终态后必须由**后续 Attempt** 通过
    delegate 重放消费 observation，父 commit 才可 terminal——“无 pending dependency”不等于“已消费”。

## 7. 生命周期

```text
Parent RoleRun #1
  → Code 提交 child A / B / C（各有稳定 submissionKey）
  → engine 原子建立 required dependencies，并记录 created_lease_generation
  → Parent 到达 done / dependency suspension point
  → engine 检查 Attempt 级依赖门：
    · 仍有 pending → 父任务进入 waiting_dependency，释放 lease，等待期不占 worker
    · 无 pending 但存在未消费的 terminal dependency（如 child 在 commit 前已终态）→
      直接释放 lease 并置 pending，等待后续 Attempt 重放，不依赖已错过的 notifier 事件
    · 全部 terminal 且已被后续 Attempt 消费 → 才允许父 terminal

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
  → engine 在 dependency 行记录 consumed_lease_generation（必须 > created_lease_generation）
  → Code/LLM 综合结果或提交下一轮 child
  → required dependencies 全部解决且全部被消费后 done
  → engine 提交父 Task 终态和 terminal outbox
```

## 8. 正确性不变量

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
12. 产物通过不可变 artifactRef 回流，不提供共享可写 workspace；
13. terminal dependency 只有被后续 Attempt 通过 delegate 重放消费后才放行父 terminal；
    “无 pending dependency”不能替代“当前 Attempt 已消费 observation”的判定。

## 9. 失败语义

- child 可重试错误由 engine 按既有策略重试；
- child terminal rejection 作为 observation 回流；
- 父角色可以调整任务描述、换目标角色或给出降级结论；
- 父任务最终是否 rejected，由父角色产出和 engine 的 terminal contract 决定；
- child paused/question 不视为终态，由父方通过 `tasks.answer` 或外部 Agent 问答闭环处理；
- 根任务取消沿 required edges 递归；父主动失败时一并取消未终态 required 后代，避免孤儿；
- V1 不引入 `skipOnReject`、quorum 或 any 等额外聚合 DSL。

## 10. 与现有原语的关系

| 原语 | 关系 |
|---|---|
| `tasks.delegate` | 增强为持久化、幂等的 child submission |
| `tasks.await` | 语义保留，逐步收入 runtime；兼容期保留 |
| `tasks.resume` | 兼容保留；目标态由 delegate 回执返回有界快照 |
| `tasks.answer` | 保留为直接父子问题的窄消息闭环 |
| `tasks.penetrate` | 性能捷径，非 V1 基础能力 |
| `done` / `pause` | 仍是 loop control capability；存在未解决 required dependency 时，`done` 由 engine 做 terminal fencing |

## 11. Code 明确不获得的能力

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

## 12. 监控与预算

- 复用现有 L1–L3 监控，不新增第四层或 fan-out 专用 watchdog；
- 在现有任务树观测面增加：
  - parentTaskId / lineageId；
  - submissionKey；
  - pendingDependencyCount；
  - child latency、terminal status 与 error family；
  - parent suspension/requeue count；
  - duplicate submission dedupe count；
  - submission key conflict 与 admission rejection count；
  - waiting_dependency age 与 reconciliation repair count；
  - recursive cancel 与 stale outcome rejection 计数。
- 写入前约束：per-parent/per-lineage child 上限、预算扣减和终态 fencing 属于既有 engine
  resource/lifecycle contract 的扩展，不能靠事后监控。

## 13. 验收矩阵（节选）

| 场景 | 预期 |
|---|---|
| 父重跑后重复提交同 key | 返回同一 child，不重复创建 |
| 同 key、不同 canonical spec | 返回 conflict，不静默复用旧 child |
| 同父、不同 key、同一 role | 创建多个独立 child |
| 越权 role submission | 在写任务前 fail-fast |
| child 运行期间 | 父 worker lease 已释放，不占并发 |
| child 运行期间重复扫描候选 | waiting parent 不可 claim，不增加 claims count |
| child terminal | 父自动 requeue，并收到有界 outcome envelope |
| 终态事件在进程重启时丢失 | reconciliation 依据 PG 真相最终唤醒父任务 |
| required child 未终态时父 done | 父不得提前 terminal |
| child 在父 commit 前已终态 | 父首次 commit 不得 terminal，释放回 pending 等待 replay |
| replay 同 submissionKey 取得终态 observation | dependency 记录 consumed_lease_generation，随后综合 commit 成功 |
| 单角色、无 child 的旧任务 | 行为完全兼容 |

## 14. 非目标

- 不实施 `tasks.fanout`；
- 不实施 participant schema；
- 不改变多 role tag 的单入口严格路由；
- 不扩展 Flow/Trigger 为多参与者广播；
- 不实现 ResearchPlan、EvidenceLedger、Claim–Citation Graph、自动停止和研究产品工作流；
- 不承诺跨 RoleRun 的原生 Promise / continuation / `Promise.all`。
