# 持久化子任务委派实施方案（V1 细化版）

> 状态：**第二轮反馈已处理——P0 lease/Attempt 边界修复、真实 PostgreSQL 全量验收通过；M3 端到端轨迹与提交仍待收口**
> 前置设计：`docs/pth/design/persistent-child-delegation-design.md`
> 上位报告：`docs/pth/report/engine-task-boundary-and-minimal-code-submission-report-2026-08-26.md`
> 原则：每阶段可独立合并、独立回滚；先契约后实现；保持单角色、无 child 的旧任务完全兼容。

---

## 阶段总览

| 阶段 | 内容 | 关键产物 |
|---|---|---|
| M0 | 冻结范围 | 暂停多角色共享任务方案 |
| M1 | 持久化提交 | `submissionKey`、幂等、admission |
| M2 | Engine 自动依赖与回流 | dependency 表、waiting_dependency、reconciliation、terminal fencing |
| M3 | 语言级多提交 | replay-safe delegate；await/resume 兼容 |
| M4 | 外部 interface 闭环 | dsh-pth-interface 侧闭环 |
| M5 | 观察后再决定 group 语义 | 数据观测与触发条件 |

---

## M0：冻结范围

### 动作

- 将多角色共享任务设计/实施方案标记为“历史备选/暂停”。
- 不创建 `task_participants`。
- 不改变 tag 的单入口路由语义。
- 不扩展 Flow/Trigger 为多参与者广播。
- 不实现 `tasks.fanout`、participant、barrier、quorum/any DSL。

### 出口

- 文档状态一致；无代码改动。

---

## M1：持久化提交

### 1.1 契约类型（`packages/pth-contracts/src/tasking-types.ts`）

新增：

```ts
export interface ChildTaskSubmissionV1 {
  submissionKey: string;
  to: string;
  title: string;
  text: string;
  context?: Record<string, unknown>;
  domains?: string[];
  expect?: "result" | "artifact" | "report";
  dependency?: "required";
}

export interface ChildOutcomeEnvelopeV1 {
  status: "completed" | "rejected" | "cancelled" | "escalated";
  summary: string;
  provenance: readonly string[];
  artifactRefs: readonly string[];
  error?: { family: string; message: string; retryable: false };
}

export interface PublisherQuestionEnvelopeV1 {
  questionId: string;
  prompt: string;
  childTaskId: string;
}

export interface ChildTaskRefV1 {
  taskId: string;
  submissionKey: string;
  roleId: string;
  path: readonly string[];
  state: "submitted" | "running" | "paused" | "terminal";
  observation?: ChildOutcomeEnvelopeV1;
  question?: PublisherQuestionEnvelopeV1;
}
```

修改：

```ts
export interface TaskDelegateInput {
  // ...现有字段
  submissionKey?: string;   // 新增
}

export interface TaskDelegateResult {
  taskId: string;
  roleId: string;
  path: readonly string[];
  // 新增
  submissionKey: string;
  state: ChildTaskRefV1["state"];
  observation?: ChildOutcomeEnvelopeV1;
  question?: PublisherQuestionEnvelopeV1;
}
```

新增校验（`tasking-validation.ts`）：

- `submissionKey` 若提供：`1..128` 字符、非空、`/^[A-Za-z0-9:_@.-]+$/`；
- `dependency` 仅允许 `"required"`（V1 不开放 detached）。

### 1.2 数据库（`packages/pth-kernel-storage/src/schema.ts`）

新增表：

```sql
CREATE TABLE IF NOT EXISTS task_submissions (
  tenant_id       TEXT NOT NULL,
  parent_task_id  TEXT NOT NULL,
  child_task_id   TEXT NOT NULL,
  submission_key  TEXT NOT NULL,
  spec_digest     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, parent_task_id, submission_key),
  UNIQUE (tenant_id, child_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_submissions_parent
  ON task_submissions(tenant_id, parent_task_id);
CREATE INDEX IF NOT EXISTS idx_task_submissions_child
  ON task_submissions(tenant_id, child_task_id);
```

新增 `PTH_TASK_MAX_CHILDREN_PER_PARENT` 与 `PTH_TASK_MAX_OPEN_DEPENDENCIES_PER_PARENT` 配置项（`packages/pth-config/src/schema.ts`），默认例如 50 / 20。

### 1.3 服务端实现（`src/pth/tasking/task-control-service.ts`）

`delegate()` 增加步骤：

1. 解析并校验 `submissionKey`；
2. 计算 canonical spec digest：
   ```ts
   function canonicalSpecDigest(input: TaskDelegateInput): string {
     const canonical = JSON.stringify({
       to: input.to,
       title: input.title,
       text: input.text,
       context: input.context ?? null,
       domains: input.domains ?? null,
       expect: input.expect ?? null,
       dependency: input.dependency ?? "required",
     });
     return createHash("sha256").update(canonical).digest("hex");
   }
   ```
3. 若 `submissionKey` 存在：
   - 查 `task_submissions`；
   - 命中且 `spec_digest` 相同 → 返回既有 ChildTaskRef；
   - 命中且 `spec_digest` 不同 → 抛 `PtcContractError("tasks.delegate", "submissionKey conflict")`；
4. 执行现有组织权/domain/模板校验；
5. admission：
   - `COUNT(*) FROM task_submissions WHERE tenant_id=$1 AND parent_task_id=$2` ≥ 上限 → 拒绝；
   - 未决依赖数 ≥ 上限 → 拒绝；
6. 在**同一事务**内：
   - `tasks.publish` 创建 child（现有 delegateTarget 路径）；
   - 插入 `task_submissions`；
   - 若 `submissionKey` 缺省，用 `spec_digest` 派生 key 并标记 `derived=true`（表加列 `derived BOOLEAN NOT NULL DEFAULT FALSE`）。
7. 返回 `TaskDelegateResult` 增强字段。

事务原子性处理：

- 若继续使用 `TaskControlService` 的 `pool` 直连，新增 `withTx` 包装：先 `store.publish` 不能参与外部事务时，需要扩展 `TaskStore` 提供 `publishInTx(client, input)` 或在 service 内直接 SQL 插入 child。**建议**：在 `PgTaskStore` 增加 `publishInTx(client, input)`，供 service 在事务内调用。

### 1.4 测试（M1）

- `test/pth-contracts/task-submission.test.ts`：类型/校验。
- `test/pth-tasking/task-control-service.test.ts`：
  - 同 key 同 digest → 返回同一 taskId；
  - 同 key 异 digest → conflict；
  - 不同 key 同 role → 两个 child；
  - 无 submissionKey → 派生 key；
  - 超 child 上限 → 拒绝且不创建；
- `test/pth-kernel-storage/task-store-pg.test.ts`：`publishInTx` 与 `task_submissions` 唯一约束。

### 1.5 出口

- 父重跑后重复 delegate 同 key 不重复创建；
- 同 key 异 digest 明确 conflict；
- admission 在写入前拒绝超限。

---

## M2：Engine 自动依赖与回流

### 2.1 状态与 schema

- `tasks.status` CHECK 增加 `'waiting_dependency'`。
- 新增 `task_dependencies` 表（真相源）：

```sql
CREATE TABLE IF NOT EXISTS task_dependencies (
  tenant_id        TEXT NOT NULL,
  parent_task_id   TEXT NOT NULL,
  child_task_id    TEXT NOT NULL,
  submission_key   TEXT NOT NULL,
  spec_digest      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','satisfied','failed','cancelled')),
  outcome_envelope JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, parent_task_id, submission_key),
  UNIQUE (tenant_id, child_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_parent
  ON task_dependencies(tenant_id, parent_task_id, status);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_child
  ON task_dependencies(tenant_id, child_task_id);
```

说明：

- `task_submissions` 负责“提交幂等”；`task_dependencies` 负责“生命周期真相”。
- 两者可合并，但拆分更清晰：submission 表记录创建映射，dependency 表记录状态。

### 2.2 `delegate()` 自动建立依赖

在 M1 事务内继续：

- 插入/更新 `task_dependencies`（status=`pending`）；
- 父任务状态改为 `waiting_dependency`；
- 释放父任务 lease（清 `lease_id/lease_generation/lease_expires_at/claimed_by/claimed_at`）。

### 2.3 父任务终态 fencing（`src/pth/tasking/adapters/pg-task-repository.ts`）

`commit()` 中：

- `completed` 分支在同一事务内先检查：
  ```sql
  SELECT 1 FROM task_dependencies
  WHERE tenant_id=$1 AND parent_task_id=$2 AND status='pending'
  LIMIT 1
  ```
- 存在未解决依赖 → 不置 completed，改为：
  - `status='waiting_dependency'`
  - 清 lease
  - 返回 `committed:false`（或新语义 `fenced:true`，由调用方区分）；
- 不存在 → 正常 completed + side effects。

### 2.4 候选查询排除等待父任务

`PgTaskRepository.claim()` 与 `PgTaskStore.candidates()`：

- 候选条件增加 `status NOT IN ('waiting_dependency')`；
- `task-queries.pending()` 同步排除。

### 2.5 子任务终态回流（`src/pth/tasking/task-dispatch-notifier.ts`）

`handle(childTaskId)` 扩展：

1. 查 `task_dependencies` 中 `child_task_id=$1`；
2. 若命中：
   - 根据 child status 构造 `ChildOutcomeEnvelopeV1`；
   - 更新 dependency 行：
     - child completed → `status='satisfied'`，写 envelope；
     - child rejected/cancelled/escalated → `status='failed'`，写 envelope；
   - 保留现有 `payload.childResult` 写回（兼容 await/resume）；
3. 判断父任务是否所有 required dependencies 已终态：
   - 若无 `status='pending'` 的依赖 → 父任务从 `waiting_dependency` 转回 `pending`（requeue）；
   - 事件仍只做低延迟提示。

### 2.6 Reconciliation（新增 `src/pth/tasking/task-dependency-reconciler.ts`）

- 启动扫描 + 周期扫描（默认 30s，可配置）。
- SQL 逻辑：
  1. 找出所有 `status='waiting_dependency'` 的父任务；
  2. 检查其 `task_dependencies` 是否全部终态；
  3. 全部终态 → requeue 父任务；
  4. 有孤儿 child（child 终态但 dependency 未更新）→ 按 child 终态补写 envelope 并推进。
- 装配：`src/pth/kernel/assembly.ts` 中与 `TaskDispatchNotifier` 并列启动/停止。

### 2.7 取消传播

- `TaskControlService.cancel()` 扩展：
  - 递归 CTE 沿 `task_dependencies` 的 parent→child 边；
  - 取消 child 时同时更新对应 dependency 行为 `cancelled`；
  - 晚到 child outcome 因 dependency 已 cancelled 被拒绝（CAS 条件含 dependency status）。

### 2.8 测试（M2）

- `test/pth-kernel-storage/schema-dependencies.test.ts`：表结构、状态 CHECK、唯一约束。
- `test/pth-tasking/task-dependency-reconciler.test.ts`：
  - 事件丢失后 reconciliation 能 requeue 父任务；
  - 孤儿 child 终态补写。
- `test/pth-tasking/pg-task-repository.test.ts`：
  - 存在 pending dependency 时 completed commit 被 fence；
  - 无依赖时正常 completed。
- `test/pth-tasking/task-control-service.test.ts`：
  - delegate 后父任务进入 waiting_dependency；
  - child 终态后父任务 requeue。
- `test/pth-tasking/task-dispatch-notifier.test.ts`：dependency 状态更新。

### 2.9 出口

- 父任务在 child 未终态时不可 claim、不可 completed；
- 进程重启后 reconciliation 能最终唤醒父任务；
- 旧单角色无 child 任务行为不变。

---

## M3：语言级多提交

### 3.1 能力实现

- `tasks.delegate` 的 interpreter 能力（`packages/pth-kernel-interpreter/src/extensions/tasks.ts` 或等价位置）：
  - 返回 `TaskDelegateResult`（含 `submissionKey/state/observation/question`）；
  - 不再要求模型先 `await` 再 `resume`：重复 delegate 直接返回当前状态/终态信封。
- `tasks.await/resume` 保留兼容，但文档/提示词引导新写法。

### 3.2 示例（文档/测试）

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

### 3.3 测试（M3）

- `test/pth-kernel-interpreter/tasks-capability.test.ts`：
  - delegate 返回 ChildTaskRef；
  - 重跑同 key 返回既有 taskId + observation。
- `test/pth-runner/agent-task-runner.test.ts`：
  - 父任务重跑不重复派生；
  - 未终态 child 时 done 被 fence；
  - 全部终态后父任务可 completed。

### 3.4 出口

- 同一父任务可向同一 role 提交多个不同 key；
- 重跑后 child 不重复创建，结果可靠回流。

---

## M4：外部 interface 闭环

> 状态：**已实施（dsh-pth-interface 本地修改）**

### 4.1 `dsh-pth-interface`（外部仓库）

- `pth_submit` 透传独立 `goal`；
- 增加 `idempotencyKey` 与 fingerprint 冲突检查；
- 明确只选择一个入口 role；
- 增加 `pth_answer(taskId, answer)`；
- watcher 将 paused/waiting-human 映射为用户通知；
- `pth_cancel` 透传 recursive；
- 修正文档中“等待”与工具数量文案。

### 4.2 测试/验收

- interface 提交入口任务可带 goal；
- paused 问题能上送用户并回传 answer；
- 入口取消作用于整棵任务树。

---

## M5：观察后再决定 group 语义

> 状态：**已实施（观测指标已落地；group 语义仍不开放）**

### 5.1 观测指标

在现有 metrics/观测面增加：

- `pth_task_submissions_total{parent_role,child_role,derived}`
- `pth_task_dependency_status_total{status}`
- `pth_task_waiting_dependency_age_seconds`
- `pth_task_dependency_reconcile_repairs_total`
- `pth_task_submission_conflict_total`
- `pth_task_admission_rejected_total{reason}`

### 5.2 触发条件

满足任一才重开 group primitive 设计：

- 多个 child 必须全部创建或全部不创建；
- 外部消费者确实需要独立 group ID；
- 服务端必须承诺 quorum/any；
- 必须在执行前原子预留 group 预算；
- 必须提供 task-local 公平配额或最大并发；
- 实测逐项持久化提交产生不可接受的事务开销。

### 5.3 出口

- 未满足条件前，不新增 `tasks.fanout` / participant / barrier。

---

## 验收矩阵

| 场景 | 预期 |
|---|---|
| 父重跑后重复提交同 key | 返回同一 child，不重复创建 |
| 同 key、不同 canonical spec | 返回 conflict |
| 同父、不同 key、同一 role | 创建多个独立 child |
| 越权 role submission | 写前 fail-fast |
| child 运行期间 | 父 lease 已释放 |
| child 运行期间扫描候选 | waiting parent 不可 claim |
| child terminal | 父自动 requeue，收到有界 envelope |
| 终态事件丢失 | reconciliation 最终唤醒 |
| required child 未终态时父 done | 父不得提前 terminal |
| 旧任务无 child | 完全兼容 |

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 自动 required dependency 形成隐式等待 | trace/status 显示 pendingDependencies |
| 父重跑重复副作用 | submissionKey + 能力幂等 + artifactRef |
| LLM 生成不稳定 key | 语义固定 key + canonical digest |
| 子任务无限派生 | 写入前 child/lineage admission |
| outcome 撑大上下文 | 有界信封 + artifactRef + 认知预算 |
| 进程事件丢失 | PG dependency 真相 + reconciliation |
| await/resume 双语义 | 兼容期保留，不批量删除 |
| 事务原子性不足 | `publishInTx` + service 级 `withTx`；child+dependency+submission 同事务 |
