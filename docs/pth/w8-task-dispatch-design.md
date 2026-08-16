# W8 —— PTL 任务派发与交互逻辑设计（v0.1 草案，2026-08-17）

> 状态：**设计提案**（待裁决点见 §7）。
> 落点：`docs/pth/concepts.md §0.16.2` 的回填 + `§0.16.4` 分拆收口的投递原语。
> 目标：把「任务投递 = rlm 等效」从概念变成可实现的契约；不改变现有静态 flow / trigger 链续派。

## 1. 目标与非目标

**目标**
1. 定义入口派发语义：PTL/用户任务**显式指定**入口 worker 类型（无缺省入口）；
2. 定义父→子投递原语：worker 如何向**直接子类型**派发任务并回收产物（0.16.4 工具面收口的另一半）；
3. 定义回流/交互协议：结果、中间产物、取消与异常如何回到父方；
4. 定义组织权机器校验：谁能投递给谁，服务器端强制，不信任 worker 自报。

**非目标**
- 不做运行时动态 spawn 子 agent（类型树静态存在，实例由 batch 层管理）；
- 不替代现有 `payload.flow` 静态编排与 trigger 链续派（共存：flow=静态图、delegate=LLM 动态图）；
- 不实现穿透 skill 的执行协议（§7 只留接口位，0.16.3 后续）。

## 2. 分层模型

```
PTL / 外部 ──submit──▶ 入口类型（entry dispatch）
  入口 worker ──delegate──▶ 直接子类型（父→子投递）
  子类型 ──delegate──▶ 孙类型（逐级）
  回流：completed(result/artifactRef) ◀── 父 await / 通知 / 轮询
```

- **入口派发**：外部调用方不进入谱系树，通过 `pth submit` / `POST /api/v1/kernel/tasks` 提交；
  **无缺省入口**——`--role` 或 `--tags` 至少其一（D1 裁决）。
- **父→子投递**：worker 在 ts 程序内调用 `tasks.delegate`（新工具），生成子任务。
- **回流**：子任务终态后，父经 `tasks.await` / 轮询取回 `result` 与产物引用。

## 3. 数据契约（task 记录扩展）

在 `PublishInput`/Task 的 `payload` 增加可选的投递字段（均为 jsonb，不迁移表结构）：

```ts
interface TaskDelivery {
  parent?: { taskId: string; roleId: string; typePath: string[] };  // 父任务与父类型路径
  path: string[];          // 类型树上的派发路径（含入口类型与自身类型），如 ["origin","developer","coder"]
  lineageId: string;       // 同一入口任务派生树的根 id（入口任务自己的 lineageId = 自身 taskId）
  replyTo?: "parent" | "caller";   // 回流目标：父任务（默认）或穿透调用点
  artifactRef?: { kind: "memory" | "file" | "component"; id: string };  // 最终产物引用
}
```

**落库布局（P0 裁决 2026-08-17）**
- `payload.delivery` 单键包裹 TaskDelivery（Q1）——不与既有 `payload.parent`(string)/`flow` 撞名；
- 终态结果写 `payload.result`：completed 写 JSON-safe 全量结果（超 64KiB 递归截断 +
  `__pthTruncated` 标记）；rejected/cancelled 写 `{error:{code,message}}`（Q3）；
- sandbox 产物不进 jsonb：文件/大对象只写 `delivery.artifactRef` 引用；不可序列化值
  （循环引用/函数/BigInt 根）降级为 `{__pthUnserializable,...}` 摘要，不污染终态；
- 盖章范围（Q2）：仅外部入口（`TaskControlService` 路径）盖章；resolver/trigger/
  debug-case/optimizer 等内部发布不盖章——静态链语义零变化。

**服务器端盖章规则（不可信输入）**
- 外部提交：`parent` 不设置（入口）；`path=[assignedRole]`；`lineageId=自身 taskId`。
- worker delegate：`parent`、`path`、`lineageId` 由服务端根据**调用 worker 身份**生成；
  请求体只允许提供任务内容/模板/标签，不允许自报 parent/path/lineage。
- 任务终态时把 `done.result` 压缩为 `payload.result`（结构保留），写 `artifactRef`（若 done 声明产物）。

## 4. 投递原语（worker 工具面）

新增两个能力（只注入「有投递权」的角色，见 §5）：

```
tasks.delegate({
  to: "<直接子类型 id>",             // 必填；白名单 = 直接子类型（0.16.4）
  title: string,
  text: string,                       // 自包含任务描述（T01/T03/T04 教训）
  template?: string,                  // 任务模板引用（A+ 模板库）
  params?: Record<string, unknown>,
  tags?: string[],
  context?: Record<string, unknown>,  // 父方整理好的上下文快照（压缩后随任务传递）
  expect?: "result" | "artifact" | "report"   // 回流预期，决定 await 返回内容
}) → { taskId, roleId, path }

tasks.await({ taskId, timeoutMs? }) →
  { status, result?, artifactRef?, summary?, error? }
```

- `tasks.delegate` 是**异步投递**：立即返回 taskId，不阻塞父 worker；
- `tasks.await` 是**事件驱动等待**（D2 裁决）：调用后父 worker 登记等待集合并挂起当前任务，
  任务重新回到 `submitted`（不占 claim）；子任务终态事件在 main 进程触发**父任务 requeue**，
  父 worker 被唤醒后从 `payload.childResult` 读取结果继续执行；
- 父 worker 可以在一次任务里 delegate 多个子任务后统一 await（并行子任务——同层并行原则）。

**工具注入规则（与 0.16.4 一致）**
- 已分拆类型：工具面 = `execTs/nav/cache` + `tasks.delegate` + `tasks.await`（若拥有投递权）。
- 未分拆类型：不注入 delegate/await。
- 穿透 skill（后续）：把 `delegate+await` 编译成 `skill:penetrate:<child>` 直接调用边。

## 5. 组织权与安全（机器校验）

**授权矩阵由角色定义派生**：

| 调用方类型 | 可投递目标 |
|---|---|
| 内部类型（有子类型） | 仅其**直接子类型** |
| planner / governor | 自身直接子类型 + **跨子树补充权**（可投递任意执行族类型——组织知识专有） |
| origin | 全树任意类型 |
| 叶子类型 | 无投递权（不注入 delegate） |
| sensor / controller 系 | 治理面维持现状（manage.*/trigger API），不走 delegate |

**实施**
- `delegation-policy.ts`（新）：`allowedDelegationTargets(callerRoleId): string[]`，从 `allKnownRoles()` 谱系派生，单测钉死；
- delegate 工具服务端调用 `TaskControlService.publish`，以 `createdBy=worker:<roleId>` + 服务器盖章 parent/path/lineage；
- 校验失败 → `PtcContractError`（capability 级结构化错误，不进入任务池）；
- 任务创建后 `checkTaskRouting` 照常执行（flow 显式 role 优先；与 delegate.to 一致）。

## 6. 交互协议（回流/取消/异常）

1. **回流契约**：子任务终态时：
   - `completed`：`payload.result` = done.result 的 JSON-safe 子集（压缩/截断按任务策略）；
   - `rejected`：`payload.result` = 错误摘要；父 await 收到 `error`；
   - `failed`（Origin 兜底失败）：同 rejected，但 `path` 保留——可观测。
2. **事件驱动回流（D2 裁决）**：子任务终态 → batch 事件桥上报 main → `task-dispatch-notifier`
   查 `parent.taskId` 反查未终态父任务 → 写入 `payload.childResult` 并 requeue 父任务（`submitted`）；
3. **取消传播**：父任务取消 → 沿 `parent.taskId` 索引找到未终态子任务，递归 cancel（service 层批量）；
3. **超时**：父 await 超时 ≠ 取消子任务（子任务继续跑，父先失败或改异步）；`tasks.await` 支持 `{detach:true}` 放弃等待。
4. **PTL 侧回流**：复用现有 `ptl hub kernel wait` + `pth-notify` hook；新增 `--follow` 打印逐层 path 与 result 摘要。

## 7. 裁决结果（2026-08-17 用户拍板）

| # | 结论 |
|---|---|
| D1 | **强制显式路由**：无缺省入口，`pth submit` 必须显式 `--role` 或 `--tags`（保持现状，文档化） |
| D2 | **事件驱动 requeue**：子任务终态 → 主进程 notifier → 父任务 requeue（`payload.childResult`）；`tasks.await` 不轮询 |
| D3 | **调用即拒绝**：组织权校验失败 → 工具调用结构化报错，不进任务池、无 draft 旁路 |
| D4 | **先契约后收口**：本设计先落 TaskDelivery 盖章 + delegate/await 契约；0.16.4 工具面收口下一批灰度 |
| Q1 | **payload.delivery 单键包裹**（P0 实施裁决）：不与既有 payload.parent(string)/flow 撞名 |
| Q2 | **仅外部入口盖章**（P0 实施裁决）：TaskControlService 路径盖 entry 章；内部静态链发布不盖章 |
| Q3 | **全量 + 64KiB 截断 + 失败摘要**（P0 实施裁决）：sandbox 产物只走 artifactRef 引用，不进 jsonb |

## 8. 分阶段实施（设计批准后）

- **P0 契约与盖章**：✅ 已完成——TaskDelivery 类型/校验 + 入口盖章（entry）+ 终态 result
  回写（completed/rejected 双路径）+ 测试（`contracts/tasking.ts`、`task-store-pg`、
  `pg-task-repository`、`task-control-service`）；
- **P1 delegate/await**：delegation-policy + 两个能力注入 + TaskControlService 服务端校验 + 端到端测试（developer→coder）；
- **P2 事件驱动回流**：task-dispatch-notifier（子终态 → 父 requeue + childResult）+ 取消传播 + PTL wait --follow；
- **P3 穿透接口**：`skill:penetrate:*` 类型与注册校验（不实现执行优化）。
