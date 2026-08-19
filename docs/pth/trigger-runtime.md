# PTH Trigger 运行时

> 建立：2026-08-16（trigger 统一化改造）。
> 原则：事件唤醒与周期唤醒统一为一条 trigger 调度指令；trigger 只负责唤醒原生动作或发布任务，
> 不拥有完整 Workflow Run。有限工作图与跨轮反馈采用
> [N31 统一 Workflow DAG 薄腰](./n31-unified-workflow-dag-design.md)中的定义。

## 1. 核心模型

一条 trigger 指令（`TriggerDef`）就是扁平化的调度单元：

```ts
{
  name: "claim-reaper",
  event?: "task.rejected",              // 事件触发（ActivityHub kind）——与 schedule 至少其一
  schedule?: { everySec: 30 },          // 定时触发（最小间隔）
  match?: { role?: "developer", detailContains?: "实现" },
  task?:   {                            // 任务 action：发布下游任务
    template?: "recon-doc",             //   模板引用（TASK_TEMPLATES——任务模板统一收口 A+）
    params?: { url: "{{detail}}" },     //   模板参数（值支持 {{taskId}}/{{role}}/{{detail}} 事件变量）
    title?: string, text?: string,      //   内联形态（兼容逃生舱——旧 memory trigger 定义）
    role?: string, tags?: string[], retask?: boolean,
  },
  action?: { type: "claim.reap", params? },          // 原生 action：调用注册 handler
  enabled: true,
  once?: false, maxFires?: 10,          // 防链式爆炸（once/maxFires/链深/自触发阻断）
}
```

- **任务 action**：治理链/工作流——trigger 发布任务。**模板引用优先**：`template + params` 经
  `resolveTemplateTask`（`kernel/templates.ts`）统一渲染/必填校验/默认路由/标题/payload，
  `params` 的值先做 `{{taskId}}/{{role}}/{{detail}}` 事件变量注入再进模板；
  `title/text` 内联形态仅为旧定义兼容，新 trigger 一律引用模板。
- **原生 action**：确定性控制环——毫秒级 handler，不经 LLM。
- 二者可并存（先 action 后发任务）；`registerAction(type, handler)` 注册。
- handler 可返回 `{ nextMs }` 覆盖 schedule 下一跳（动态退避——flow-resolver 空转降频用）。

**定义来源**：
- `system trigger`：代码内置（`system-triggers.ts` 注册中心），不进 memory；
- `memory trigger`：`memory` 表 `kind='trigger'` official 条目，经 API CRUD，30s 热重载生效。

## 2. 执行管线

```
ActivityHub 事件 / 调度心跳(2s)
        ↓ 匹配（kind + match）
   fireTrigger
        ↓
  [原生 action] 注册 handler（ctx: trigger/vars/event/source）
  [任务 action]  resolveTemplateTask（模板引用）或内联渲染 → tasks.publish
        ↓
   once/maxFires 结算；链深 ≤5；同一 trigger 自触发阻断
```

调度心跳只判定 schedule 到点，是引擎底座（2s）；事件路径零轮询。

## 2.1 与任务模板库的关系（任务模板统一收口 A+）

- `TriggerDef.task` 的模板引用与发布 API `{template, params}`、PerfStrategy.actions `{type:"task", template, params}`
  共用 **同一个** `TASK_TEMPLATES` 注册表与 `resolveTemplateTask` 解析器——不存在 trigger 私有模板；
- 事件变量注入发生在模板渲染前：`params.url = "{{detail}}"` 先替换再必填校验；
- 路由优先级：显式 `role` > 显式 `tags` > 模板 `roleTag`；title 缺省 `[id] name`；
- 系统内部提示词（`memory-sweep`）也是模板库条目（`hidden:true`——`/templates` 列表不外显）。

## 3. 系统 trigger 目录

| trigger | 形态 | 周期 | 注册条件 | 动作 |
|---|---|---|---|---|
| `origin-escalation` | event `task.rejected` | — | 恒注册 | retask 重发布 → origin 标签（终态闸防死循环） |
| `memory-maintenance-sweep` | schedule | `PTH_MEMORY_SWEEP_SECONDS`（86400s；0=关） | env 开启 | 发布 memory-keeper 巡检任务（模板引用 `memory-sweep`，hidden）→ draft 提案 |
| `claim-reaper` | schedule + action | `PTH_CLAIM_REAP_MS`（30s） | 恒注册 | `claim.reap`：回收僵尸 claim |
| `batch-watchdog` | schedule + action | `PTH_WATCHDOG_INTERVAL_MS`（30s） | 恒注册 | `watchdog.probe`：崩溃记录/挂死 kill+重启 |
| `flow-resolver` | schedule + action | `PTH_RESOLVER_INTERVAL_MS`（2s；空转退避 2s→5s→10s→15s） | 恒注册 | `resolver.resolve`：flow 阶段解析 |
| `optimizer-deopt-sweep` | schedule + action | `PTH_VERIFY_SWEEP_MS`（30s） | `PTH_OPTIMIZER !== "off"` | `optimizer.deopt-sweep`：IPC 下行，每 batch 跑一次 checkDeopt |
| `batch-scaler` | schedule + action | `PTH_BATCH_SCALE_INTERVAL_MS`（30s） | `PTH_BATCH_AUTOSCALE === "on"` | `batch.scale`：evaluateAndScale |
| `perf-autopilot` | schedule + action | `PTH_AUTOPILOT_INTERVAL_MS`（30s） | `PTH_AUTOPILOT_MODE === "on"`（main.ts 注册，依赖 metrics registry） | `perf-autopilot.tick`：R1 扩缩 / R2 调参+回滚 / R3-R4 记录 |

## 4. 事件词汇（ActivityHub 统一事件源）

**上行：batch 子进程 → 主进程 ActivityHub**

| 通道 | 事件 |
|---|---|
| `kind:"activity"`（TaskLoop/observers） | `task.claim` / `agent.step` / `agent.tool` / `task.done` / `task.failed` |
| `kind:"kernel-event"`（EventBus 白名单转发） | `task.execute.start` / `task.execute.end` / `task.submit` / `task.reject` / `kernel.execute.start` / `kernel.execute.end` / `worker.add` / `worker.pause` / `worker.resume` / `worker.remove` |
| 主进程 EventBus 桥接 | `batch.spawn` / `batch.kill` |

去重：`task.claim`/`task.done`/`task.failed` 只走 activity 通道，kernel-event 白名单不重复转发。

**下行：主进程 → batch 子进程**：`set-param` / `worker-*` / `role-register` / `optimizer-sweep`（`BatchManager.broadcast`）。

## 5. 明确保留的引擎底座（非业务 loop，不 trigger 化）

- TriggerEngine 调度心跳 2s + memory 定义热重载 30s；
- prom-client metrics 采样（默认 5s）——采样器；
- batch 子进程认领心跳 tick（默认 1s；忙时自驱动）——执行器拉取；
- 每任务 deadline（LLM timeout / verify timeout / claim timeout）——定时炸弹语义。

## 6. 观测与操作

- `engine.listTriggers()`：system + memory 全量快照（name/source/event/schedule/actionType/fireCount/lastFiredAt）。
- CRUD：memory `kind='trigger'` 条目（official + enabled）→ 最多 30s 生效；`once` 触发后自动写回 `enabled=false`。
- 事件流：ActivityHub 既供 SSE `/api/v1/kernel/events`，也是 trigger 的匹配源——同一事件双消费。
