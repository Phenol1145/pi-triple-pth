# FRACTA 任务逻辑施工反馈报告（第三轮验收）

> 状态：**未通过；第二轮 P0 的双 Attempt 风险已收口，但“child 在父 commit 前终结”会绕过父任务 replay/综合**
> 日期：2026-08-26
> PTH 验收基线：`21bd168`（本地 `main`，领先 `origin/main` 2 个提交）
> dsh-interface 验收基线：`f2a8bb9`（本地 `main`，领先 `origin/main` 2 个提交）
> 检查范围：持久化子任务提交、Attempt/lease、required dependency、父任务重放、取消传播、结果回流、真实 PostgreSQL 事务与 dsh 状态契约
> 第二轮报告：[FRACTA 任务逻辑施工反馈报告（第二轮）](./task-logic-construction-feedback-round-2-2026-08-26.md)
> 关联设计：[持久化子任务委派设计](../design/persistent-child-delegation-design.md)

## 0. 第三轮结论

`21bd168` 已直接处理第二轮报告中的大部分阻断项：

- `TaskDispatchContext` 可携带服务器盖章的 lease reference；
- `AgentTaskRunner` 在 claim 后把 task/tenant/role/lease 一并盖入 Code 能力上下文；
- `tasks.delegate` 在事务内锁定并验证当前 parent Attempt；
- delegate 不再提前清 lease，父 RoleRun 可继续声明多个 child；
- RoleRun 到达 commit 安全边界后，repository 才根据 dependency 决定 fence；
- 过期 claimed parent 若仍有未决依赖，会恢复到 `waiting_dependency`；
- notifier 不会在旧 parent Attempt 仍为 `claimed` 时提前 requeue；
- reconciliation 已有防重入，waiting age 使用 `waiting_dependency_at`；
- task counts 已显式展示 paused、waiting-human、waiting-dependency；
- 入口 `idempotencyKey` 已有服务端正文冲突检测；
- dsh 已区分 paused 发布者澄清与 waiting-human 人工审批；
- 72 个相关真实 PostgreSQL 用例本轮实际执行并全部通过。

这证明第二轮指出的“delegate 返回前清 lease，旧 Attempt 与新 Attempt 并行”已经得到正确方向的
修复：多次 delegate 仍是 Code 的普通语言级组合，lease/dependency/requeue 继续由 Engine 托管，
没有引入 Code 任务管理器或 fanout DSL。

但第三轮增加了第二轮明确要求的快 child 竞态探针，实际复现了新的 P0：

```text
Parent Attempt #1 delegate child
  → child 在 Parent #1 commit 前 completed
  → notifier 把 dependency 从 pending 改为 satisfied
  → parent 仍保持 claimed（这一点本身正确）
  → Parent #1 commit 只查询“是否仍有 pending dependency”
  → 查询结果为 false
  → Parent #1 直接 completed，写入自己的 partial result
  → Parent Attempt #2 从未发生，也没有 replay delegate / 综合 child outcome
```

因此第三轮总判定为：

> **任务逻辑未通过。现有实现已经避免双 Attempt，却把“required child 必须触发父重放并由 Code
> 综合结果”错误简化成了“commit 时没有 pending child 即可完成”。需要增加 Attempt 级的依赖提交/
> 消费标记，而不能只看 dependency 当前状态。**

## 1. TCE 与职责边界复核

### 1.1 Tool

Tool 层继续只向模型暴露窄契约：

- `tasks.delegate`：幂等声明一个 required child；
- `tasks.await/resume/answer`：兼容结果与问题回流；
- `done/pause`：控制当前 RoleRun 的语言级结束方式。

Tool 不暴露 claim、lease、dependency 表、requeue、retry、reconciliation 或 worker 并发控制。

### 1.2 Code

Code 负责：

- 决定是否分解任务；
- 多次调用 `tasks.delegate`；
- 使用稳定 `submissionKey`；
- 在父任务重放时取得已有 child 的终态 observation；
- 综合多个 child 结果并产生父任务结果。

本轮仍没有证据表明 Code 需要 `tasks.fanout`、barrier、participant 或通用任务管理器。一次提交一个
child 的能力已经足够，语言本身可以完成循环、条件和多次调用。

### 1.3 Execute / Engine

Engine 负责：

- 服务器身份与 lease 盖章；
- parent Attempt 有效性校验；
- child/submission/dependency 原子创建；
- required dependency fencing；
- child terminal envelope；
- parent suspension/requeue/recovery；
- terminal CAS、取消传播、reconciliation 和指标。

本轮 P0 仍属于 Engine 内部提交协议，不应通过把任务管理下放到 Code 来规避。

## 2. 第二轮合并门槛对账

| 第二轮门槛 | 第三轮状态 | 证据与判断 |
|---|---|---|
| delegate 绑定有效 parent Attempt/lease | **生产路径通过，契约仍有兼容口** | runner 盖章 lease；service 在 `caller.lease` 存在时严格校验。`lease` 仍为 optional，legacy/test caller 可绕过，建议后续收窄内部端口 |
| 清 lease 后旧 RoleRun 不继续执行普通工具 | **通过** | delegate 不再清 lease；只在 RoleRun commit 边界 fence |
| child 快速终态不造成 parent 双 Attempt | **通过原问题，但出现新 P0** | notifier 在 parent claimed 时不 requeue；但 terminal dependency 会让首次 commit 直接完成 |
| parent terminal/cancelled 后不能创建 child | **生产路径通过** | 有 lease 的旧 Attempt 会因 status/lease CAS 校验失败；optional legacy path 仍是兼容债务 |
| 真实 PG 用例全部执行 | **通过** | 本轮 6 个 PG 文件、72 个测试全部实际执行并通过 |
| 同 key 并发只创建一个 child | **通过** | advisory transaction lock + unique mapping；真实 PG 用例通过 |
| fencing/requeue/reconciliation 有 PG 证据 | **通过既有场景** | pending child 路径和漏事件修复用例通过 |
| recursive cancel 有 late outcome 回归 | **部分通过** | cancel 将 dependency 置 cancelled，notifier 不会从 cancelled 覆盖；尚缺专门的 late outcome 测试 |
| dsh paused/waiting-human 与 API 一致 | **通过** | `pth_answer` 只描述 paused；waiting-human 明确转人工审核面 |
| PTH/dsh 分别形成提交 | **通过本地提交，尚未推送** | PTH `21bd168`；dsh `f2a8bb9`；两仓本地均领先 origin |

## 3. 已闭环的主要修复

### 3.1 lease 在 runner 统一盖章

`AgentTaskRunner` 根据实际 claim 得到的 `TaskLease` 构造 dispatch context。Code 不能从调用参数伪造
taskId、tenantId、roleId、leaseId 或 generation。

### 3.2 delegate 保持父 Attempt 运行

delegate 在同一事务中：

1. 对 parent 取得 advisory transaction lock；
2. 校验 lease/status/expiry；
3. 检查同 submissionKey 的既有映射；
4. 做 admission；
5. 原子创建 child、submission、dependency；
6. 返回 `state: submitted`。

它不再修改 parent status 或释放 lease，因此一个 RoleRun 可以声明多个 child。

### 3.3 commit 安全边界

completed/retryable outcome 在事务中先检查 dependency。存在 `pending` 时，parent 被 fence 到
`waiting_dependency` 并释放 lease，旧 outcome 不落终态和 side effect。

### 3.4 过期恢复与最终收敛

- expired claimed + pending dependency → `waiting_dependency`；
- expired claimed + 无 pending dependency → `pending`；
- notifier 根据 child terminal 更新 outcome envelope；
- reconciler 修复漏事件，并避免周期重入；
- waiting age 以进入等待状态的时间计算。

### 3.5 入口幂等

入口任务对 title/text/tags/goal/domains 生成 canonical digest。同 tenant 同 key 同正文返回既有任务，
不同正文返回 conflict；并发首次提交由唯一索引收敛。

## 4. P0：terminal dependency 绕过父 replay

### 4.1 根因

repository 的 terminal fencing 只调用：

```sql
SELECT 1
FROM task_dependencies
WHERE tenant_id = $1
  AND parent_task_id = $2
  AND status = 'pending'
LIMIT 1
```

当 child 已终态时，notifier 已把依赖改为 `satisfied` 或 `failed`。此时“没有 pending”只证明 barrier
已满足，不证明当前 parent Attempt 已消费 child observation，更不证明它完成了综合。

### 4.2 实际探针结果

本轮使用临时真实 PostgreSQL 探针执行：

1. 创建带有效 lease 的 claimed parent；
2. delegate 一个 required child；
3. 在 parent commit 前把 child 置 completed；
4. 运行 notifier；
5. 提交 parent 的 `{ value: "parent partial" }` outcome。

实际结果：

```json
{
  "committed": true,
  "status": "completed",
  "result": { "value": "parent partial" }
}
```

探针随后已删除，工作树没有留下临时测试文件。

### 4.3 影响

- M3 设计中的 `Parent RoleRun #2` 不再是确定语义；
- child outcome 可能持久化，但从未被父 Code/LLM 读取和综合；
- parent 的 partial/done 文本会成为最终结果；
- child 越快完成，越容易触发该问题；
- 当前 M3 测试只覆盖“parent 先 commit fence、child 后终态”，没有覆盖相反顺序。

这不是双执行问题，但会产生静默错误结果，因此仍按 P0 处理。

## 5. 建议修复协议

不建议恢复“delegate 内立即挂起”，否则会破坏同一 RoleRun 多次 delegate。建议保留 commit 安全边界，
增加 Attempt 级标记：

1. child/dependency 首次创建时记录 parent lease generation（或等价的 dependency epoch）；
2. parent commit 同时检查：
   - 是否有未终态 required dependency；
   - 是否有在当前 Attempt 首次创建、尚未经过后续 parent Attempt 消费的 dependency；
3. 若当前 Attempt 新建过 dependency：
   - 仍有 pending → `waiting_dependency`；
   - 已全部 terminal → 直接释放 lease 并置 `pending`，不能等待一个已经发生过的 notifier 事件；
4. Parent Attempt #2 重放相同 submissionKey，取得 terminal envelope；
5. 第二次综合后的 commit 才允许 terminal；
6. terminal outcome、dependency 状态和 parent transition 继续保持同一事务/CAS 约束。

也可以使用 task 上的 `resume_required/dependency_epoch`，但不能用纯内存标志，也不能仅靠 prompt 要求
模型“记得综合”。

## 6. 必补回归测试

至少增加以下真实 PG 用例：

1. child 在 parent commit 前 completed：首次 commit 不得 terminal；
2. child 在 parent commit 前 rejected：首次 commit 同样不得 terminal；
3. 全部 child 已 terminal 时首次 commit 后 parent 可立即重新 claim，不依赖第二个 child event；
4. replay 同 submissionKey 返回 terminal observation，不创建新 child；
5. replay 综合后最终 commit 成功；
6. recursive cancel 后晚到 child terminal event 不得覆盖 cancelled dependency 或复活 parent；
7. 没有 child 的旧任务保持一次 commit 完成；
8. 同 Attempt 多次 delegate 仍全部成功，不能因第一个 delegate 立即挂起。

## 7. 其他非阻断意见

### 7.1 lease optional 兼容口

`TaskDispatchContext.lease` 和 service guard 仍为 optional，注释声明只供 legacy/test caller。当前生产
AgentTaskRunner 会补齐，因此不是本轮竞态根因；但长期建议把生产 delegate port 与 legacy test helper
分开，使生产入口 fail closed，而不是依赖“调用路径应当总会带 lease”的约定。

### 7.2 reconciliation N+1

reconciler 对 orphan 和 waiting parent 逐行处理。V1 容量可接受，后续在 dependency 规模扩大后可改为
bounded batch + `SKIP LOCKED`，不应在本轮 P0 修复中顺带扩大范围。

### 7.3 不新增 Code 任务管理器

当前问题只需要修正 Engine 的 Attempt/dependency 提交协议。继续保持一次 `tasks.delegate` 一个显式
Assignment，由 Code 用语言结构组织，是更符合现有架构的方案。

## 8. 验证证据

### 8.1 任务逻辑定向测试

非 PG 路径：

```text
5 files passed
72 tests passed
```

真实 PostgreSQL 路径（沙箱外连接本机 OrbStack/Testcontainers）：

```text
6 files passed
72 tests passed
```

覆盖 schema、task store、repository、control service、notifier、reconciler、runner、interpreter 与
gateway route。合并计算为 144 个相关测试均有通过证据。

### 8.2 新增验收探针

```text
1 temporary PG probe passed
```

这里的“passed”表示探针成功确认当前错误行为：parent 首次 commit 得到 `committed=true/completed`。
它不是功能通过证明。

### 8.3 静态与架构检查

PTH 完整 `npm run lint -- --noEmit` 通过，包括：

- TypeScript；
- pth-boundaries；
- import cycles；
- pth-config；
- role conservation；
- product boundaries；
- TCE coverage；
- docs links；
- duplication 非阻断扫描。

dsh-interface：

- `npm test`：2/2；
- 三个运行入口 `node --check`：通过；
- `npm pack --dry-run --json`：通过。

## 9. 第三轮通过门槛

- [ ] terminal child 在 parent 首次 commit 前完成时，parent 不得直接 terminal；
- [ ] parent 必须至少经历一次可恢复的 replay/消费阶段；
- [ ] terminal-before-fence 路径不依赖已经错过的 notifier 事件；
- [ ] terminal failure observation 同样进入父综合；
- [ ] recursive cancel + late outcome 有真实 PG 回归测试；
- [ ] 现有 144 个相关测试继续通过；
- [ ] 新协议不引入 Code task manager/fanout/barrier DSL；
- [ ] PTH 与 dsh 本地提交推送/合并后再进入受控试运行。

## 10. 最终意见

第三轮确认了第二轮架构修复的主体是正确的：Engine 在 commit 边界释放 lease，Code 可以一次声明
多个 child，外部 dsh 仍只负责编译和提交 Entry Task。当前只剩一个小范围但高严重度的状态机缺口：

> **Engine 必须区分“依赖已经终态”和“当前父 Attempt 已经消费过依赖结果”。**

补上持久 Attempt/epoch 标记和相反时序测试后，再进行第四轮验收；在此之前不建议把任务逻辑标记为
完成或推入生产试运行。
