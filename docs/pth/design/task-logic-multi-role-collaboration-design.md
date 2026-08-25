# 任务逻辑整改：多角色共享任务设计（Multi-Role Shared Task）

> 状态：**设计提案（待评审）**
> 背景：当前任务分发是“单角色归属 + 顺序/树状拆分”；目标改为“一个任务同时派给多个指定 worker，每个 worker 拿到完整任务上下文”。
> 关联：`docs/pth/orchestration.md`、`docs/pth/trigger-runtime.md`、`docs/pth/design/w8-task-dispatch-design.md`、`docs/pth/design/task-lifecycle-and-context-design.md`、`packages/pth-kernel-storage/src/schema.ts`、`packages/pth-kernel-execution/src/execution/{tag-registry,role-router,task-resolver,trigger-engine}.ts`、`src/pth/tasking/*`、`src/pth/bootstrap/task-loop.ts`。

---

## 1. 背景与问题

当前任务链路：

```
发布（tags / flow.role）
  → 路由出唯一 assigned_role
  → 只进入该角色队列
  → 该角色 claim 并执行
  → 任务终态
```

- `tags` 只在发布瞬间作为“选唯一角色”的输入，发布后不再参与调度；
- 多角色协作只能靠 `flow` 顺序阶段、`decompose` 拆分、`delegate` 父子投递、`trigger` 链式发布；
- 每个 worker 看到的是被拆分后的子任务，而不是同一个任务的完整始末。

目标模型：

```
一个任务（完整 title/text/payload/goal）
  → 同时派给多个指定角色（participants）
  → 每个角色都能 claim 同一个任务
  → 每个角色都拿到完整任务上下文
  → 各自贡献产物，任务按聚合规则终态
```

## 2. 目标与非目标

### 2.1 目标

1. 让 `tags` 真正参与任务分发：多个角色标签 = 多个参与者。
2. 引入“任务参与者（participant）”一等概念，替代单一 `assigned_role` 作为唯一归属。
3. 支持同一任务被多个指定 worker 同时接取，且每个 worker 看到完整任务上下文。
4. 定义多参与者执行、租约、提交、结果聚合的生命周期。
5. 让 FlowSpec 与 Trigger 能表达“同一任务广播给多个角色”。
6. 保持单角色任务完全兼容（一个任务 = 一个 required participant）。

### 2.2 非目标

- 不实现 N31 2.0 统一 Workflow DAG（仍按现有 FlowSpec/Trigger 演进）。
- 不改变 Knowledge Intake 内环（不走通用任务池）。
- 不做 run 级消息断点续跑（沿用现有“重跑 + 幂等续接”）。
- 不引入自由动态 spawn agent；参与者必须来自已注册角色。
- 不做跨参与者的实时消息共享（v1 通过共享 payload/产物引用协作，不做聊天式通信）。

## 3. 核心概念钉死

### 3.1 任务（Task）与参与者（Participant）

- **Task**：一份共享工作单元。`title`、`text`、`tags`、`payload`、`domains`、`goal` 对全体参与者一致。
- **Participant**：一个参与该 Task 的角色（role）及其个人执行状态。参与者是任务的一部分，不是独立任务。
- **参与者集合（participants）**：发布时由显式声明或 tags 解析得出，决定“哪些角色会接到这个任务”。
- **Primary Role（兼容字段）**：保留 `tasks.assigned_role` 作为“首要参与者/旧查询兼容”，不再承担唯一归属语义；多参与者任务取第一个 required participant。

### 3.2 Tag 语义重定义

| kind | 语义 | 是否参与路由 |
|---|---|---|
| `role` | 精确映射一个角色；一个任务可含多个 role tag | **是**：每个 role tag 产生一个 required participant |
| `capability` | 描述所需能力/上下文（如 `fix`、`concept-design`） | 否（v1 仅元数据；后续可做能力解析） |
| `context` | 描述任务阶段/领域/场景 | 否（元数据） |
| `governance` | 治理共享标签（`controller`、`sensor` 等） | 否（不参与 participants；仍需显式 role/flow/participants） |
| `priority`/`complexity` | 预留维度 | 否 |

关键变化：

- **允许多个 role tag**。`tags: ["code","test"]` 表示 `developer` 与 `tester` 同时参与同一个任务。
- **不再把“命中多个角色”当作歧义拒绝**；歧义只保留在“同一个 role tag 映射到多个角色”的非法注册场景（注册表层仍禁止）。
- `governance` 标签不自动展开为多个治理角色；治理派发仍走显式 `role`/`flow`/`participants`。

### 3.3 完整上下文（Full Context）

每个参与者 claim 到任务后，`TaskWorkItem` 必须包含：

```
taskId
title
text（完整任务正文，不切片）
tags
payload（共享状态：delivery/domains/domainBinding/flow/context 等）
domains / domainBinding
goal（若有）
assignedRole = 当前 participant.roleId
workMode
```

即：**同一个 task 的完整字段原样给每个参与者**，只把 `assignedRole` 换成各自角色。角色差异由 worker 的角色 prompt、capabilities 提供，不由任务内容切片造成。

### 3.4 参与者租约（Participant Lease）

- 租约粒度从“任务级”改为“参与者级”。
- 每个 participant 独立持有 `leaseToken + leaseGeneration + leaseExpiresAt`。
- 多个参与者可以同时持有同一任务的租约。
- 过期回收只回收对应 participant 租约，不影响其他参与者继续执行。
- 兼容：单参与者任务的语义与今天一致。

### 3.5 贡献（Contribution）与结果聚合（Aggregation）

- 每个 participant 产生一个 **contribution**（result/artifacts）。
- 任务终态由参与者聚合决定，并支持“部分参与者被标记跳过”。

**参与者模式**

```
required：默认计入完成要求
optional：可参与；未完成/被跳过不影响任务完成
```

**任务完成策略（completionPolicy）**

| 策略 | 语义 |
|---|---|
| `all`（默认） | 所有 required 都 completed → task completed；任一 required terminal-rejected → task rejected |
| `quorum` | 达到 `minRequired` 个 required completed → task completed；其余未完成 required 自动标记 `skipped`（含 rejected 的参与者） |
| `any` | 第一个 required completed → task completed；其余参与者自动标记 `skipped` |

- `minRequired` 缺省 = required 数量（即退化为 all）。
- `quorum` 下，若剩余可完成数量已不足以达到 `minRequired`，则任务 rejected。

**“标记跳过”规则**

1. `optional` 参与者：始终可被跳过；
2. `quorum` / `any` 达成时：未完成或 rejected 的 required 参与者自动标记 `skipped`；
3. 显式 `participants[].skipOnReject: true`：在 `all` 策略下，该 required 参与者 reject 时也可被标记 `skipped`，前提是至少有一个其他 required 参与者 completed（防止全员失败却完成）。

- 聚合结果写入 `payload.result`：

```json
{
  "aggregate": "completed",
  "policy": "quorum",
  "minRequired": 2,
  "contributions": {
    "developer": { "summary": "...", "value": { ... } },
    "tester":    { "status": "skipped" }
  }
}
```

- 单参与者任务聚合结果与现状一致：`payload.result` 直接是该参与者的结果。

### 3.6 任务生命周期

```
pending
  ├─ 任一 participant claim → claimed（任务级“进行中”）
  ├─ 满足 completionPolicy → completed（未完成参与者可标记 skipped）
  ├─ 无法满足 completionPolicy（如 all 下任一 required rejected）→ rejected
  ├─ pause / waiting-human / escalated：沿用现有任务级状态
  └─ 参与者级状态独立推进：pending / claimed / completed / rejected / skipped
```

- 任务级 `status` 保留现有枚举（`pending/claimed/submitted/completed/rejected/escalated/waiting-human/paused`），不新增状态。
- `claimed` 在 v1 表示“至少一个参与者已认领且未全部终态”。
- `skipped` 不是失败，表示“该参与者不参与本次完成的最终计数”。

### 3.7 工作流（Flow）与 Trigger 的关系

- **FlowSpec** 仍表示“这条任务的实例级流程”。
- 新增表达：一个 stage 可以声明 `roles`/`participants`，表示该阶段把一个完整任务广播给多个角色。
- **Trigger** 仍表示“全局事件/定时规则”，发布任务时也可以声明 `roles`/`participants`。
- 二者都不再是“多角色协作的唯一途径”；它们与直接发布多参与者任务共存。

## 4. 数据模型

### 4.1 `tasks` 表变更

```sql
-- 保留 assigned_role（兼容/首要参与者）
-- 新增：参与者声明快照（发布时的原始声明，便于审计）
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS participants JSONB NOT NULL DEFAULT '[]';
-- participants 元素：{ role: string, mode: 'required'|'optional', skipOnReject?: boolean }

-- 新增：任务完成策略
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completion_policy TEXT NOT NULL DEFAULT 'all'
  CHECK (completion_policy IN ('all','quorum','any'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS min_required INTEGER;
```

- 对存量单角色任务，`participants` 可回填为 `[{role: assigned_role, mode: "required"}]`，`completion_policy='all'`。
- 参与者实时状态不放在 tasks 主表，避免多租约争用同一 JSONB。

### 4.2 新表 `task_participants`

```sql
CREATE TABLE IF NOT EXISTS task_participants (
  tenant_id      TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  role_id        TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'required'
                 CHECK (mode IN ('required','optional')),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','claimed','completed','rejected','skipped')),
  skip_on_reject BOOLEAN NOT NULL DEFAULT FALSE,
  claim_token    UUID,
  claim_generation BIGINT NOT NULL DEFAULT 0,
  claimed_by     TEXT,
  claimed_at     TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  contribution   JSONB,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, task_id, role_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_task_participants_role
  ON task_participants(tenant_id, role_id, status, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_task_participants_task
  ON task_participants(tenant_id, task_id, status);
```

### 4.3 兼容层

- 单角色任务：`task_participants` 只有一行 `required`，任务终态逻辑退化为今天的单租约行为。
- 存量任务未回填 participant 行时，`candidates`/`claim` 回退到 `assigned_role` 路径；迁移后统一走 participant 表。
- 旧 API 返回仍带 `assigned_role`（= primary role），新增 `participants` 字段。

## 5. 路由与校验

### 5.1 `TagRegistry` 变化

```ts
routeRoles(tags: string[]): { ok: true; roles: string[] } | { ok: false; error: string }
```

- `kind=role` 且 `role` 唯一的 tag → 加入 roles。
- 多个 role tag → 返回多个 roles。
- `kind=governance` 等多角色共享标签不展开。
- `validate()` 仍校验全部标签已注册。

### 5.2 发布校验

```ts
checkTaskRouting(input: {
  tags?: string[];
  payload?: unknown;
}): {
  ok: true;
  participants: Array<{ role: string; mode: "required"|"optional"; skipOnReject?: boolean }>;
  completionPolicy: "all"|"quorum"|"any";
  minRequired?: number;
} | { ok: false; error: string }
```

解析优先级：

1. `payload.participants`（显式声明）——最强；
2. `payload.flow.stages[0].task.roles/participants`——FlowSpec 首阶段；
3. `tags` 中的 role tags——按 tag 展开；
4. 以上都没有 → 报错（延续“无缺省路由”）。

`mode` 规则：

- 显式 `participants` 可带 `mode`，缺省 `required`；可带 `skipOnReject`；
- tags 展开的 participant 一律 `required`，`skipOnReject=false`；
- flow 显式 `roles` 一律 `required`，`skipOnReject=false`。

`completionPolicy` 规则：

- 显式 `payload.completionPolicy` 优先；
- flow/trigger 可声明 `completionPolicy`；
- 缺省 `all`；
- `quorum` 时必须提供 `minRequired`（正整数且 ≤ required 数量），缺省报错。

### 5.3 角色存在性

- 显式 participants/flow roles 必须是已注册角色，否则发布拒绝。
- 不再因“命中多个角色”拒绝任务。

## 6. 执行模型

### 6.1 candidates / claim / commit（按参与者）

```
TaskLoop.runOnce(roleId):
  candidates(roleId)
    = tasks JOIN task_participants
      WHERE task_participants.role_id = roleId
        AND task_participants.status = 'pending'
        AND tasks.status IN ('pending','claimed')
        AND tasks.status NOT IN ('completed','rejected','escalated','waiting-human','paused')
        AND tasks.claims_count < MAX_CLAIMS

claim(taskId, roleId):
  UPDATE task_participants
    SET status='claimed', claim_token=..., claim_generation=gen+1,
        claimed_by=..., lease_expires_at=...
    WHERE tenant_id=? AND task_id=? AND role_id=?
      AND status='pending'
  -- 若 tasks.status='pending'，同步置为 'claimed'

commit(participant lease, outcome):
  1. CAS 更新 task_participants → completed/rejected，写 contribution
  2. 调用聚合器（按 completionPolicy）：
     - all：
       - 所有 required completed → completed
       - 任一 required rejected 且非 skipOnReject → rejected
       - skipOnReject=true 且至少一个 required completed → 该 rejected 标记 skipped
     - quorum：
       - completed 数 ≥ minRequired → completed，其余未完成 required 标记 skipped
       - 剩余可完成数 < minRequired → rejected
     - any：
       - 首个 required completed → completed，其余标记 skipped
```

### 6.2 工作空间

- 每个 participant 使用隔离工作目录：`task:{taskId}:{roleId}`。
- 共享区：`task:{taskId}:shared` 存放跨参与者可见的中间产物。
- 单参与者任务在迁移期可继续使用 `task:{taskId}`，新统一路径为 `task:{taskId}:{roleId}`。

### 6.3 暂停 / 人工 / 取消

- 暂停问题由某个 participant 提出时，任务进入 `paused`，**该 participant 释放租约**，其他 participant 不受影响（仍可执行）。
- `waiting-human` 同理作用于任务级 gate，但参与者级状态保留。
- 取消任务时递归取消所有未终态 participants（释放全部租约）。

## 7. 工作流生成扩展

### 7.1 FlowSpec

```ts
interface StageTask {
  role?: string;                 // 兼容：单角色
  roles?: string[];              // 新：多角色同时参与
  participants?: Array<{ role: string; mode?: "required"|"optional"; skipOnReject?: boolean }>;
  completionPolicy?: "all"|"quorum"|"any";
  minRequired?: number;
}

interface DecomposeSpec {
  title: string;
  text: string;
  tags?: string[];
  role?: string;                 // 兼容
  roles?: string[];              // 新：生成一个共享任务，多个参与者
  participants?: Array<{ role: string; mode?: "required"|"optional"; skipOnReject?: boolean }>;
  completionPolicy?: "all"|"quorum"|"any";
  minRequired?: number;
  flow?: FlowSpec;
}
```

语义：

- `decompose` 中带 `roles`/`participants` 时，**只发布一个子任务**，该子任务带多个参与者；而不是每个角色一个子任务。
- `flow.stages[].task.roles` 作为发布期首阶段语法糖，等价于发布一个多参与者任务。
- `completionPolicy`/`minRequired` 随子任务透传。

### 7.2 Trigger

```ts
interface TriggerDefTask {
  // ...现有字段
  roles?: string[];
  participants?: Array<{ role: string; mode?: "required"|"optional"; skipOnReject?: boolean }>;
  completionPolicy?: "all"|"quorum"|"any";
  minRequired?: number;
}
```

- `publishFromTrigger` 将 `roles`/`participants`/`completionPolicy`/`minRequired` 传给 `tasks.publish`，生成多参与者任务。
- 注册期 `checkTaskRouting` 同时校验显式 participants/flow roles 与 completionPolicy。

## 8. API / CLI / 观测

### 8.1 HTTP

- `POST /api/v1/kernel/tasks`：
  - 新增可选 `participants: [{role, mode?, skipOnReject?}]`；
  - 新增可选 `completionPolicy: "all"|"quorum"|"any"` 与 `minRequired`；
  - 也支持多个 role tag；
  - 响应新增 `participants` 与 `completionPolicy`。
- `GET /api/v1/kernel/tasks/:id`：
  - 返回 `participants`（含实时状态与 contribution）。
- `POST /api/v1/kernel/jobs`：
  - 每个 task 支持 `participants`/多 role tags。
- `GET /api/v1/kernel/triggers` / `POST /api/v1/kernel/triggers`：
  - task 支持 `roles`/`participants`。

### 8.2 CLI

- `pth submit --role developer --role tester ...` 或 `--roles developer,tester`；
- `pth status`/`pth wait` 显示参与者状态；
- `pth trigger add --role a --role b ...`。

### 8.3 事件与指标

- 新事件：`task.participant.claim`、`task.participant.done`、`task.participant.failed`。
- 指标：`pth_task_participants_total{status,role}`、`pth_task_aggregate_total{status}`。
- SSE 与审计沿用现有通道。

## 9. 安全与兼容

1. 参与者必须来自已注册角色；不引入未注册角色自动参与。
2. `assigned_role` 保留为 primary role，旧查询/旧工具不破坏。
3. 治理角色仍不走 tags 自动展开；必须显式 `role`/`flow`/`participants`。
4. 多参与者任务仍遵守租约 CAS、claims_count 上限、过期回收。
5. 结果聚合只写服务端盖章的 `payload.result`，不允许参与者自报聚合结果。
6. 旧单角色任务路径完全保留，逐步迁移。

## 10. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| D1 | tag 路由语义 | 多个 role tag = 多个 required participant；不再歧义拒绝 |
| D2 | 参与者粒度 | 一等实体 `task_participants`，租约/状态/贡献按参与者 |
| D3 | 完整上下文 | 同一任务完整字段原样给每个参与者，不切片 |
| D4 | 聚合规则 | 支持 `all`/`quorum`/`any`；默认 `all`；`quorum`/`any` 达成时未完成参与者标记 skipped |
| D5 | 工作空间 | 每参与者隔离 `task:{id}:{role}`，共享区 `task:{id}:shared` |
| D6 | 兼容 | 保留 `assigned_role` 为 primary；单角色任务退化为单参与者 |
| D7 | Flow/Trigger | 支持 `roles`/`participants`/`completionPolicy` 表达广播式多角色阶段/任务 |
| D8 | 治理标签 | governance 不自动展开，仍显式路由 |
| D9 | 跳过语义 | `skipped` 不是失败；quorum/any 自动跳过；`skipOnReject` 可在 all 下把少数 rejected 标记跳过 |

## 11. 验收标准

1. 发布 `tags:["code","test"]` 生成一个任务、两个参与者（developer/tester）。
2. 两个角色的 worker 都能在各自队列看到同一个 taskId，且都拿到完整 `text`/`payload`/`goal`。
3. 两个参与者可同时 claim；各自独立租约；互不挤占。
4. `all` 下两个 required 都 completed 后任务才 completed，`payload.result.contributions` 含双方产物。
5. `quorum`/`any` 下达到阈值后任务 completed，未完成/rejected 参与者被标记 `skipped`。
6. `all` 下任一 required terminal-rejected（且未 `skipOnReject`）→ 任务 rejected。
7. 旧单角色任务（`--role developer`）行为与今天一致。
8. FlowSpec/Trigger 可发布多参与者任务并携带 `completionPolicy`。
9. 全量 lint / test / build 绿。

## 12. 待进一步确认的点

- 是否需要“参与者之间互相可见对方实时贡献”（v1 仅终态聚合）。
- 多参与者任务的 pause/answer 是否需要在参与者级而不是任务级（v1 按任务级）。
- 是否需要人工/运维手动把某个 participant 标记为 skipped（v1 仅策略自动跳过）。
