# 任务逻辑整改实施方案：多角色共享任务

> 状态：**待实施**
> 前置设计：`docs/pth/design/task-logic-multi-role-collaboration-design.md`
> 原则：每阶段可独立合并、独立回滚；先契约后实现；保持单角色任务兼容。

---

## 阶段总览

| 阶段 | 内容 | 关键产物 |
|---|---|---|
| P0 | 契约与类型 | contracts 扩展、participant 类型 |
| P1 | 数据库 schema 与迁移 | `task_participants` 表、tasks.participants 列 |
| P2 | Tag 与路由 | 多 role tag 解析、checkTaskRouting 新语义 |
| P3 | 存储层 | publish 创建 participants、candidates/claim/commit 按参与者 |
| P4 | 执行层 | TaskLoop/Dispatcher 参与者租约、工作空间隔离、聚合 |
| P5 | Flow/Trigger 扩展 | FlowSpec/Decompose/Trigger 支持 roles/participants |
| P6 | API/CLI/观测 | HTTP、CLI、事件、指标 |
| P7 | 回归与文档 | 全量测试、兼容性验收、文档同步 |

---

## P0：契约与类型

### 目标

在 `@away_from/pth-contracts` 钉死参与者领域类型，作为后续所有层级的单一事实源。

### 改动文件

- `packages/pth-contracts/src/tasking.ts`（或新增 `participants.ts`）

### 新增类型

```ts
export type ParticipantMode = "required" | "optional";
export type ParticipantStatus = "pending" | "claimed" | "completed" | "rejected" | "skipped";
export type TaskCompletionPolicy = "all" | "quorum" | "any";

export interface TaskParticipantDecl {
  role: string;
  mode?: ParticipantMode;
  skipOnReject?: boolean;
}

export interface TaskParticipantState extends TaskParticipantDecl {
  mode: ParticipantMode;
  status: ParticipantStatus;
  claimToken?: string;
  claimGeneration: number;
  claimedBy?: string;
  leaseExpiresAt?: string;
  contribution?: unknown;
  completedAt?: string;
}

export interface TaskParticipantOutcome {
  roleId: string;
  status: "completed" | "rejected" | "skipped";
  contribution?: unknown;
  error?: { code: string; message: string };
}
```

### 扩展既有接口

- `PublishInput` 增加 `participants?: TaskParticipantDecl[]`、`completionPolicy?: TaskCompletionPolicy`、`minRequired?: number`。
- `TaskWorkItem` 增加 `participants?: TaskParticipantState[]`（当前参与者视角）、`completionPolicy`、`minRequired`。
- `TaskRepository` 增加参与者级方法（见 P3）。
- `TaskOutcome` 保持现有形状，但 lease 语义扩展为 participant lease。

### 测试

- `test/pth-contracts/task-participants.test.ts`：类型校验、mode 默认值、结构合法性。

### 出口

- `npm run build` 通过；contracts 层类型可被上下游引用。

---

## P1：数据库 schema 与迁移

### 目标

落地 `task_participants` 表与 `tasks.participants` 列，并保证可重复执行迁移。

### 改动文件

- `packages/pth-kernel-storage/src/schema.ts`

### 变更

```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS participants JSONB NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completion_policy TEXT NOT NULL DEFAULT 'all'
  CHECK (completion_policy IN ('all','quorum','any'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS min_required INTEGER;

CREATE TABLE IF NOT EXISTS task_participants (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'required' CHECK (mode IN ('required','optional')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','completed','rejected','skipped')),
  skip_on_reject BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token UUID,
  claim_generation BIGINT NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  contribution JSONB,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, role_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_task_participants_role
  ON task_participants(tenant_id, role_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_task_participants_task
  ON task_participants(tenant_id, task_id, status);
```

### 迁移策略

- 新发布任务：`publish` 事务内同时写 tasks 与 participants。
- 存量任务：提供幂等 backfill SQL/脚本，为未终态任务按 `assigned_role` 补一行 required participant。
- 不强制回填全部历史终态任务。

### 测试

- `test/pth-kernel-storage/schema-participants.test.ts`：迁移幂等、外键、状态 CHECK。
- 现有 `task-store-pg.test.ts` 继续通过。

### 出口

- `applySchema` 可重复执行；旧库升级不丢数据。

---

## P2：Tag 与路由

### 目标

让多个 role tag 合法且解析为多个参与者；`checkTaskRouting` 返回 participants。

### 改动文件

- `packages/pth-kernel-execution/src/execution/tag-registry.ts`
- `packages/pth-kernel-execution/src/execution/role-router.ts`
- `src/pth/catalog/role-routing-policy.ts`

### 变更

1. `TagRegistry` 新增：

```ts
routeRoles(tags: string[]): { ok: true; roles: string[] } | { ok: false; error: string }
```

- 只收集 `kind=role` 且 `role` 唯一的 tag；
- 不再返回 conflict；多个 role tag 返回多个 roles。

2. `checkTaskRouting` 改为：

```ts
checkTaskRouting(input): {
  ok: true;
  participants: TaskParticipantDecl[];
  completionPolicy: TaskCompletionPolicy;
  minRequired?: number;
} | { ok: false; error: string }
```

解析优先级：`payload.participants` > `payload.flow.stages[0].task.roles/participants` > role tags。
`completionPolicy` 解析：`payload.completionPolicy` > flow/trigger 声明 > 缺省 `all`；`quorum` 必须带合法 `minRequired`。

3. 新增 `resolveTaskParticipants(input): { participants: TaskParticipantDecl[]; completionPolicy: TaskCompletionPolicy; minRequired?: number }`，供存储层 assign 使用。

4. 保留 `routeTaskRole` 为兼容单角色函数（内部可调用 `resolveTaskParticipants` 取第一个）。

### 测试

- 更新 `test/pth-kernel-execution/role-router.test.ts`
- 更新 `test/pth-kernel-execution/tag-registry.test.ts`
- 新增：`tags:["code","test"]` → participants=[developer,tester]。

### 出口

- 旧单角色用例仍绿；多 role tag 不再报歧义。

---

## P3：存储层

### 目标

`TaskStore.publish` 创建 participants；`candidates`/`claim`/`commit` 按参与者工作。

### 改动文件

- `packages/pth-kernel-storage/src/task-store-pg.ts`
- `src/pth/tasking/adapters/pg-task-repository.ts`
- `src/pth/tasking/task-work-item-reader.ts`
- `src/pth/tasking/task-queries.ts`

### 变更

1. `publish()`：
   - 解析 `participants`（来自显式声明或路由策略）；
   - 写入 `tasks.participants` JSONB、`completion_policy`、`min_required`；
   - 同事务插入 `task_participants` 行（含 `skip_on_reject`）；
   - `assigned_role` 设为第一个 required participant（primary）。

2. `candidates(roleId)`：
   - 改为 join `task_participants`：
     ```sql
     SELECT t.*, tp.mode, tp.status AS participant_status
     FROM tasks t
     JOIN task_participants tp ON tp.tenant_id = t.tenant_id AND tp.task_id = t.id
     WHERE tp.role_id = $1
       AND tp.status = 'pending'
       AND t.status IN ('pending','claimed')
       AND t.claims_count < $2
     ```
   - 兼容回退：若表无 participant 行，按旧 `assigned_role` 查询。

3. `claim(scope, roleId, taskIds)`：
   - 改操作 `task_participants`，生成 participant lease；
   - 返回 `TaskLease`（`roleId` 为当前参与者，workspace 为 `task:{id}:{role}`）。

4. `commit(outcome)`：
   - 先 CAS 更新 `task_participants` 状态与 contribution；
   - 调用聚合器更新 tasks 终态（聚合器见 P4）。

5. 查询面：
   - `task-work-item-reader` 增加 participants 状态读取；
   - `task-queries` 返回 participants。

### 测试

- `test/pth-kernel-storage/task-store-pg.test.ts` 扩展多参与者发布/candidates。
- `test/pth-tasking/pg-task-repository.test.ts` 扩展多参与者 claim/commit。
- 保留单角色路径回归。

### 出口

- 同一任务可被两个角色同时 candidates 到；各自 claim 成功。

---

## P4：执行层与聚合

### 目标

TaskLoop/TaskDispatcher 按参与者租约执行；新增聚合器决定任务终态。

### 改动文件

- `src/pth/bootstrap/task-loop.ts`
- `src/pth/tasking/task-dispatcher.ts`
- `src/pth/tasking/task-outcome-committer.ts`
- 新增 `src/pth/tasking/task-participant-aggregator.ts`
- `src/pth/runner/*`（workspace 传入按参与者）

### 变更

1. **工作空间**：
   - `workspaceMgr.allocate(taskId, tenantId, roleId)` 支持按角色分配；
   - 多参与者使用 `task:{id}:{role}`，共享区 `task:{id}:shared`。

2. **TaskDispatcher**：
   - `dispatchOnce` 仍按 roleId + taskIds 工作，但 lease 为 participant lease；
   - 心跳续约作用于 `task_participants.lease_expires_at`。

3. **聚合器** `TaskParticipantAggregator`：
   - 输入：taskId + 刚提交的 participant outcome；
   - 读取全部 participants 与 `completion_policy`/`min_required`；
   - 按规则更新 tasks.status 与 `payload.result`：
     - `all`：所有 required completed → completed；任一 required rejected 且非 skip_on_reject → rejected；skip_on_reject 且已有其他 required completed → 该 rejected 标记 skipped
     - `quorum`：completed ≥ minRequired → completed，其余未完成 required 标记 skipped；否则若剩余可完成数不足 → rejected
     - `any`：首个 required completed → completed，其余标记 skipped
     - required 全终态后 optional 未完成 → skipped

4. **TaskLoop**：
   - `stampTaskDispatchContext` 增加当前 participant role；
   - 事件 `task.participant.claim/done/failed`；
   - 单参与者路径保持旧事件兼容。

### 测试

- `test/pth-tasking/task-participant-aggregator.test.ts`
- `test/pth-tasking/task-dispatcher.test.ts` 扩展双参与者并发执行
- `test/pth-kernel-execution/task-loop.test.ts` 扩展多参与者候选

### 出口

- 两个 required 参与者都提交后任务 completed，`payload.result.contributions` 正确；
- 任一 required rejected 任务 rejected。

---

## P5：Flow / Trigger 扩展

### 目标

让 FlowSpec 与 Trigger 能生成多参与者任务。

### 改动文件

- `packages/pth-kernel-execution/src/execution/resolver-core.ts`
- `packages/pth-kernel-execution/src/execution/task-resolver.ts`
- `packages/pth-kernel-execution/src/execution/trigger-engine.ts`
- `src/pth/gateway/routes-trigger.ts`

### 变更

1. `StageTask` 增加 `roles?: string[]`、`participants?: TaskParticipantDecl[]`、`completionPolicy?`、`minRequired?`。
2. `DecomposeSpec` 增加 `roles`/`participants`/`completionPolicy`/`minRequired`；resolver 发布时生成**一个**多参与者子任务。
3. `TriggerDef.task` 增加 `roles`/`participants`/`completionPolicy`/`minRequired`；`publishFromTrigger` 透传。
4. `routes-trigger.ts` 注册期校验 `roles`/`participants` 的角色存在性与 completionPolicy 合法性。

### 测试

- `test/pth-kernel-execution/task-resolver.test.ts`：decompose 多参与者只生成一个任务。
- `test/pth-kernel-execution/trigger-engine.test.ts`：trigger 发布多参与者任务。
- `test/pth-gateway/kernel-routes.test.ts`：API 顶层 participants。

### 出口

- Flow/Trigger 都能发布 `participants` 任务，且 TaskResolver/TriggerEngine 不破坏旧单角色 flow。

---

## P6：API / CLI / 观测

### 目标

外部可发布/查看多参与者任务。

### 改动文件

- `src/pth/gateway/routes-kernel.ts`
- `src/pth/gateway/routes-jobs.ts`
- `src/pth/gateway/routes-trigger.ts`
- `src/cli/pth-cli.ts`
- `packages/pth-console/src/bridge/client.ts`
- `src/pth/bootstrap/task-loop-helpers.ts` / 事件定义

### 变更

1. `POST /api/v1/kernel/tasks` 支持 `participants`、`completionPolicy`、`minRequired`；
2. `GET /api/v1/kernel/tasks/:id` 返回 participants 状态与 completionPolicy；
3. `pth submit --roles a,b` / 多次 `--role`，可选 `--completion all|quorum|any`；
4. `pth status`/`wait` 显示 participants 与 skipped 状态；
5. 新增事件 `task.participant.*`；
6. 指标 `pth_task_participants_total`、`pth_task_aggregate_total`。

### 测试

- `test/pth-gateway/kernel-routes.test.ts`
- `test/pth-gateway/jobs-routes.test.ts`（若有）
- `test/pth-kernel-execution/system-triggers.test.ts` 事件不回归

### 出口

- HTTP/CLI 可端到端发布并观察多参与者任务。

---

## P7：回归与文档

### 目标

全量验证与文档同步。

### 改动

- 更新 `docs/pth/orchestration.md`、`docs/pth/kernel.md`、`docs/pth/concepts.md`、`docs/pth/pth-api-protocol.md`
- 新增/更新迁移脚本说明
- 更新 `docs/docs-manifest.json`（如仓库有自动生成）

### 验收

- `npm run lint`
- `npm test`
- `npm run build`
- 手工/集成验证：
  - 单角色任务行为不变；
  - 双角色任务同时 claim、完整上下文、聚合结果正确；
  - `quorum`/`any` 下部分参与者 rejected 后自动标记 skipped，任务按阈值完成；
  - `all` 下 `skipOnReject` 参与者 rejected 时，若有其他 required completed 则标记 skipped；
  - flow/trigger 多参与者任务可跑通。

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 多参与者同时写同一任务工作区冲突 | 每参与者隔离 workdir + 共享区只放显式产物 |
| 结果聚合与旧 observer/side-effect 兼容 | 聚合器只改任务终态；observer 仍按任务终态触发 |
| 存量任务迁移遗漏 | backfill 脚本 + candidates 回退旧路径 |
| 事件/指标双发（任务级 + 参与者级） | 明确参与者事件为新增，任务级事件保留 |
| 并发 commit 竞态 | 参与者行 CAS + 聚合器幂等（同一终态只聚一次） |
