# FRACTA 任务逻辑施工反馈报告（第二轮）

> 状态：**M1/M2/M5 已形成工作区实现；架构边界保持正确，但父任务租约切换与真实 PostgreSQL 验收尚未闭环**  
> 日期：2026-08-26  
> PTH 提交基线：`e48fca9`（`pi-triple-pth/main`）  
> 外部接口提交基线：`3ed14e5`（`dsh-pth-interface/main`）  
> 检查范围：持久化子任务提交、required dependency、父任务重放、取消传播、结果回流、dsh-interface 入口闭环  
> 第一轮报告：[任务逻辑施工反馈报告](./task-logic-construction-feedback-2026-08-26.md)  
> 关联设计：[持久化子任务委派设计](../design/persistent-child-delegation-design.md)  
> 关联计划：[持久化子任务委派实施方案](../plan/persistent-child-delegation-implementation-plan.md)

## 0. 第二轮结论

本轮实现已经处理第一轮报告中的多数具体缺口：

- `submissionKey` 已有稳定序列化和 SHA-256 canonical digest；
- 并发同父提交已增加事务级 advisory lock；
- child、submission、dependency 已能在同一 PostgreSQL 事务内创建；
- 递归取消已从 legacy payload 遍历迁到 `task_dependencies`；
- 父任务 completed/retryable commit 已增加 required dependency fencing；
- notifier、reconciler、dependency 指标和 admission 上限已经接入；
- 角色提示已从 `delegate → await` 改成 replay-safe delegate 叙述；
- dsh watcher 已补递归取消、暂停重复通知和 `pth_answer`；
- 第一轮稳定失败的 cancel HTTP 路由测试现在通过。

因此，当前不再是“只有骨架”的状态，而是已经形成一条可以继续完成的 Engine 托管依赖链。
不过，本轮同时暴露出一个比第一轮问题更接近运行时核心的 P0：

> **`tasks.delegate` 作为普通 Code 工具调用返回之前，就把父任务改为
> `waiting_dependency` 并清除了 lease；当前 RoleRun 却不会同步停止。**

这会让已失去 lease 的旧 Attempt 继续执行工具，并可能在 child 快速终态、父任务被重新认领后与
新 Attempt 并行。它不是“需不需要给 Code 增加任务管理器”的问题，而是 Engine 内部何时提交
依赖挂起状态的问题。

综合判断：

> **任务逻辑已进入运行时收口阶段，但不能按当前状态合并。先修复父 Attempt 的 lease/suspension
> 原子边界，再完成真实 PostgreSQL 并发与恢复验收；不要扩展 fanout、barrier 或 Code 任务管理器。**

## 1. 与第一轮反馈的对账

| 第一轮问题 | 第二轮状态 | 证据/说明 |
|---|---|---|
| canonical digest 使用普通 `JSON.stringify` | 已修复 | `stableSerialize()` 对对象键排序并做字符串归一化，`canonicalDelegateSpecDigest()` 使用 SHA-256 |
| 同一 `submissionKey` 并发竞态 | 基本修复 | delegate 事务对 `(tenantId,parentTaskId)` 使用 `pg_advisory_xact_lock` |
| child/dependency 非原子 | 已修复 | `TaskStore.publishInTx()` 让 child、submission、dependency 共用事务 client |
| cancel 仍沿 payload 图遍历 | 已修复 | recursive CTE 已改沿 `task_dependencies.parent_task_id → child_task_id` |
| role prompt 仍要求 `delegate → await` | 已修复文本 | 内置角色和 catalog 卡片改成同 `submissionKey` 重放回收；运行时 E2E 仍缺 |
| dsh cancel 不递归 | 已修复 | watcher 和 `pth_cancel` 默认发送 `recursive: true` |
| `pausedNotified` 不复位 | 已修复 | 任务离开 paused/waiting-human 后标志复位，可再次通知 |
| cancel 路由测试稳定失败 | 已修复 | `test/pth-gateway/kernel-routes.test.ts` 本轮 42/42 通过 |
| PG 事务测试被跳过 | 未修复 | 本轮仍有 53 个相关测试因缺少 `TEST_DATABASE_URL` 跳过 |
| PTH/dsh 改动未提交 | 未修复 | 两仓相关实现仍位于工作树 |

第一轮报告应保留为历史审计记录，不应覆盖。第二轮报告记录“问题被怎样处理，以及处理后出现了
什么新的系统级风险”。

## 2. 架构边界复核

### 2.1 外部 Agent

`dsh-pth-interface` 仍负责：

1. 理解用户真实需求；
2. 编译自包含 Entry Task；
3. 选择单一入口 role 的标签；
4. 发布任务、展示后台状态；
5. 将暂停问题转给用户并回传回答；
6. 按用户要求取消整棵任务树。

它不负责 Engine 内部 child 调度，也不应向用户暴露 Engine 的 lease、dependency 或 worker 细节。

### 2.2 Code 层

Code 继续只需要窄能力：

```ts
tasks.delegate({
  submissionKey,
  to,
  title,
  text,
  context,
  domains,
  expect,
  dependency: "required",
})
```

Code 决定“提交什么子任务、提交多少个、拿到结果后如何综合”。Code 不拥有：

- claim；
- lease；
- retry；
- dependency 表；
- requeue；
- recursive cancel；
- worker 并发控制；
- reconciliation；
- terminal commit。

因此本轮仍不需要新增 Code 任务管理器、`tasks.fanout`、barrier DSL 或 quorum/any 语义。

### 2.3 Engine

Engine 已开始真正承担：

- 服务端身份、role、tenant、goal、domain 盖章；
- `submissionKey` 幂等和 spec 冲突拒绝；
- admission；
- child/dependency 原子创建；
- dependency 真相维护；
- terminal outcome envelope；
- waiting parent requeue；
- 取消传播与最终 reconciliation。

这个职责归属符合“Engine 是 LLM 推理引擎”的项目定位。当前问题出在 Engine 内部状态切换的时机，
不是分层方向错误。

## 3. 当前实现进度

### 3.1 M1：持久化提交

已实现：

- `ChildTaskSubmissionV1`、`ChildTaskRefV1`、`ChildOutcomeEnvelopeV1`；
- 显式或派生 `submissionKey`；
- canonical spec digest；
- 同 key 同 digest 返回已有 child；
- 同 key 异 digest 拒绝；
- 每父累计 child 和 open dependency 上限；
- `task_submissions` 唯一映射；
- `publishInTx()` 事务内任务发布。

与第一轮相比，这部分已经具备合并前代码形态。剩余问题主要是必须由真实 PG 测试证明 advisory
lock、unique constraint 和事务回滚在并发条件下按预期收敛。

### 3.2 M2：Engine 自动依赖与回流

已实现：

- `task_dependencies` 表；
- `waiting_dependency` 状态；
- completed/retryable commit fencing；
- child terminal → dependency envelope；
- 全部 required child 终态后 parent requeue；
- 事件丢失后的 periodic reconciliation；
- recursive cancel 以 dependency edge 为事实来源；
- dependency transition 指标。

这使 dependency 不再只是 prompt 约定，而成为 Engine 的持久化事实。

### 3.3 M3：语言级多提交

文本和返回契约已开始迁移：

- role prompt 不再强制 `tasks.await`；
- delegate 返回 `submissionKey/state/observation/question`；
- 重放同 key 可取得已有 child 快照。

但尚未看到真实轨迹证明：

```text
RoleRun #1
  → 多次 delegate
  → Engine 安全挂起
  → children terminal
  → parent replay
  → 同 key 不重复创建
  → parent 综合并 completed
```

这一轨迹是 M3 的实际出口，不能由类型测试替代。

### 3.4 M4：dsh-interface 闭环

本轮已有明显进展：

- Entry Task persona 更明确；
- `goal` 与入口 `idempotencyKey` 已暴露；
- watcher 认识 `waiting_dependency`、paused 和 waiting-human；
- `pth_answer` 已加入；
- `pth_cancel` 默认递归；
- 后台任务暂停后不被错误结算为终态。

但这里仍有一个契约错位：`pth_answer` 宣称同时支持 paused/waiting-human，而 PTH 的
`/api/v1/kernel/tasks/:id/answer` 当前只接受 paused。waiting-human 实际属于 human request
approve/reject 流程。模型被告知可用一个无效工具闭环，必须在合并前修正。

### 3.5 M5：观测与 admission

已增加：

- `pth_task_submissions_total`；
- `pth_task_dependency_status_total`；
- `pth_task_waiting_dependency_age_seconds`；
- reconciliation repair；
- submission conflict；
- admission rejection。

这些指标足以支撑 V1 观察，不需要现在增加复杂 group 语义。

## 4. P0：父 Attempt 的 lease/suspension 边界

### 4.1 当前执行序列

当前 delegate 新建 dependency 后，在事务内直接执行：

```text
parent.status = waiting_dependency
parent.claimed_by = NULL
parent.lease_id = NULL
parent.lease_expires_at = NULL
```

随后 `tasks.delegate` 正常返回 `ChildTaskRef`，Code/LLM 继续当前 RoleRun。

如果 child 较快终态：

```text
旧 Attempt 调用 delegate
  → Engine 清父 lease
  → 旧 Attempt 仍在运行
  → child terminal
  → notifier 把 parent 改回 pending
  → 另一个 worker claim parent
  → 新旧两个 Attempt 并行
```

最终 outcome CAS 会拒绝旧 Attempt 的 terminal commit，但不能撤销它在 lease 清除后执行的文件、
网络、命令或外部系统副作用。

### 4.2 同一问题的另一个表现

delegate 写 child 前没有验证：

- parent 当前是否仍是本 Attempt 持有的 claimed 状态；
- lease id/generation 是否仍有效；
- parent 是否已经 completed/rejected/escalated；
- parent 是否刚被外部取消。

`TaskDispatchContext` 当前没有服务器盖章的 lease reference。旧 Attempt 即使在父任务取消后继续
走到 delegate，也可能创建一个无法被正常消费的 child/dependency。

### 4.3 修复边界

修复仍应完全留在 Engine：

1. delegate 写入必须绑定服务器盖章的当前 Attempt/lease；
2. child 创建前在事务内锁定并验证 parent 非终态且 lease 属于调用 Attempt；
3. dependency suspension 必须发生在 Engine 可停止当前 RoleRun 的边界；
4. parent requeue 不能早于旧 Attempt 完成退出；
5. 测试必须覆盖 child 在 delegate 返回前后快速终态的竞态。

可以选择“runner suspension point”或“terminal commit fencing + attempt marker”等 Engine 内部实现，
但不应把 lease 管理和 barrier 暴露给 Code。

## 5. P1/P2 问题

### 5.1 真实 PostgreSQL 验收缺失（P1）

本轮定向测试：

```text
5 test files passed
5 test files skipped
71 tests passed
53 tests skipped
```

被跳过的正是：

- schema constraints；
- `publishInTx`；
- advisory lock/并发同 key；
- dependency fencing；
- notifier transaction；
- reconciliation；
- cancel propagation。

因此不能把 71 个绿色测试解释为“持久化任务逻辑已验收”。

### 5.2 waiting-human 与 paused 混用（P1）

`paused` 是发布者问题箱；`waiting-human` 是 human request/approval gate。dsh watcher 可以同时通知，
但回答动作必须分开路由，或者明确只对 paused 注册 `pth_answer`。

### 5.3 `taskCounts()` 未显式展示新状态（P2）

数据库聚合会把 `waiting_dependency` 计入 total，但 facade 返回结构没有
`waitingDependency/paused/waitingHuman` 字段。后台状态可通过任务列表查看，却无法在 kernel status
摘要中快速识别依赖堆积。

### 5.4 reconciliation 周期重入与指标含义（P2）

- `setInterval` 没有 running guard，单轮超过周期时可能重叠；
- waiting age 使用 task `created_at`，不是进入 `waiting_dependency` 的时间，老任务会高估等待年龄；
- orphan 扫描逐行调用处理函数，规模扩大后会形成 N+1 查询。

这些不阻断 V1 正确性修复，但应在生产试运行前明确容量边界。

### 5.5 入口幂等仍只在 dsh 进程内比较正文（P2）

PTH API 对入口 `idempotencyKey` 做去重，但正文 fingerprint 冲突只在单个 dsh 进程的内存 Map 中
检查。多进程、重启或其他 API client 仍可能用相同 key 提交不同正文并静默取得旧任务。child
submission 已有服务端 digest，入口任务可在后续复用同样的服务端冲突语义。

## 6. 建议施工顺序

### P0：先修父 Attempt 竞态

1. 写 parent cancelled/completed 后旧 Attempt delegate 的失败测试；
2. 写 child 快速终态、旧 Attempt 尚未退出时禁止 parent re-claim 的测试；
3. 将 lease reference 加入服务器侧 task dispatch context；
4. 把 waiting transition 移到 Engine 可停止 RoleRun 的原子边界；
5. 验证旧 Attempt 不能再提交 child 或外部 side effect。

### P1：完成 PG 验收

1. 提供 `TEST_DATABASE_URL`；
2. 跑全部 53 个被跳过测试；
3. 增加至少两个真实并发事务用例；
4. 验证进程重启/漏事件后 reconciler 最终唤醒；
5. 验证 recursive cancel 后晚到 child outcome 不会复活依赖。

### P1：修复 dsh 人工交互契约

1. paused 使用 `pth_answer`；
2. waiting-human 暴露 human-request 查询与 approve/reject，或只通知用户去外部运维面处理；
3. watcher 根据状态给出不同提示，不再承诺一个统一回答动作。

### P2：补观测再试运行

1. kernel task counts 增加 waiting/paused 分类；
2. reconciliation 加防重入；
3. waiting age 记录进入状态的时间；
4. 在受控环境观察 child 数、dependency age、repair 和 conflict，再决定是否需要 group 语义。

## 7. 合并门槛

必须满足：

- [ ] delegate 绑定有效 parent Attempt/lease；
- [ ] 清 lease 后旧 RoleRun 不再继续执行普通工具；
- [ ] child 快速终态不会造成 parent 双 Attempt；
- [ ] parent terminal/cancelled 后不能再创建 child；
- [ ] 53 个 PG 测试全部执行且通过；
- [ ] 同 key 并发创建只有一个 child；
- [ ] dependency fencing/requeue/reconciliation 有真实 PG 证据；
- [ ] recursive cancel 有 late outcome 回归测试；
- [ ] dsh paused/waiting-human 工具说明与 API 一致；
- [ ] PTH 与 dsh 相关改动分别形成可审查提交。

本轮不要求：

- `tasks.fanout`；
- Code task manager；
- barrier/quorum/any；
- Flow/Trigger 广播；
- 复杂研究工作流；
- 多角色共享可写上下文。

## 8. 验证证据

本轮执行：

- 任务逻辑定向测试：`71 passed / 53 skipped`；
- kernel routes：42 个测试纳入上述结果并全部通过；
- PTH 完整 `npm run lint`：通过；
- boundary、import cycle、config、role conservation、product boundary、TCE coverage、docs links：通过；
- `git diff --check`：通过。

限制：当前环境没有 `TEST_DATABASE_URL`，没有取得 PostgreSQL 事务、并发、reconciliation 的真实
运行证据。报告因此将状态定为“运行时收口中”，而不是“实施完成”。

## 9. 最终意见

任务逻辑的架构方向已经稳定：外部 Agent 编译 Entry Task，Code 只声明子任务，Engine 管理持久化、
并发和生命周期。第二轮不应再讨论把 Engine 迁到 Code，也不应引入新的 Code 任务管理层。

下一步唯一应优先回答的问题是：

> **Engine 如何在允许 Code 一次声明多个 child 的同时，保证父 Attempt 只在安全边界释放 lease，
> 并且不会因 child 快速完成而发生双执行？**

这个 P0 与真实 PG 验收闭环后，当前 V1 才具备进入合并和受控试运行的条件。
