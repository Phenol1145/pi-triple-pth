# PTH v1.8.0 发布说明（草稿）

> 状态：草稿
> 分支：`feat/pth-exec-unified`
> 上游设计：[execution-modes-and-tool-reg-v2-design](./execution-modes-and-tool-reg-v2-design.md)

## 亮点

- 统一执行模式入口 `PTH_EXEC_MODE`：`tool-call` / `asp` / `ptc` / `pulse`。
- Tool-Reg v2：Tool 层无类型化，Command adapter 只产出 `ExecutionRequest`/`deny`，授权统一走 CommandGateway。
- 规范化优化循环骨架：`OptimizationLoopSpec` + `ActivityFactor` + Worker Registry。
- Pulse 正式化：`pulse-translate` / `pulse-result` trace 事件，legacy 挂起语义收敛。
- PTC 迭代模式：JSON 协议、独立协议失败预算、最大轮数软终止。

## 兼容性

- 默认执行模式保持 `tool-call`。
- `PTH_ASP_MODE=on` 仍是 `asp` 的兼容别名。
- `PTH_AGENT_MODE=off` 仍是 `pulse` 的兼容别名。
- 显式 `PTH_EXEC_MODE` 非法值 fail-fast。

## 破坏性变更（2026-08-24 三源重构）

- `origin` 角色/标签删除：带 `origin` 标签的任务不再路由；默认 batch 由 15 角色变为 14 角色。
- terminal reject 不再自动重发布（origin 兜底链移除），改为 `task.terminal-reject` 外部事件外推。
- controller 系失去 `obs.*` 能力；`manage.params.set`、`manage.resource.scheme.apply`、manual 直写 `manage.tool.register/revise` 必须携带 plan grant。
- `optimizer-suggestion` 作为 worker 产物 kind 废止；sensor 产物为 `observation-report`，controller 产物为 `modification-plan`。
- 谱系改为三源森林：`actuator/sensor/controller` 为 gen 0 根，全树 generation 顺移 -1；新角色注册必须显式声明 parent。

## 已知债务

- 自定义 adapter 的完整 AST 审核通道仍为预留入口，生产接入需走提案审核。
- legacy `TaskLoop.execute()` 已收敛为委托 `AgentTaskRunner` 执行，后续版本可进一步删除兼容分支。

## 验证

- `npm run build` ✅
- `npm run lint` ✅
- `npm run check:docs-links` ✅
- `PTH_ASP_MODE=off npx vitest run`：全量并行下偶发 testcontainers 资源抖动；相关集成套件单独重跑均通过。
