# PTH 任务编排：flow 与 trigger 的分工

> PTH 有两种"任务完成→发新任务"机制——**保持分离**（2026-08-10 用户裁决）——本文明确各自适用场景，避免选错。

---

## 一句话分工

| | **flow（任务链）** | **trigger（事件规则）** |
|---|---|---|
| 本质 | **这条任务**的流程单（实例级编排）| **系统**的自动化规则（全局持续生效）|
| 类比 | 工单上写明的工序 | IFTTT / webhook 自动化 |

## 选择决策树

```
要编排的任务关系是——
├─ 这次任务专属的流程（一次性——带分支/分解/循环）→ flow
│   例："这个特性：先侦察→再实现→再测试"（每个特性任务各自声明）
│
└─ 一类事件都要响应的规则（持续——简单直接）→ trigger
    例："任何 developer 完成的任务都自动发验收"（规则写一次——永久生效）
```

## flow（TaskResolver——任务池即工作流）

**声明**：发布任务时 payload.flow 自带 stages——**实例级**（跟着这个任务链走）。

**算力**（5 算子——强表达力）：
| 算子 | 作用 |
|------|------|
| match | 阶段匹配条件（JSON 匹配）|
| transform | 产物转换（role/status 改写）|
| decompose | 一拆多（分解多个子任务）|
| branch | 条件分支（if 表达式）|
| loop | 循环（until 条件 + max 上限）|

**用法**：
```json
POST /api/v1/kernel/tasks
{
  "title": "特性 X 交付", "text": "...", "createdBy": "ptl",
  "flow": { "stages": [
    { "id": "recon", "task": { "role": "scout" } },
    { "id": "impl", "task": { "role": "developer" }, "wait": true },
    { "id": "verify", "task": { "role": "tester" }, "wait": true, "terminal": true }
  ]}
}
```

**适用**：多阶段流程、条件分支、任务分解、循环——**每次发布任务时声明**。

## trigger（TriggerEngine——事件触发任务）

**声明**：memory kind='trigger'（API 管理）——**全局规则**（持续生效——所有匹配事件都触发）。

**能力**（简单直接）：
- 事件：`task.claim` / `task.done` / `task.failed` / `agent.step` / `agent.tool`
- 定时：`schedule: { everySec }`
- 匹配：`match.role` / `match.detailContains`
- 动作：原生 `action`、模板 `task.template`、内联 `task.title/text`、`task.retask`、完整 `task.flow`
- 模板变量：`{{taskId}}` `{{role}}` `{{detail}}`
- 安全：链深 >5 断 / 自触发阻断 / `once` / `maxFires`

**用法**：
```bash
# 规则：scout 完成的任务 → 自动发验收给 acceptor（一次写——永久生效）
POST /api/v1/kernel/triggers
{
  "name": "侦察后验收",
  "event": "task.done",
  "match": { "role": "scout" },
  "task": { "title": "验收 {{taskId}}", "text": "检查侦察产物", "role": "acceptor" },
  "once": true
}
```

**适用**：全局自动化规则（自动验收/自动沉淀/失败告警任务）——**写一次持续生效**。

## Human Review（人工审核）

- 通用人工请求经 `/api/v1/human-requests` 创建，任务进入 `waiting-human`。
- 响应后按 `approved` → `pending`（重新进入任务池）或 `rejected`（终态）恢复。
- 不依赖 AgentEngine；基于 TaskStore / PG 事务 / CAS 实现。

详细设计：[workflow-trigger-human-review-correction-plan](plan/workflow-trigger-human-review-correction-plan.md)

## 明确不要混用

```
❌ 用 trigger 做复杂流程（分支/分解/循环）——trigger 表达力不够——用 flow
❌ 用 flow 做全局规则——每个任务重复声明同一 stages——冗余且规则不可复用——用 trigger
❌ trigger 套 trigger 长链——链深 >5 自动断（防爆炸）——长流程用 flow
```

## 数据面速查

| 机制 | 存储 | 管理 API | 执行者 |
|------|------|---------|--------|
| flow | 任务 payload（tasks 表）| 发布时声明 | TaskResolver（轮询 2s）|
| trigger | memory kind='trigger' | /api/v1/kernel/triggers CRUD | TriggerEngine（事件实时）|
