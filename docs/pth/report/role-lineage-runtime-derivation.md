# Role 谱系运行流程理论推导（2026-08-24）

> 目的：进入 role catalog 化实施（role-catalog-and-four-tuple-refinement-plan.md）之前，
> 从理论上完整推导一遍当前谱系的运行流程——逐环节对照实现验证可推导性，断裂处先修再动工。
> 方法：每条回路按「前提 → 机制 → 断言 → 证据（文件）→ 判定」推导；判定三级：✓ 可推导 / ⚠ 可推导但软化 / ✗ 推导断裂。

## 0. 模型

系统 = (任务池, 谱系森林, 五回路)。谱系森林：actuator/sensor/controller 三 gen0 根（三源重构后）。
五回路：A 执行面（任务→产物）、B 观测面（sensor）、C 调节面（controller）、D 谱系演化（分化）、E 优化周期（A/B 基线）。

## 回路 A：执行面（任务 → 产物）

| 环节 | 推导 | 证据 | 判定 |
|---|---|---|---|
| A1 发布 | 任务必须带路由依据（已注册 tag 或 flow 显式角色），否则 publish 即拒——严格模式无兜底随机派发 | `role-router.ts` checkTaskRouting；装配注入 `{validate, assign}`（assembly.ts / batch-process.ts） | ✓ |
| A2 路由 | flow 显式 role 优先 → tag 精确匹配（kind=role）→ 唯一归属；governance 标签不参与 routeRole | `tag-registry.ts` routeRole | ✓ |
| A3 实例化 | 权重展开（PTH_WORKER_ROLES / profile）→ worker 副本认领匹配角色的任务 | `worker-cluster.ts` parseRoleWeights/expandRoleWeights；task-loop claim | ✓ |
| A4 执行 | agent-loop：actionTools 裁剪工具面、capabilities 门控（EXEC_TOOL_CAP/CommandGateway）、PTC 信封注入 | `agent-loop.ts`、`agent-tools-registry.ts`、`command-gateway.ts` | ✓（TCE 缺口见审计 §2：debug 族零门控等——已知，不阻塞本推导） |
| A5 族内下分 | 中间层角色 prompt 引导 `tasks.delegate` 派给直接子类型、`tasks.await` 回收；子任务 tags 由 `tagRegistry.primaryTagOfRole` 翻译 | `task-resolver.ts`、`agent-tools-registry.ts`；各中间层 prompt | ⚠ **软约束**——prompt 语义而非机制：LLM 可不 delegate 而亲自执行特化任务，无机制拦截；"是否属于特化方向"的判断无仲裁者（审计 §1 已裁决：实装 controller:router 治理类型体系演化，逐任务判断仍为分布式） |
| A6 交付 | done.result 必填（空产物护栏三段式）；实现类任务经 planHash 契约校验（实施任务） | `agent-loop.ts` empty-done 护栏；`task-loop.ts` validateImplementationDone | ✓ |

## 回路 B：观测面（sensor）

| 环节 | 推导 | 证据 | 判定 |
|---|---|---|---|
| B1 触发 | sensor 任务由谁发布？治理角色不走 delegate（delegation-policy），派发需 flow 显式 role。**全仓检索：没有任何系统 trigger/调度器发布 sensor:* 观测任务**；唯一定期治理派单是 memory-sweep-trigger（→memory-keeper，属 actuator 枝） | `system-triggers.ts`（无 sensor 调度）、`memory-sweep-trigger.ts` | ✗ **推导断裂**——观测回路无调度源，sensor 只能等操作者手工 API 派单；观测面当前不是自闭环 |
| B2 执行观测 | obs.* 十二数据源（信封治理，PTC 程序内调用） | `extensions/obs.ts` | ✓（机制存在，但 B1 断裂使其空转） |
| B3 产物 | memory.write kind=observation-report，produces 白名单 fail-fast 强制 | `memory.ts` 扩展 + W0 契约 | ✓ |

## 回路 C：调节面（controller）

| 环节 | 推导 | 证据 | 判定 |
|---|---|---|---|
| C1 触发 | 事件型 trigger：modification-plan.approved → plan.implementation ✓；skill/tool 提案 → controller:adversarial 审核——**实证断裂**：trigger 只带 `tags:["adversarial"]` 无 role 字段，adversarial 是 governance 类标签不参与 routeRole，checkTaskRouting 实测返回 `{ok:false,"缺少角色标签"}`，trigger-engine catch 记日志后跳过——**审核任务永远发布不出去** | `system-triggers.ts:90,112`；实测（tsx 直调 checkTaskRouting，2026-08-24） | ✗ **推导断裂**（实测确认）；修复 = trigger 定义补 `role:"controller:adversarial"`（一行） |
| C2 提案 | modification-plan draft，produces 强制 | W0 契约 | ✓ |
| C3 批准 | gateway 审批 → schema 校验 → planGrant 签发 → approved 事件 | `pth-gateway-facade.ts`、`plan-grant.ts`（W2） | ✓ |
| C4 实施 | plan.implementation → 按 implementation.kind 派生（param-change/storage-cleanup→actuator；code-fix→developer；role-register→无任务）；done.result.planHash 终态校验 | `plan-implementation.ts:59`、`task-loop.ts` | ✓（⚠ 附注：code-fix 硬编码 developer——最小三源系统障碍 #4） |
| C5 即时生效管控 | manage.params.set / resource.scheme.apply / tool.register/revise 需 planHash+planGrant | `manage.ts`（W2） | ✓ |

## 回路 D：谱系演化（分化）

| 环节 | 推导 | 证据 | 判定 |
|---|---|---|---|
| D1 分化感知 | 任务后 refine 管线任务 3：分析执行轨迹 → differentiation proposal（有监督，不自动创建） | `refiner.ts` | ✓ |
| D2 分化裁决 | controller:worker-opt 读观测 → manage.worker.propose 落 draft | `builtin-roles.ts` controller:worker-opt | ⚠ 依赖 controller:worker-opt 被调度——同 B1 断裂（无调度源） |
| D3 注册 | 监督批准 → 注册闸硬校验（parent 必填、L2 cap(child)⊆effcap(parent)、produces 合法） | `routes-lineage.ts`、`role-conservation-gate.ts`（W4） | ✓ |
| D4 生效 | tag 自动挂载；新角色进 allWorkerRoles → 默认 1 副本进 batch | `worker-cluster.ts` registerWorkerRole / parseRoleWeights | ✓ |

## 回路 E：优化周期（A/B 基线）——理论新增，现状缺位

2026-08-24 裁决的模型：n 轮基线窗 → sensor 观测 → controller 提案 → 批准实施 → n+1~2n 实验窗 → 比较裁决 keep/rollback。
现状对照：modification-plan 已有复测窗口/回滚条件字段（承载面 ✓），但**基线窗数据落点与两窗比较机制不存在**——scorecard/obs.callpoint 有时序聚合但没有"基线快照 vs 实验窗"的对照语义。
判定：⚠ 理论回路成立，实现缺位（属后续工作流，不阻塞 catalog 化）。

## 推导结论

**主干可推导成立**：A 执行面、C2–C5 调节面主干、D1/D3/D4 演化面——三源职责环的机制链完整。

**进实施前必须修复的断裂（两处）**：

1. **C1 adversarial 审核链断裂（实证）**——两个 trigger 补 `role: "controller:adversarial"`（flow 显式派发，与 governance 标签语义一致）。一行级修复。
2. **B1/D2 观测-调节调度源缺失**——sensor:*/controller:*（除 adversarial 事件链外）没有任何定期/事件调度源。需要"观测巡检调度"（memory-sweep-trigger 同构：定期向 sensor 七观测点 + controller 九调节点派单，或按 A/B 周期的 n 轮边界派单）。这是一个小机制，不是配置。

**软化点（记录在案，不阻塞）**：A5 delegate 软约束（由 controller:router 实装工作流治理）；E 回路实现缺位（独立工作流）；TCE 缺口（审计 §2.2，独立工作流）。

**与 catalog 化的关系**：两处断裂与角色切分正交——catalog 化不改变派发语义；但 W2/W3（sensor/controller 枝切分）会把"治理角色无调度源"从隐性断裂变成显性空转（卡片存在但无任务流），故建议断裂修复先行。
