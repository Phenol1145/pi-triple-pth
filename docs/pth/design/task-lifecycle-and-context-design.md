# 任务生命周期与上下文统一设计稿

> 状态：已实施（2026-08-23 验收通过；本文档保留为设计/落地对照）
> 目标：补齐任务生命周期的三个缺口——**goal 字段**（防长任务漂移）、**暂停状态机**（worker 向发布者提问）、**循环内压缩接线**（单 run 上下文续命）；并确立 **ASP 双轨裁决**（平铺模式为主验证路径）。
> 关联：`docs/pth/plan/llm-tool-notebook-unified-execution-backend-plan.md`（TCE 三层——本文档与其正交，接口见 §6）、`packages/pth-contracts/src/tasking.ts`、`packages/pth-kernel-execution/src/execution/context-compaction.ts`、`packages/pth-kernel-execution/src/execution/agent-loop*.ts`、`src/pth/tasking/*`。

---

## 1. 背景与现状盘点

### 1.1 上下文管理四层现状

| 层 | 机制 | 状态 |
|---|---|---|
| 单次 run 内 | 消息数组持续增长；单条 tool 结果 `truncate(2000)`；`maxSteps`（默认 10，`PTH_AGENT_MAX_STEPS`）；负结果循环检测（guide→terminate）；**认知预算账本**（memory/skill/tool 三面硬上限，`cognitive-budget.ts`）；tool-face budget ≤24 | 在岗 |
| 循环内压缩 | `shouldCompressInLoop`（pi SDK `shouldCompact`，reserve-tokens 策略） | ⚠️ **有函数没接线**——全仓库零调用（缺口 G1） |
| 任务结束 | `runAgentTask` 压缩包装器：CoT 模板压缩全轨迹 → `result.compression` → task summary + transcript 持久化（PG）；`archiveTask` 归档 workspace | 在岗 |
| 任务级寿命 | 任务 = PG 行；`TaskLease`（leaseId + 单调 generation + deadline，过期失效）→ worker 崩溃 `recoverExpired()` 回收重认领；batch-manager/worker-cluster 心跳 + watchdog | 在岗（但重认领 = **从头重做**，无断点续跑） |
| 跨任务 | 任务树 delegate context 快照（显式压缩交接）；memory 条目 + directory snapshot + 分层检索 + 预算准入；`delivery.artifactRef` 产物回流 | 在岗 |

### 1.2 任务树设计（现状详解）

任务树 = **静态类型树** × **运行时任务实例树**的叠加。

**类型树**（`builtin-roles.ts`）：`origin`（gen 0）→ 控制论三元组 `actuator`/`sensor`/`controller`（gen 1）→ `executor`/`explorer`/`governor`/`researcher`（gen 2）→ 叶子特化（最深 gen 5）。每个角色带 `parent`/`generation`/`differentiation`（分化理由是一等数据，优化循环路径 B 依赖它）。中间层是纯路由节点（"不预设分支方向，delegate 下分，await 回收"）。

**组织权矩阵**（`delegation-policy.ts`）：只能投给**直接子类型**；planner/governor 补充 executor 族后代；治理面角色与叶子为空矩阵——`hasDelegationAuthority=false` 时 **delegate/await 工具不注入**（Tool 层消权）。

**实例树盖章纪律**：`payload.delivery` = `{parent, path, lineageId, replyTo, artifactRef}`，**只能服务端按调用者身份盖章**（`TaskDispatchContext`，task-loop 每任务盖章），worker/外部不可自报。入口任务盖 entry delivery（`path=[assignedRole]`、`lineageId=taskId`）。

**两个半原语**：
- `tasks.delegate`：组织权校验 + F3 域收窄（`domains ⊆ caller.domains`）+ 自包含 text + `context` 压缩快照 + `expect`（result/artifact/report）。
- `tasks.await`：只允许直接子任务；子未终态 → 抛 `TASK_AWAIT_SUSPENDED_CODE` → retryable rejection 落回 pending（**不占 claim**）→ notifier 监听子终态写 `payload.childResult` → 父重认领 → `tasks.resume()` 读 childResult **幂等续跑**（不重复 delegate）。代价：父从头重跑，要求任务程序幂等。
- `tasks.penetrate`：稳定派发边固化为 `skill:penetrate:<to>`，同进程嵌套调用子 agent；执行期实时重验组织权。

**级联取消**：`TaskControlService.cancel` 用 recursive CTE 沿 lineage 取消整棵子树。

### 1.3 任务管理工具面现状

| 面 | 内容 |
|---|---|
| PTC caps（窄端口注入） | `tasks.delegate/await/resume/penetrate`——仅组织权角色；`tasks.peek/submit` 已摘除（权限 v2 R3） |
| 服务端（TaskControlService） | `publish/delegate/awaitTask/cancel(递归)/list/get` |
| HTTP | `POST/GET /api/v1/kernel/tasks[/:id[/transcript|/cancel]]`、`POST /api/v1/kernel/jobs`（≤50 批量）、`GET /api/v1/kernel/templates` |
| 观测 | `obs.tasks({status?, role?, since?, limit?})`（sensor 只读） |

**双通道事实**：LLM 工具面（~30 个：执行核 + dev/debug/write 空间生产工具 + nav/cache + done）承载执行；caps 注入面（memory/tasks/obs/manage/ext/skills/llm/web/fs/env）承载治理/记忆/任务/观测——后者**没有 tool-call 形态**，唯一入口是 ts 程序。

### 1.4 缺口清单

| # | 缺口 | 影响 |
|---|---|---|
| G1 | 循环内压缩未接线 | 单 run 上下文寿命 = maxSteps × 步均 token；长任务只能靠拆树 |
| G2 | 无 goal 原语 | 根意图逐层转述衰减 → 长任务漂移无对抗机制 |
| G3 | 无暂停/提问通道 | worker 遇到规约不清只能瞎猜或失败；`escalated` 状态存在但 worker 无法主动到达 |
| G4 | 无 run 级断点续跑 | 重认领/await 重跑都是从头再来（maxSteps=10 下代价尚可接受） |
| G5 | `TaskSuspension` 只有 `kind:"human"` 且 `onSuspension` 装配层未接线 | 人审暂停缝存在但不通 |

---

## 2. goal 字段（防长任务漂移）

### 2.1 问题定位

漂移根源：任务 text 是**自包含局部指令**，逐层 delegate 逐层转述，根意图在转述中衰减——gen-5 叶子里只剩"给这个 diff 写回归测试"，为什么做、做到什么程度算够全部丢失。压缩（结束压缩/context 快照）进一步加剧衰减。

### 2.2 契约

```ts
// packages/pth-contracts/src/tasking.ts — TaskDelivery 扩展
interface TaskDelivery {
  // ...现有字段（parent/path/lineageId/replyTo/artifactRef）
  /** 根目标（入口盖章，delegate 时服务端原样传播——不可转述、不可改写） */
  goal?: string;
}
```

存储：`task_templates` 加 `goal TEXT` 列（模板默认值——发布时缺省继承）；任务实例存 `payload.delivery.goal`（沿用 delivery 盖章通道，不动 tasks 主表结构）。

### 2.3 盖章与传播纪律

1. **入口盖章**：发布任务可带 goal（显式参数 > 模板默认）；服务端盖进 delivery。
2. **原样传播**：delegate 时服务端把 caller 的 goal **逐字**盖给子任务——和 lineageId 同纪律，worker 不能改。
3. **goal 与 text 分工**：goal = 北极星（全树恒定）；text = 当前航段（每层自定）。子任务局部意图进 text，不动 goal。
4. **不可转述是核心裁决**：防漂移的本质是抗衰减，允许每层"精炼" goal 等于把衰减合法化。

### 2.4 三个消费面

| 面 | 机制 |
|---|---|
| prompt 面 | system prompt 增加 `【根目标】` 段——**模态无关**（不挂 ASP_BLOCK，见 §5 双轨纪律）；恒定不进消息数组，压缩压不掉 |
| done/验收面 | acceptor 拿 goal 对照产物；v1 先进 prompt 软约束（done summary 要求对照 goal 自述对齐），后续可升 L0 规则 |
| 观测面 | scorecard 记录"goal 存在但产物偏离"信号 → L3 hotspot 新规则 `goal-drift`（某模板/路径高频漂移 → 模板修正或角色收窄） |

### 2.5 兼容性

goal 可选；legacy 任务无 goal → prompt 段省略，不 break。v1 不做 goal 的 LLM 自动判定（非目标）。

---

## 3. 暂停状态机与 pause/answer 原语

### 3.1 与现有机制的划界

| 机制 | 方向 | 等待谁 | 语义 |
|---|---|---|---|
| `tasks.await` | 父**向下**等 | 子任务终态 | 等产物（挂起→requeue，等待期**不可见**） |
| `waiting-human` | 向**人**等 | human_requests 响应 | 等批准（approve/reject 二值） |
| **pause（新）** | 子**向上**问 | **任务发布者**（父任务 or 人类创建者） | 等**自由文本回答**（**自有状态、可查询**——待回答问题箱） |

pause 与 await 对偶：await 是结果回流前的等待，pause 是问题上行澄清的等待。关键差异：await 挂起后任务回 pending（等待不可见），pause 有自己的状态（提问必须可被发布者发现和回答）。

### 3.2 状态机修改

```
claimed ──pause──▶ paused ──答案到达──▶ pending（requeue，lease 重签）
                     │
                     ├─超时（paused_expires_at）─▶ escalated
                     ├─pause 预算耗尽（见 §3.5）─▶ escalated
                     └─发布者/人工取消─▶ cancelled
```

- `tasks_status_check` 增加 `'paused'`；新增列 `paused_at TIMESTAMPTZ`、`paused_expires_at TIMESTAMPTZ`；
- **claim 查询排除 paused**（不可认领）；僵尸回收不误伤（paused ≠ claimed）；pause 时**释放 lease**；
- 问题写 `payload.pauseQuestion{question, context?, askedAt, askedBy: roleId}`；答案写 `payload.pauseAnswer{answer, answeredBy, answeredAt}`；
- **副作用**：`escalated` 首次成为 worker 可主动到达的状态（G3 闭环）。

### 3.3 pause 工具（agent-loop，与 done 同类）

```
pause({ question: string, context?: Record<string, unknown> })
```

- **是循环控制工具，不是 caps 函数**——agent-loop 拦截，终止当前 run（同 done 的循环语义；按 TCE 决策 12 留在 TCE 粒度之外）；
- **全空间可用**（不像 done 仅 meta——见 §5 双轨纪律：平铺模式没有元空间，pause 必须模态无关）；
- 空 question 走 done 同款引导护栏（回填提示，计入预算）；
- 语义信号：runner 返回 `TaskSuspension{ kind: "publisher-question", ... }`（TaskSuspension kind 扩展，G5 同批修）；dispatcher 提交 paused 终态。

### 3.4 answer 通道（双发布者）

1. **发布者是父任务（agent）**：notifier 对称扩展——pause 事件写父任务 `payload.childQuestion[childId]`；父在 await 挂起中被唤醒重跑，读到问题后用新原语 `tasks.answer({taskId, answer})` 回答（caps 窄端口——**只能回答自己的直接子任务**，服务端校验 `delivery.parent.taskId`）。回答 → 子任务 paused→pending。
2. **发布者是人类（入口任务）**：新路由 `POST /api/v1/kernel/tasks/:id/answer`（挂现有 auth）；`GET /api/v1/kernel/tasks?status=paused` 即"待回答问题箱"。

### 3.5 恢复语义与护栏

**恢复（v1 务实裁决）**：与 await 一致——**重跑 + 答案注入**。重跑时 system prompt 注入 `【发布者澄清】` 段（pauseAnswer 内容），程序幂等续接。maxSteps=10 现状下重跑代价极小。v2（需循环内压缩 + 消息持久化，见 §4）升级为真断点续跑——列入非目标。

**护栏**：
- **pause 预算**：单任务最多 3 次（`payload.pauseCount` 计数），超限 → escalated 交人（防问答死循环）；
- **暂停超时**：`paused_expires_at` 缺省 24h（`PTH_TASK_PAUSE_TIMEOUT_MS` 可配），超时 → escalated 而非静默烂掉；
- **频率信号**：pause 率 → scorecard → L3 hotspot 新规则 `spec-ambiguous`（某模板/角色 pause 率高 = 规约模糊 → 模板修正或 goal 补全）。**goal 与 pause 在此闭环：goal 缺失是漂移因，pause 是漂移的求救信号。**

---

## 4. 上下文管理补齐

### 4.1 循环内压缩接线（G1）

agent-loop 每步开头调 `shouldCompressInLoop(messages, contextWindow)`（现成函数）：
- 触发 → `compressContext` + **续跑模板**（新增 `CONTINUATION_TEMPLATE`，见 §4.2）→ 消息数组折叠为 `[system, 压缩摘要, 最近 N 条]`（N 缺省 4，保留近期手感）；
- system prompt 不进压缩输入（现成纪律）——**goal 段在 system 里天然免疫**（§2.4 设计与此咬合）；
- 压缩失败容忍不阻断；压缩事件（输入规模/压缩率）记 scorecard。

### 4.2 续跑模板（与 CoT 模板分工）

| 模板 | 时机 | 保留重点 |
|---|---|---|
| `COT_TEMPLATE`（现有） | 任务结束 | 思维过程/坑与修正/效率自评——评估产物 |
| `CONTINUATION_TEMPLATE`（新） | 任务中途 | **目标 / 已确认事实 / 当前状态 / 未完成事项 / 下一步**——续跑保真 |

### 4.3 与暂停恢复的关系

v1 暂停恢复靠重跑（§3.5）；§4.1 落地后单 run 寿命延长，pause 更稀缺（更少被迫早早提问）。真断点续跑（消息检查点落 PG）依赖 `__messages` 逃逸口 + 持久化，列 v2 非目标。

---

## 5. ASP 双轨裁决

### 5.1 裁决内容

**双轨并行，平铺为主验证路径**（2026 复审裁决）：

- ASP 代码**不删**（space-registry / space-index / ASP_BLOCK / 内联执行保留，作为对照轨）；
- **主验证路径切到平铺模式**：compose/runner 默认 `PTH_ASP_MODE=off`，ASP 需显式 `=on` 开启（默认值站在主路径上；ASP 轨存在感靠测试套件显式 `asp:true` 用例维持）；
- **bindRoles/生成空间语义不迁移**（ASP 轨冻结，不做工具组迁移；若未来 ASP 轨废弃再议）。

### 5.2 双轨维护纪律（新功能必须双模态成立）

1. **pause 不挂空间门控**（§3.3——平铺无元空间）；
2. **goal / 发布者澄清段模态无关**——进 system prompt 主体，不进 ASP_BLOCK；
3. 新工具门控只走 capability/Command 层，**不新增空间门控**；
4. **ASP_BLOCK 冻结**——不再投入重写（其文本与现状的脱节留在 ASP 轨内，显式声明"对照轨不参与新机制"）。

### 5.3 平铺基线验证（扶正前置）——✅ 已完成（2026-08-23）

`PTH_ASP_MODE=off` 全量 vitest：**303 文件 / 2659 测试全绿**（58 skipped 为 docker/专业后端集成测试，常规跳过；2026-08-23 验收时点）。

覆盖面分析（比预估乐观）：
- **平铺本来就是测试套件默认模态**——`agent-loop.ts` 的 `input.asp === true` 判定意味着不显式传 asp 的测试全走平铺；
- 显式平铺用例在岗（`agent-loop.test.ts`：flat 面剔除 asp_cd/asp_index/memory_index/cache_*）；
- ASP 轨由显式 `asp:true` 用例维持（asp-space / space-governance / agent-loop asp 段）——双轨纪律的测试地基已在。

残留风险：compose 级 E2E（真实 worker 跑真实任务、默认 on）未覆盖——默认翻转（§5.1）随 P0 实施批次落地后，以观察期补验。

---

## 6. 与 TCE 的接口

| 本文档产物 | TCE 落点 |
|---|---|
| `pause` | 循环控制工具（同 done）——按 TCE 决策 12 留 TCE 粒度之外，agent-loop 拦截 |
| `tasks.answer` | **internal 收编首批候选**（Phase 4 internalExecutor 注册表——与 delegate/await/resume 同批过 CommandGateway） |
| Command 层 deny/await-approval + pause/answer 事件 | scorecard 新信号源（TCE §3.6 观测面扩展） |
| goal prompt 段 | 与 tool-face budget 无交互（prompt 段不是工具） |

正交性声明：本文档不改 TCE 任何决策；TCE 实施不受本文档阻塞，反之亦然。

---

## 7. 决策点清单

| # | 决策 | 裁决 |
|---|---|---|
| 1 | goal 存放 | delivery 盖章通道（`payload.delivery.goal`）+ `task_templates.goal` 列作默认源 |
| 2 | goal 传播 | **原样逐字传播，不可转述**（抗衰减是目的本身） |
| 3 | paused 是否独立状态 | **是**——提问必须可查询（await 式不可见 requeue 不适合问答） |
| 4 | pause 工具形态 | **agent-loop 循环控制工具**（同 done），非 caps 函数 |
| 5 | pause 空间门控 | **无**——全空间可用（双模态纪律） |
| 6 | answer 形态 | caps 原语 `tasks.answer`（父 agent，服务端校验直接父子关系）+ HTTP 路由（人类） |
| 7 | 恢复语义 | v1 重跑 + 答案注入 prompt；v2 断点续跑列非目标 |
| 8 | pause 护栏 | 预算 3 次/任务 + 超时 24h → escalated |
| 9 | ASP | **双轨并行，平铺为主验证路径，默认翻转，ASP_BLOCK 冻结** |
| 10 | bindRoles/生成空间 | 不迁移不删除，ASP 轨冻结 |
| 11 | 循环内压缩 | 接线 `shouldCompressInLoop` + 续跑模板；折叠保留最近 4 条 |
| 12 | goal 自动判定 | v1 非目标（先进 prompt 软约束 + scorecard 信号） |

## 8. 分期

| 期 | 内容 | 落地结果 |
|---|---|---|
| **P0** | 契约 + schema：`TaskDelivery.goal`、`task_templates.goal` 列、`paused` 状态 + 2 列、`TaskSuspension.kind` 扩展；**平铺基线验证**（§5.3） | ✅ 完成：tsc + 迁移幂等 + 平铺全绿 |
| **P1** | pause 工具 + 通道：agent-loop pause、dispatcher paused 提交、TaskControlService.answer、notifier childQuestion、HTTP answer 路由 | ✅ 完成：端到端 worker pause → 人类 HTTP answer → 任务重跑带澄清段 |
| **P2** | prompt 整合：goal 段（发布/delegate 盖章 + system prompt 注入）、发布者澄清段、pause 护栏（预算/超时 sweeper） | ✅ 完成：goal 逐字传播 + 【发布者澄清】注入 + 预算 3/24h 升级 |
| **P3** | 循环内压缩接线 + CONTINUATION_TEMPLATE | ✅ 完成：`shouldCompressInLoop` 接线 + 续跑模板 |
| **P4** | 观测面：scorecard 信号（goal-drift/spec-ambiguous/pause 率/压缩率）+ L3 hotspot 规则 × 2 + 文档（concepts.md 更新） | ✅ 完成：scorecard 信号 + hotspot 规则 + 文档更新；`npm run lint` + `npm test` 全绿 |

每期独立可交付、独立回滚；P0 不破坏任何现有路径（全部增量列/可选字段）。

## 9. 非目标

- goal 的 LLM 自动对齐判定（v1 只要信号与软约束）；
- run 级消息检查点持久化（真断点续跑——v2）；
- ASP 删除或 ASP_BLOCK 重写（双轨冻结）；
- `human_requests` 契约变更（pause 不走人审通道——它是任务树内通道）；
- worker 主动 escalate 工具（pause 预算耗尽自动 escalated 已覆盖主要场景）。
