# Workflow / Trigger / Human Review 修正计划

> 状态：已实施（2026-08 批次落地；2026-08-23 验收通过，本文档保留为设计/落地对照）
> 目标：基于现有 TaskFlow + Trigger 实现进行优化，补齐 Trigger 管理 HTTP 与人工审核 HTTP 协议；**不依赖 AgentEngine**。
> 约束：AgentEngine 独立化后期专门维护；本次修正不新增对 AgentEngine 的依赖，现有 AgentEngine 消费面（sessions/programs）暂不动。
> 关联代码：`packages/pth-kernel-execution/src/execution/task-resolver.ts`、`resolver-core.ts`、`trigger-engine.ts`、`system-triggers.ts`、`src/pth/gateway/routes-trigger.ts`、`src/pth/gateway/routes-kernel.ts`、`src/pth/prototypes/workflow/`。

---

## 1. 背景

### 1.1 现状

- **TaskFlow**：`payload.flow.stages` + `TaskResolver`，是任务实例级有序阶段机。
- **Trigger**：`TriggerEngine`，是全局规则引擎，支持 event / schedule 触发，发布任务或执行原生 action。
- **Trigger 管理 HTTP**：`/api/v1/kernel/triggers` 已有基础 CRUD，但缺少 `schedule` / `action` / `template` / 完整 `FlowSpec` 支持。
- **人工审核 HTTP**：N25 已设计 `/api/v1/human-requests` 等端点，但尚未实现；现有只有 `lineage/approve`、`memory-admin/approve` 等专用审批端点。
- **`src/pth/prototypes/workflow`**：未接线原型，且 `WorkflowOrchestrator` 依赖 AgentEngine；本次不启用，也不作为新实现基础。

### 1.2 问题

1. TaskFlow 与 Trigger 职责边界不清晰，容易误以为要“收敛合并”。
2. Trigger 管理 API 表达力不足，无法通过 HTTP 创建定时触发、原生 action、模板任务或携带完整 FlowSpec 的任务。
3. 人工审核没有通用 HTTP 协议，任务无法在“等待人工”状态下安全挂起/恢复。
4. AgentEngine 不应成为新 workflow / human review 路径的依赖；它应独立化后期维护。

---

## 2. 核心决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | TaskFlow 是否收敛到 Trigger | **不合并**；TaskResolver 继续执行 FlowSpec，Trigger 负责调度与跨任务自动化 |
| 2 | Trigger 管理 / 人工审核协议承载面 | **PTH HTTP API v1**（`/api/v1/*`），不进入 execution/v1.1，不进入 container-runtime-adapter 协议 |
| 3 | 新实现是否依赖 AgentEngine | **不依赖**；新增 workflow / human review 代码基于 TaskStore / TaskControl / PG 事务 |
| 4 | AgentEngine 处置 | 本次不删除、不扩展；现有消费面保留，后续单独立项“独立化”维护 |
| 5 | `src/pth/prototypes/workflow` 处置 | 保持冻结原型；可保留 AgentEngine 依赖但不得进入 active 路径，后续随 AgentEngine 独立化一起清理或改造 |

---

## 3. 现状盘点

### 3.1 TaskFlow

- 类型：`FlowSpec` / `Stage` / `TransformSpec` / `DecomposeSpec` / `BranchCase` / `LoopSpec`
- 执行：`TaskResolver` 按 `resolvedStages` 推进
- 状态：`resolvedStages`、`loopCount`、`outputRef`、`deps`、`parent`
- 已由 system trigger `flow-resolver` 驱动调度

### 3.2 Trigger

- 定义：memory `kind=trigger` + 代码内置 `systemTriggers`
- 触发：`event` / `schedule`
- 动作：`task`（inline / template / retask）、`action`（原生 handler）
- 防爆炸：`once` / `maxFires` / 链深 `MAX_CHAIN_DEPTH=5` / 自触发阻断
- 已有 HTTP：`GET/POST /api/v1/kernel/triggers`、`toggle`、`DELETE`、`reload`

### 3.3 人工审核

- 设计：`docs/pth/design/n25-human-interaction-protocol-design.md`
- 现状：无通用 `HumanRequest` / `HumanResponse` / `ApprovalDecision` 实现
- 现有专用审批：
  - `POST /api/v1/kernel/lineage/approve|reject`
  - `POST /api/v1/kernel/memory-admin/approve`

### 3.4 AgentEngine

- 位置：`src/pth/core/agent-engine.ts`
- 消费：sessions / programs / workflow prototype / WebSocket
- 本次修正：不新增依赖，不修改其内部实现

---

## 4. 分阶段实施

### Phase 0 — 基线确认与 AgentEngine 隔离标记

- 为 TaskFlow / Trigger 现有行为补测试基线（若已有则确认）。
- 在 `docs/pth/module-ownership.md` 或独立文档中标记：
  - AgentEngine = 独立模块，后期单独维护；
  - active workflow/human-review 路径禁止新增 `AgentEngine` 依赖。
- 在 `src/pth/prototypes/workflow/` 头部注释标记“冻结原型，不进入 active 路径；依赖 AgentEngine，待独立化后清理”。
- 验收：文档标记完成；无新增 active 代码 import AgentEngine。

### Phase 1 — Trigger 管理 API 增强

目标：让 Trigger 能通过 HTTP 表达当前引擎全部能力。

- 扩展 `routes-trigger.ts`：
  - 支持 `schedule: { everySec }`
  - 支持 `action: { type, params }`
  - 支持 `task.template` + `task.params`
  - 支持 `task.retask`
  - 支持 `task.flow`（完整 FlowSpec）
- 注册期校验：
  - `task` / `action` 至少其一
  - `event` / `schedule` 至少其一
  - 若含 `flow`，复用 `validateFlow()`
  - 若含 role/tags，复用 `checkTaskRouting()`
- 更新 facade 写入/重载逻辑，确保 CRUD 后立即 reload。
- 单测：schedule / action / template / retask / full flow 的创建与 toggle / delete。

### Phase 2 — TaskFlow ↔ Trigger 接合

目标：让 Trigger 能发布携带完整 FlowSpec 的任务，由 TaskResolver 继续执行。

- 在 `TriggerDef.task` 增加 `flow?: FlowSpec`。
- `publishFromTrigger()` 发布任务时：
  - 若 `task.flow` 存在，则 `payload.flow = task.flow`；
  - 若 `task.role` 存在且无 flow，保持现有单 stage 兼容逻辑。
- Trigger 注册期校验 flow。
- 集成测试：Trigger 发布带 `decompose/branch/loop` 的 flow 任务 → TaskResolver 按阶段推进。
- 不改变 TaskResolver 执行模型。

### Phase 3 — Human Interaction 基础（不含 AgentEngine）

目标：按 N25 建立通用人工交互领域模型，不依赖 AgentEngine。

- 新增 `packages/pth-contracts/src/human-interaction.ts`：
  - `HumanRequest`
  - `HumanResponse`
  - `ApprovalDecision`
  - `TaskSuspension`
  - `TaskWaitGate`
  - 相关结构校验函数
- `packages/pth-contracts/src/index.ts` 增加 barrel 导出。
- 新增 `src/pth/interaction/`：
  - repository 端口
  - application service
  - PG 事务实现（insert request + wait gate + task status + outbox）
- 不依赖 AgentEngine；基于 `TaskStore` / `TaskControl` / `PgMemoryStore`。

### Phase 4 — Human Review HTTP API

目标：提供通用人工审核 HTTP 协议。

- 按 N25 §12.2 实现端点：
  - `POST /api/v1/human-requests`
  - `GET /api/v1/human-requests`
  - `GET /api/v1/human-requests/:id`
  - `POST /api/v1/human-requests/:id/responses`
  - `POST /api/v1/human-requests/:id/cancel`
  - `POST /api/v1/task-drafts/:id/decisions`（若 draft review 先落地）
- 认证：
  - 从 auth hook 提取 stable principal；
  - responder 必须匹配 `assignedTo` 或 policy selector；
  - 写入 `principalId` / `idempotencyKey`，body 不得自报 tenant/principal。
- 幂等 / 并发：
  - 重复相同 response 幂等；
  - 并发相反决定返回 conflict；
  - CAS 只允许一个胜者。
- 单测：租户隔离、幂等、冲突、状态机。

### Phase 5 — Task Suspension / Resume Gate

目标：让任务能安全等待人工响应并恢复。

- 扩展 tasking contracts：
  - `TaskRunResult = TaskOutcome | TaskSuspension`
  - `TaskWaitGate`
- 扩展 `AgentTaskRunner` / task-loop：
  - 支持 `suspended` 结果；
  - 不消耗 claims budget；
  - 不被普通 claim 查询选中。
- 单事务流程：
  1. 校验 task/lease/generation；
  2. 插入 HumanRequest；
  3. 插入 task wait gate；
  4. 任务迁移为 `waiting-human`；
  5. 清除执行 lease，保留 generation；
  6. 写 interaction event / outbox。
- 恢复流程：
  1. 接受 HumanResponse；
  2. CAS 更新 HumanRequest 状态；
  3. 更新 wait gate；
  4. 任务回 `pending` / `cancelled` / `rejected`；
  5. 写 `task.resume` outbox。
- 不依赖 AgentEngine。

### Phase 6 — 文档 / 回归 / 发布

- 更新 `docs/pth/pth-api-protocol.md`：新增 trigger 扩展字段与 human review 端点。
- 更新 `docs/pth/orchestration.md`：明确 TaskFlow / Trigger / Human Review 分工。
- 更新 `docs/pth/module-ownership.md`：标记 AgentEngine 独立化。
- 全量回归：`npm test` + `npm run lint` + e2e。
- 发布 patch 版本。

---

## 5. 非目标

- 不把 TaskFlow 整体并入 Trigger。
- 不向 execution/v1.1 或 container-runtime-adapter 增加 Trigger 管理 / 人工审核协议。
- 不迁移 AgentEngine 到独立包（仅隔离标记，不新增依赖）。
- 不实现 N31 2.0 统一 Workflow DAG。
- 不把 `src/pth/prototypes/workflow` 接入生产。

---

## 6. 验收标准

1. Trigger HTTP API 能创建 schedule / action / template / retask / full flow 任务。
2. Trigger 发布的 full flow 任务能被 TaskResolver 正常推进。
3. `/api/v1/human-requests` 系列端点可用，幂等与 CAS 正确。
4. 任务可进入 `waiting-human` 并安全恢复，不消耗 claims budget。
5. 新增 active 代码无 `AgentEngine` import。
6. `npm run lint`、`npm test`、e2e 全绿。
