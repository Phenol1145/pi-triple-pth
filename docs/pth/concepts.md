# PTH 概念设计（整合版 v1）

> 2026-08-13 —— 整合历次设计（SDD 25 篇 + 18 个演进提交）为单一概念源。
> 定位：**概念层**——命名、关系、原则。实现细节以代码/机制文档为准，本文件是"词表与地图"。
> 术语变更时先改这里（概念先行——实现跟进）。

---

## 0. 理论假设：心智负担理论

> 2026-08-13 用户总结——PTH 一切设计的理论根基。本节先于概念：后续 6 域概念全部标注"是哪条命题的推论"。

### 0.1 三个命题

**命题 1——思考量分摊**：复杂任务的思考总量不消失，但可以分解到多个专职角色——每个角色只思考它那份窄问题，不做全盘推演。

**命题 2——记忆量分摊**：模型的"记忆"（上下文窗口）是稀缺资源——长期知识外置到共享记忆库（memory / role-doc / capability-index）——模型不记，用的时候查——每个任务的上下文只装当前任务所需的最小知识。

**命题 3——专注度是核心**：模型智力输出质量 ≈ 智力水平 × 专注度。专注度被上下文噪声侵蚀（无关工具描述、无关历史、无关空间）——一切裁剪机制（最小工具面 / pick_tools / 描述场景化 / 渐进降输入）的本质不是省 token——是**保专注度**。

### 0.2 推论：高低智力分层

专注度足够高的窄任务，低智力模型（flash）产出 ≈ 高智力模型（pro）——而 **flash 的输出速度是 pro 不能及的**（几十 vs 几 tok/s 量级）。

因此：**"pro 想一次（规划/裁决）+ flash 干多次（执行族）"**——总成本 ≈ 用 pro 干所有事的一小部分。

### 0.3 两个边界条件（设计必须承认）

**边界 1——协调成本**：分摊不是免费的——路由、交接、worker-index 都是开销。**最优分摊粒度存在**：任务太碎→协调成本吞掉节省；任务太整→负担回到一人。
→ **controller 裁决分化/合并（"任务分化优先于 worker 分化"）正是这个平衡的调节器。**

**边界 2——可分性条件**：不可分解的任务（需要全局视野的深度推理）强行分给 flash 反而更差。
→ 所以 planner/controller 保持 pro——理论不要求"一切下沉"，要求**"可分的下沉"**。

### 0.4 理论 → 机制映射

| 理论命题 | PTH 机制 |
|---|---|
| 思考量分摊 | 正交分工 · 谱系分化 · worker-index（协调清单） |
| 记忆量分摊 | 共享记忆库 · role-doc · capability-index · 先查后试 |
| 专注度核心 | 最小工具面 · pick_tools · 场景化描述 · 五步工作流 · 负结果收敛（防无谓探索） |
| 高低智力结合 | planner=v4-pro / scout·stats=flash · 推理档声明（high/medium/low） |

### 0.5 实验证据（已实测）

- memory-stats 统计任务 13 步→2 步（描述场景化——专注度提升）
- developer gcd 三轮：19 步/177K → 15 步/117K（工具面裁剪 + 描述优化）
- cacheRead 82.6%（记忆分摊生效——重复知识不重复消费）
- sensor 数据分析：flash 侦察类角色 37 任务/973 步——低成本高频执行可行性

---

## 1. 系统定位

**PTH = 服务器端任务内核。**

```
任务池 → 角色路由 → worker 执行 → 产物提交 → 应用
                ↑                        ↑
           自我调节（控制论外环）    按需优化（JIT 内环）
```

一句话：**把工作正交分解给专职角色，每个角色用最小工具面闭环完成任务，系统用闭环机制持续优化自己——所有自改变经过人工裁决闸门。**

---

## 2. 概念词表（按域组织）

### 域 A：任务与角色（世界构成）

| 概念 | 定义 |
|---|---|
| **任务（task）** | 最小工作单元：标题/文本/标签 → 路由到角色 |
| **任务池** | 排队容器——claim 认领制（回收重领） |
| **路由（routing）** | 标签 → 角色匹配（task-resolver） |
| **角色（worker type）** | 正交分工的执行者定义：id / tags / prompt / thinking / capabilities / actionTools / description |
| **worker** | 角色实例（进程循环：peek → claim → run → 再 peek） |
| **谱系（lineage）** | 角色的父子分化树（origin → 3 支 → n 级） |
| **分化（differentiation）** | 新角色从父角色派生——提案 → 裁决 → 注册 |
| **worker-index** | 可用角色清单（全员注入 + 记忆条目——规划/路由的依据） |

### 域 B：知识（记忆体系）

| 概念 | 定义 |
|---|---|
| **记忆（memory）** | PTH 共享知识层——SQL 表 `memory_entries`（先查后写） |
| **role-doc** | 角色文档——人设/职责/任务类型/产物约定 |
| **能力索引（capability-index）** | 能力函数清单（按角色 capabilities 裁剪注入） |
| **worker-index** | 角色清单（按需注入——域 A 通道的文档形态） |
| **洞察（insight）** | 可复用经验（task-insight / tool-function） |
| **知识分层** | 条目 status 分级：protected 受保护 / official 官方 / proposal 提案 / draft 草稿 |
| **污染防线** | 写入前断言与注册表核对——矛盾拒写（"X 无工具"类） |
| **project-map** | 代码库结构地图（找文件用——生成脚本维护） |

### 域 C：空间与工具面

| 概念 | 定义 |
|---|---|
| **空间（space）** | 工具面容器（asp 模式：创建/切换/白名单） |
| **工具面（actionTools）** | 角色可调用工具白名单 |
| **三重交集** | 声明（角色 capabilities）∩ 空间面 ∩ 能力函数——运行时实际可用面 |
| **pick_tools** | 元工具——声明下一轮工具面（动态裁剪） |
| **场景化描述** | 工具 description 三要素：【场景锚点】/ 何时用 / 效果预告 + 反模式 |
| **别名表** | 直觉名 → 真实工具名映射（write_doc→file.write 等） |
| **未知工具引导** | 回填别名/引导替代方案——不直接判失败 |
| **最小工具面** | 目标驱动裁剪——目标-动作映射（动作面裁剪规则） |

### 域 D：进化（闭环与 JIT）

| 概念 | 定义 |
|---|---|
| **控制论外环** | 慢环——sensor 观测 → controller 裁决 → actuator 执行 |
| **传感器（sensor）** | 观测者（worker-opt / system-opt / memory / resource）——scorecard 聚合快照 + obs.callpoint |
| **控制器（controller）** | 裁决者（router / worker-opt / pth-opt / resource / memory）——官方化 / 拒绝 / 合并 |
| **提案（proposal）** | 调节建议——draft → 裁决 → official |
| **审批面（A/B/C）** | 人工闸门：A 代码层 / B scorecard 聚合快照 / C 角色注册 |
| **JIT 内环** | 快环——optimizer-loop：收集 → propose → apply → verify |
| **deopt 回滚** | JIT 劣化自动撤销（成熟=基线后窗口；劣化 = failRate/steps 升 50%+） |
| **时间复用率** | 并行度指标 = 1 − 关键路径任务数 / 总任务数 |
| **执行器（actuator）** | 闭环执行者——把官方建议落为实际修改 |

### 域 E：执行防护（防失控）

| 概念 | 定义 |
|---|---|
| **负结果收敛** | 同工具族+同目标连续负结果：N=3 引导（换策略）/ N=5 强制终止 |
| **参数指纹** | 连续相同动作检测（参数级——与负结果收敛并存互补） |
| **探索纪律** | 先查（memory → 能力索引 → 源码）后试——不盲探测 |
| **五步工作流** | 理解 → 探索 → 执行 → 产物 → done（共享世界观） |

### 域 F：协作（对外）

| 概念 | 定义 |
|---|---|
| **hook（pth-notify）** | PTH 完成/失败 → POST → PTL 扩展收 → 通知 + 会话消息注入 |
| **扩展（ext）** | toolstore 插件——capability 注入（登录态/互联网/数据库…） |
| **异步模式** | 派发不阻塞主会话——推送唤醒（subagent 式体验） |
| **渐进降输入** | 任务文本只写核心意图——上下文靠 PTH 内部状态自取 |

---

## 3. 概念关系（主干）

```
【执行主干】
  任务 ──路由──▶ 角色 ──claim──▶ worker ──五步工作流──▶ 产物 ──提交──▶ 应用
   ▲                │                │
   └─ worker-index  │                ├─ system prompt 注入：世界观+角色文档+角色清单+能力索引
    (派发依据)       └─ 谱系分化      └─ 工具面：三重交集 + pick_tools + 场景化描述

【演化主干】
  scorecard ──sensor 聚合──▶ 观测 ──controller 裁决──▶ 提案 ──审批面──▶ 应用
      ▲                                                        │
      └──── deopt 回滚 ◀── 劣化 50%+ ◀── verify 复测 ◀──────────┘

【防护主干】（贯穿执行全程）
  负结果收敛 · 参数指纹 · 探索纪律 · 未知工具引导 · 洞察污染防线

【协作主干】
  PTH 完成 ──hook──▶ PTL 主会话（推送 + 消息注入）──▶ 用户裁决
```

---

## 4. 设计原则（从机制提炼——每条带依据）

1. **正交分工** —— 角色谱系分化，任务正交路由。（谱系树 / 标签制）
2. **先查后试** —— 探索纪律：memory → 能力索引 → 源码。（五步工作流 / capability-index）
3. **最小信息原则** —— 工具面裁剪 / pick_tools / 场景化描述 / 渐进降输入。上下文成本即质量成本。（三轮描述实验：15 步 117K）
4. **负反馈收敛** —— 一切失控都有制动：负结果收敛 / 参数指纹 / deopt 回滚。（agent-reach 279 步教训）
5. **人工裁决闸门** —— 自修改永不自动：审批面 A/B/C。（体系自制闭环）
6. **数据驱动调节** —— 调节有度量依据：scorecard 聚合 / 时间复用率 / obs.callpoint。
7. **异步协作** —— 任务循环不阻塞主会话——hook 推送唤醒。（异步模式）
8. **持久化优先** —— 空间/角色/洞察落库——重启恢复。（空间持久化 / 官方 proposal 重建）
9. **权威谱系源** —— official proposal 是谱系真相源——重启从它重建。（重建幂等）

---

## 5. 机制 ↔ 概念映射（近期 18 提交）

| 提交 | 机制 | 主概念 | 原则 |
|---|---|---|---|
| 33fa4db | 负结果收敛 | 负结果收敛 | 负反馈收敛 |
| dec057f | PTH→PTL hook | hook | 异步协作 |
| edf6b41 | worker-index | worker-index | 先查后试 |
| 673a019 | planner 模型升级 | 角色（智力分层） | 正交分工 |
| 1065316 | 洞察污染防线 / deopt 回滚 / 空间持久化 | 污染防线 / deopt / 空间 | 负反馈收敛 / 持久化优先 |
| ab5b45a | 时间复用率 | 时间复用率 | 数据驱动调节 |
| fefb741 | description 场景化 / 别名表 | 场景化描述 / 别名表 | 最小信息原则 |
| 19badd9 | pick_tools 动态工具面 | pick_tools / 三重交集 | 最小信息原则 |
| a260170 | 审计修复批（权限/SQL/缓存字段） | 三重交集 / 知识分层 | 人工裁决闸门 |
| 9bb48cf | 审批面 B 聚合快照 | 审批面 / 传感器 | 数据驱动调节 |
| 95a2d74 | 缓存命中率链路 | 传感器 | 数据驱动调节 |
| c234884 | 官方 proposal 重建 / 角色热上线 | 权威谱系源 | 持久化优先 |
| 1065316 前 | 鲁棒性/描述/工具面（更早批次同映射） | — | — |

---

## 6. 概念 → 代码地图（关键文件）

| 概念 | 落点 |
|---|---|
| 任务池/claim | kernel/storage/task-store-pg.ts |
| 路由 | kernel/execution/task-resolver.ts · role-router.ts |
| 角色/谱系/worker-index | kernel/execution/worker-cluster.ts（+ impls/roles/default-roles.ts） |
| 五步工作流/防护 | kernel/execution/agent-loop.ts（负结果收敛/参数指纹/pick_tools） |
| 任务循环/提交/hook | kernel/execution/task-loop.ts（notifyTaskDone） |
| 记忆/知识分层/污染防线 | kernel/extensions/memory.ts · memory-policy.ts |
| 能力索引 | kernel/prompt-docs.ts（filterCapabilityDoc） |
| 空间/工具面 | kernel/execution/space-registry.ts · agent-tools.ts |
| 控制论外环 | kernel/execution/optimizer-loop.ts · observability/ |
| JIT 内环 | kernel/execution/optimizer-apply.ts（deopt 回滚） |
| 审批面 | gateway/routes-lineage.ts（C）+ optimizer-loop（B）+ 监督层（A） |
| 扩展 | kernel/extensions/ext-registry.ts · manage.ts |
| 组装/恢复 | kernel/assembly.ts（空间/角色持久化恢复 + worker-index 维护） |

---

## 7. 演进脉络（v0.9 → 现在）

```
v0.9（动作面/权限/任务池纯化）
 → v0.10（体系自制闭环：控制论×JIT + 审批面 + 空间持久化）
 → 工具调用模式优化（pick_tools + 场景化描述 + 别名表）
 → 鲁棒性三项（污染防线 / deopt 回滚 / 空间持久化）
 → 双视角审计 + 修复批
 → 扩展生态（agent-reach）
 → 传感器行为分析 + controller 裁决（死循环机制）
 → 死循环落地（负结果收敛）· hook（异步协作）· worker-index · planner 升级
 →【当前】概念整合（本文件）+ agentic 测试集（建设中）
```

---

## 8. 概念债务（整合时识别的待办）

- [ ] 术语统一：role-doc / 工具 description 中的旧术语向本词表对齐
- [ ] "工作流 SOP"——角色特定标准作业步骤尚未成为一等概念（下一步设计）
- [ ] 双 storage 层（pth/storage vs kernel/storage）概念归属待定
- [ ] 机制无单一索引（本文件 §5 是起点——后续机制落地先登记）
