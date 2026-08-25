# FRACTA 任务逻辑施工反馈报告

> 状态：**施工中；边界已裁决，工作区实现尚未达到合并验收条件**  
> 日期：2026-08-26  
> PTH 提交基线：`cd40af0`（`pi-triple-pth/main`）  
> 外部接口提交基线：`3ed14e5`（`dsh-pth-interface/main`）  
> 检查范围：持久化子任务委派、Engine 依赖与结果回流、Code 最小任务能力、dsh-interface 入口任务闭环  
> 上位裁决：[Engine 任务边界与 Code 层最小提交能力复审](./engine-task-boundary-and-minimal-code-submission-report-2026-08-26.md)  
> 关联设计：[持久化子任务委派设计](../design/persistent-child-delegation-design.md)、[实施方案](../plan/persistent-child-delegation-implementation-plan.md)

## 0. 执行摘要

本任务的架构方向已经基本校正：

```text
User Request
  → dsh-pth-interface 编译 Entry Task Submission
  → FRACTA engine 持久化、路由并执行角色化 LLM 推理
  → 当前 RoleRun 的 Code 按需调用 tasks.delegate 声明直接子任务
  → Engine 建立依赖、释放 lease、执行 child、回流结果并重新调度 parent
```

这条路径没有把 Engine 迁到 Code，也没有给 Code 新建任务管理器。Code 只获得窄的持久化子任务
提交能力；claim、lease、retry、dependency、cancel propagation、结果回流和 worker 并发继续归
Engine 所有。这一边界符合当前项目定位，应继续保持。

当前工作区已经实现了 M1/M2/M5 的大部分结构，并开始补齐 M4 外部接口闭环；但不能按实施方案
中的“**M1–M5 全部落地**”直接认定完成，原因如下：

1. PTH 和 dsh-interface 的相关修改均尚未提交；
2. 52 个直接涉及 PostgreSQL schema、事务、dependency 和 notifier 的测试全部因缺少
   `TEST_DATABASE_URL` 跳过；
3. `submissionKey` 的并发幂等仍有竞争窗口，所谓 canonical digest 也不是语义稳定序列化；
4. 递归取消仍沿 legacy payload 遍历，没有以 `task_dependencies` 为事实来源；
5. M3 的角色提示和端到端恢复轨迹仍停留在 `delegate → await` 旧模型；
6. dsh 后台任务取消没有传 `recursive: true`，与模型工具和文档承诺不一致；
7. 当前定向路由测试存在一个稳定失败。

因此，本报告的结论是：

> **任务逻辑已经从“设计讨论”进入“协议实现”阶段，但尚未通过持久化、并发与端到端闭环验收。
> 当前适合继续施工和联调，不适合发布或把 M1–M5 标记为已验收。**

## 1. 任务边界检查

### 1.1 四层责任

| 层次 | 本轮应拥有 | 本轮不应拥有 |
|---|---|---|
| 外部 Agent 应用 | 用户澄清、根目标保真、入口角色选择、入口幂等、暂停问答、状态展示 | Engine 内部角色拓扑、claim、lease、retry |
| FRACTA Engine | 角色化推理、任务树、持久依赖、调度、恢复、取消、结果信封 | 用户会话产品逻辑 |
| TCE Code | 当前 RoleRun 内的判断、循环、条件分支和 `tasks.delegate` 声明 | list/poll/claim/retry/requeue/worker 控制 |
| Execute / task service | 把已授权 delegate 调用落成事务写入和状态迁移 | 决定为什么派生、派给哪个角色 |

### 1.2 对“是否需要 Code 层任务管理能力”的结论

不需要。当前最小能力仍应是：

```ts
tasks.delegate({
  submissionKey,
  to,
  title,
  text,
  context,
  expect,
  dependency: "required",
})
```

多任务由宿主语言的数组、循环和条件表达；Engine 自动持久化 required dependency 并在结果到齐
后恢复 parent。基础版不增加 `tasks.fanout`、barrier、participant、quorum、任意任务查询或 worker
管理接口。

这并不削弱 LLM 能动性。LLM 仍然决定任务分解、角色、查询方向和收敛方式，只是不能接管
Engine 的生命周期状态机。

## 2. 当前施工事实

### 2.1 PTH 工作区

当前 PTH 工作区相对 `cd40af0` 有 18 个已跟踪文件修改，并新增设计、计划、reconciler、metrics
和测试文件。主要落点如下：

| 能力 | 当前实现事实 | 状态判断 |
|---|---|---|
| 提交契约 | 增加 `submissionKey`、`specDigest`、dependency 和结果信封类型 | 已编码，非 PG 单测通过 |
| 持久表 | 增加 `task_submissions`、`task_dependencies` 和 `waiting_dependency` | 已编码，真实 PG 未验证 |
| 原子发布 | `delegate()` 要求 `publishInTx`，child/submission/dependency 放入同一事务 | 方向正确，真实 PG 未验证 |
| admission | 增加 per-parent child/open dependency 上限 | 已编码 |
| 终态 fencing | parent 存在 pending dependency 时不能提交 completed/retryable 终态 | 已编码，真实 PG 未验证 |
| 结果回流 | notifier 更新 dependency outcome，由 reconciler 恢复 parent | 已编码，真实 PG 未验证 |
| reconciliation | 新增 dependency reconciler 处理事件遗漏 | 已编码，测试因无 PG 跳过 |
| 观测 | 新增提交、冲突、admission、dependency 状态指标 | 已编码，纯逻辑测试通过 |
| group 语义 | 继续保持关闭 | 符合基础版范围 |

### 2.2 dsh-pth-interface 工作区

外部接口仓库基线仍为 `3ed14e5`，7 个文件存在未提交修改，主要包括：

- `pth_submit` 增加独立 `goal`；
- 增加 `idempotencyKey` 和本地 fingerprint 冲突检查；
- 增加 `pth_answer`，补齐暂停任务的发布者问答；
- 后台 watcher 增加 paused / waiting-human 通知；
- `pth_cancel` 默认声明递归取消任务树；
- 更新 interface preset 和中英文说明。

这使 dsh 更接近“用户需求 → Entry Task Submission 的编译器与生命周期代理”，方向正确。
dsh background job 仍只是 PTH task 的用户体验投影，没有形成第二套任务调度器。

### 2.3 里程碑复核

| 里程碑 | 计划声明 | 本报告复核 |
|---|---|---|
| M0 范围冻结 | 完成 | 完成；边界已裁决 |
| M1 持久化提交 | 已实施 | 工作区实现完成度较高，但 PG 与并发验收未完成 |
| M2 自动依赖与回流 | 已实施 | 结构已落地，关键测试全部跳过 |
| M3 语言级多提交 | 已实施 | 部分完成；旧 prompt/await 路径和端到端恢复未收口 |
| M4 外部 interface | 本地修改已实施 | 施工中；未提交且取消语义不一致 |
| M5 观测后决定 group | 已实施 | 指标已落地，group 保持关闭；符合范围 |

## 3. 验证证据

### 3.1 PTH 定向测试

执行：

```bash
npm test -- \
  test/pth-contracts/task-submission.test.ts \
  test/pth-kernel-storage/schema-dependencies.test.ts \
  test/pth-tasking/pg-task-repository.test.ts \
  test/pth-tasking/task-control-service.test.ts \
  test/pth-tasking/task-dispatch-notifier.test.ts \
  test/pth-tasking/task-dependency-reconciler.test.ts \
  test/pth-tasking/task-dependency-metrics.test.ts \
  test/pth-kernel-interpreter/tasks-capability.test.ts \
  test/pth-runner/agent-task-runner.test.ts
```

结果：

- 4 个测试文件通过，5 个跳过；
- 27 个测试通过，52 个跳过；
- 被跳过的正是 schema、PG repository、control service、notifier 和 reconciler 用例。

因此，27/27 只能证明契约、能力注入、runner 旧挂起映射和 metrics 的非数据库逻辑，不能证明
事务幂等、锁、CAS、依赖回流或重启恢复。

### 3.2 已知失败

执行：

```bash
npm test -- test/pth-gateway/kernel-routes.test.ts -t '取消并支持递归传播'
```

结果：1 个测试失败，期望 HTTP 200，实际 HTTP 400。直接原因是 `cancel()` 已改为事务实现并要求
`pool.connect()`，而该路由测试的 fake pool 仍只实现 `query()`。这更像测试桩未跟上端口变化，
但在修复并重新通过前，合并门仍然是红色。

### 3.3 仓库级检查

本轮审计中：

- `npm run lint` 通过；
- `npm run build` 通过；
- `git diff --check` 通过；
- 全量 `npm test` 受缺失 Redis/PostgreSQL/端口依赖影响，未形成可采信的全绿结论。

### 3.4 dsh-interface 检查

- `node --check lib/index.js` 通过；
- `node --check preset/pth-interface/pth-interface.mjs` 通过；
- `npm pack --dry-run --json` 通过；
- 仓库没有覆盖本轮任务闭环的正式测试脚本。

## 4. 主要问题与优先级

### P0-1：数据库协议没有被实际验证

本轮的核心价值恰好位于 PostgreSQL：原子创建、唯一键、依赖状态、terminal fencing、notifier、
reconciliation 和取消传播。但相关 52 个测试全部跳过。

收口要求：

1. 提供隔离的 PostgreSQL 测试实例；
2. 跑完当前所有 PG 用例；
3. 增加进程重启后 reconciliation 恢复测试；
4. 增加两个并发连接提交同一 key 的测试；
5. 在失败注入下证明 child/submission/dependency 要么全部提交，要么全部回滚。

### P0-2：`specDigest` 不是 canonical digest

`task-control-service.ts` 当前直接对包含 `context` 和 `expect` 的对象执行 `JSON.stringify()`。
嵌套对象键顺序不同会产生不同摘要，即使两份任务规格在语义上完全一致。

应采用稳定键排序序列化，并把以下规范写入 contracts：

- `undefined`、缺省字段与 `null` 是否等价；
- 数组是否保持顺序；
- Unicode 是否归一化；
- 数字和日期如何编码；
- 哪些服务端派生字段进入摘要。

### P0-3：并发同 key 不能保证返回同一 child

当前顺序是：

```text
SELECT existing submission
  → publish child
  → INSERT task_submissions
```

两个事务并发执行时可能都看不到 existing，随后其中一个在唯一键上失败。失败事务通常会回滚其
child，但调用者得到的是约束错误，而不是幂等复用结果，不满足“同 key 同 spec 返回同一 child”
的强契约。

建议使用 advisory lock 或 key row lock；也可用 `INSERT ... ON CONFLICT` 后重新读取 authoritative
mapping，并在同一事务中校验 digest。

### P1-1：递归取消没有以 dependency 表为事实来源

当前递归 CTE 沿 `tasks.payload.delivery.parent.taskId` 查找子树，随后才更新
`task_dependencies`。这使 legacy payload 和正式 dependency 表并存为两套图来源。

应改为沿 `task_dependencies(parent_task_id, child_task_id)` 遍历；payload 只保留展示和兼容信息。

### P1-2：M3 仍使用旧的 `delegate → await` 心智模型

内置角色 prompt 仍要求 worker 在 delegate 后调用 `tasks.await`；runner 测试也只证明
`task-await-suspended` 会映射为 retryable outcome。新协议的目标应是：

```text
首次 RoleRun：多次 delegate → parent 被 Engine fence 为 waiting_dependency
child terminal：dependency outcome 持久化 → parent 恢复 pending
恢复 RoleRun：相同 submissionKey 重放 delegate → 直接获得 terminal envelope
```

需要更新 prompt、示例和测试，证明程序重跑不会复制 child，并最终消费结果信封完成 parent。
`tasks.await/resume` 可暂时保留兼容，但不再作为新路径的必要步骤。

### P1-3：dsh 后台取消与工具取消语义不同

模型工具 `pth_cancel` 明确发送 `recursive: args.recursive !== false`；但后台 job 的 `cancel()` 只发送
`{ reason }`。因此从 dsh 后台任务 UI 取消时，默认不会递归取消整棵任务树。

应让后台取消显式发送 `recursive: true`，并用一个 fake HTTP server 测试两条入口得到相同请求。

### P1-4：重复暂停通知会丢失

watcher 的 `pausedNotified` 一旦置为 true，在任务恢复到 active 状态后不会重置。同一任务第二次
进入 paused / waiting-human 时可能不再通知。

应按“暂停事件或问题 revision”去重，而不是按整个 task 生命周期使用单个布尔值。

### P2-1：计划状态超前于证据

实施方案头部写为“M1–M5 全部落地”，容易把“文件中已有实现”误读为“已提交且已验收”。建议改为：

> M1–M5 已形成工作区实现；PG 集成、并发幂等、M3 恢复闭环与 M4 接口验收未完成。

## 5. 不应在本轮增加的内容

以下内容不会解决当前阻塞，反而会增加第二套任务控制面：

- `tasks.fanout`、participant、barrier、quorum；
- Code 侧 list/poll/claim/retry/requeue；
- worker replica 或容器控制；
- 复杂 ResearchPlan、EvidenceLedger 或 Deep Research workflow；
- 为 fan-out 单独增加监控层或 watchdog。

现有任务级、进程级、容器级监控继续复用即可。需要补充的是协议指标和告警阈值，不是新的
监控层级。

## 6. 建议收口顺序

1. 冻结当前 schema 和 API，先不要继续扩展 group 语义；
2. 修正 stable digest 和并发同 key 收敛；
3. 以 `task_dependencies` 统一依赖、恢复和递归取消图；
4. 启动真实 PostgreSQL，跑完 52 个当前跳过的测试；
5. 补“首次提交 → 子任务终态 → parent 恢复 → delegate 重放 → parent 完成”的端到端测试；
6. 更新角色 prompt，使 replay-safe delegate 成为主路径；
7. 修复 dsh 后台递归取消和重复暂停通知，增加最小接口测试；
8. PTH 与 dsh-interface 分仓、分提交落地，再更新计划状态。

## 7. 完成判据

只有同时满足以下条件，才建议把本任务标记为完成：

- [ ] PTH 相关修改已提交，工作区无遗漏文件；
- [ ] dsh-interface 相关修改已提交；
- [ ] 所有 PG 定向测试在真实数据库上通过；
- [ ] 并发同 key 同 spec 返回同一 child；
- [ ] 同 key 不同 spec 稳定返回冲突且不产生孤儿 child；
- [ ] parent 有未决依赖时不可完成、不可被 claim；
- [ ] notifier 丢事件后 reconciler 能恢复 parent；
- [ ] dependency 表是递归取消的事实来源；
- [ ] replay-safe 多提交端到端测试通过；
- [ ] dsh 提交、暂停问答、完成通知、递归取消均有自动测试；
- [ ] `npm run lint`、定向测试、全量测试和 build 全部通过。

## 8. 最终反馈

本轮最重要的成果不是增加了多少任务 API，而是把边界收敛到了正确位置：外部应用编译用户需求，
Engine 管角色化推理和持久任务生命周期，Code 只声明当前 RoleRun 需要的新工作。

下一阶段应把精力集中在协议正确性和恢复证明上，而不是继续增加 fan-out 或 Code 任务管理能力。
只要 canonicalization、并发幂等、dependency truth source、PG 集成和 dsh 闭环得到验证，这条任务
逻辑就足以支持后续高广度网络研究；复杂研究策略仍可留给未来版本的 Agent/Code 组合实现。
