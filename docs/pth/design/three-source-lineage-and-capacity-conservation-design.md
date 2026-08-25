# 三源谱系与能力守恒概念设计

> 状态：**已定稿**（2026-08-24——9 条裁决全部定案；实施依据见 `three-source-lineage-refactoring-plan.md`）
> 分支：`feat/pth-exec-unified`
> 前置概念：`concepts.md` §0.7（控制理论 × 现代 JIT）、§0.16（谱系/任务投递/工具面收口）；
> 关联设计：`execution-modes-and-tool-reg-v2-design.md`（WorkerKind / 观察策略 / 优化循环）、
> `pth-bench-unified-design.md`（受控测量装置——本设计的下游消费者）。

本文是角色谱系的概念级重构：**Origin 退役，sensor / controller / actuator 升格为 generation 0
三源头**，严格定义三者用途；并以**能力守恒定律**给出谱系的测度结构（每一代并集 = 系统总能力，
generation 越大粒度越细）。

---

## 0. 裁决记录（用户——2026-08-24，选择题裁定，9/9 定案）

| # | 问题 | 裁决 |
|---|---|---|
| Q1 | sensor/controller 产物契约 | **新设 `observation-report` + `modification-plan` 两 kind，废止 `optimizer-suggestion`**（存量 draft 标注迁移） |
| Q2 | controller 信息源边界 | **注册面/配置面只读快照可读；`obs.*` 原始观测数据禁读**——判断必须建立在 sensor 评估上 |
| Q3 | actuator 实施位载体 | **不设专位，按方案的产物类型路由**——`modification-plan` 自含 `implementation` 路由声明；「逐字执行、不得改方」挂**任务类型契约**（plan hash），不挂角色 |
| Q4 | terminal reject 兜底 | **废除转写机制整体**——terminal reject = 终态 + 经 PTH HTTP API（events/SSE）外推操作面；「升级链终点」概念删除。理由：静默兜底使系统性失败不可定位 |
| Q5 | generation 重编号 | **全树顺移**（核查证实 `role.generation` 无路由/权限/校验消费——仅「父+1」派生计算与展示排序，对一致顺移安全；`lease.generation` 是租约代数，与谱系无关） |
| Q6 | 守恒「能力」口径 | **治理面声明能力四元组** `cap(r)=⟨T,A,D,O⟩`；O(r) 复用 W8 组织权矩阵推导；D(r)=⟨R,W,K⟩，K 经新增 `produces` 字段落地 |
| Q7 | 兄弟能力互斥性 | **质量指标非硬约束**——重复度 = 合并候选信号（controller:worker-opt「任务类型合并优先」裁决输入） |
| Q8 | code role 术语 | **code role = 类型壳**（声明 ⟨任务接取面, 可调用内部库, 可达数据面, 组织权⟩——即 cap 四元组）；**code worker = 壳的运行时实现**，WorkerKind 重新定位为壳的「实现形态」字段 |
| Q9 | 守恒校验器时机 | **随重构一并实施**（check-role-conservation + 钉死测试同 wave） |

---

## 1. 背景与动机

### 1.1 现状（重构前）

- `origin` = generation 0 单根：全能起点 + 升级链终点（terminal reject 转写 `origin` 标签兜底）
  + 全树组织权；
- 控制论三元组 `sensor/controller/actuator` 以 gen=1 挂 Origin 之下（2026-08-14 裁决升格为真实类型）；
- actuator 辖执行/信息/治理/研究四族（全部生产工种）；sensor 辖 7 观测点；controller 辖 9 调节点。

### 1.2 三处职责越界（重构的直接动因）

| 越界 | 现状 | 本应归属 |
|---|---|---|
| sensor 开处方 | sensor prompt 含「建议动作空间/记忆空间优化方向」，产物 kind=`optimizer-suggestion` | 方案生成是 controller 职责 |
| controller 搞实施 | `controller:pth-opt/resource/rule` 直接 `manage.params.set` 热调参；`controller:resource` 直接执行「恶化回滚」 | 实施是 actuator 职责 |
| Origin 冗余根 | W8 已裁决入口强制显式路由（无缺省入口），Origin 的全树组织权名存实亡；其兜底职能掩盖系统性失败 | 三源自洽后无根位 |

### 1.3 重构命题

谱系轴 = 职责轴。三源头不是三个工种，而是三种「与系统的关系」：
**actuator 在系统里面干活，sensor 在系统上面看，controller 在系统旁边想。**
一个能生万物的单根与一个职责严格分化的森林在逻辑上互斥——Origin 必须退役。

---

## 2. 概念模型：三源森林

谱系从「单根树」变为「三源森林」——三根各自为 generation 0，各有独立的分化几何：

| 源头 | 分化轴 | 分化依据 | 现有子树（重构后 gen） |
|---|---|---|---|
| **actuator** | 按问题/工种类型 | 「这是什么活」 | executor/explorer/governor/researcher 四族（gen=1）→ 全部叶子工种 |
| **sensor** | 按观测点位 | 「看哪里」——环向 × 0.17.4 对象维 | sensor:worker-opt/system-opt/resource/memory/tool-face/tool-single/rule（gen=1） |
| **controller** | 按调节点位 | 「调哪里」——与观测点位镜像 | controller:router/worker-opt/pth-opt/resource/memory/tool-face/tool-single/rule/adversarial（gen=1） |

**森林封闭性**：不存在跨族父子（不会有角色「从 sensor 分化成 developer」）；
分化提案的目标根由方案性质唯一确定。

---

## 3. 严格职责定义（核心）

职责 = **使命 + 允许动作空间 + 产物类型 + 显式禁止**。四要素钉死，越界即设计缺陷。

### 3.1 sensor —— 观察与评估

| 要素 | 定义 |
|---|---|
| 使命 | 观察系统运行，**评估**运行情况（健康/劣化/瓶颈/异常/趋势） |
| 允许动作 | 只读数据源（`obs.*` / metrics / scorecard / memory 只读查询）；交叉校验其他 sensor 观测（防单点噪声）；读 bench 归档（受控测量——`pth-bench-unified-design.md`） |
| 产物 | `observation-report`（kind）：**事实 + 判断**——观测到什么、问题定位、严重度评估、证据链 |
| 显式禁止 | ❌ 不得产出修改方案（「怎么办」一字不提）；❌ 不得写 `modification-plan`；❌ 不得调用任何 `manage.*` |
| kind 形态 | **code 态**（观察策略/活动因子——天然合规：纯测量从不提方案）· **llm 态**（读因子下评估判断）· hybrid = code 产因子 + llm 评估 |

> 新定义实质是把 LLM 态 sensor 对齐到 code 态早已遵守的纪律——**测量与处方分离**。

### 3.2 controller —— 方案生成

| 要素 | 定义 |
|---|---|
| 使命 | 基于 sensor 的评估，提出**可用的修改方案** |
| 允许动作 | 读 `observation-report`；读**注册面/配置面只读快照**（`manage.tool.list` 类——方案落地必须知道现状，Q2 裁决）；对抗性自审（controller:adversarial 点位——审核方案的 reward-hacking/越权/目标函数漏洞，审核 ≠ 实施） |
| 产物 | `modification-plan`（kind，draft）：目标 / 具体变更内容 / 预期效果 / **回滚条件** / **复测窗口** / **`implementation` 路由声明**（产物类型：param-change / code-fix / storage-cleanup / role-register / …，Q3 裁决） |
| 显式禁止 | ❌ 不得实施任何变更（`manage.params.set` 等即时生效工具全部移出——越界清算见 §8）；❌ 不得读 `obs.*` 原始观测数据（防「既当裁判又当运动员」）；❌ 不得批准自己的方案（批准权在监督层） |
| kind 形态 | llm 态为主（方案生成需要判断）· code 态 = 规则表自动生成 plan（perf-autopilot 规则表——现有语义重新归类） |

> controller 现描述中「裁决者（official/reject/merge）」语义**收窄为方案的初审与生产**——
> official 盖章权上移到审批面。**controller 是参谋部，不是司令部。**

### 3.3 actuator —— 工作负载与方案实施

| 要素 | 定义 |
|---|---|
| 使命 | ① 承担全部实际工作负载（生产任务）；② 实施 controller 提出且已批准的修改方案（**不设专位，按方案产物类型路由**——Q3 裁决） |
| 允许动作 | 四族全部生产能力；实施 official 方案（携 plan hash 的实施任务——见 §4.3）；terminal reject 相关职能见 §5（Q4 裁决：不兜底、外推） |
| 产物 | 任务交付物 + `implementation-report`（实施记录：做了什么、结果、实测基线、方案 hash 引用——供 sensor 复测对照） |
| 显式禁止 | ❌ 不得评估自身运行（自评 = sensor 的活）；❌ 不得修改方案内容（official 后逐字执行——发现方案有问题只能在 `implementation-report` 标注失败回传）；❌ 治理族不豁免（D2 裁决延续） |
| kind 形态 | llm 态 = 生产 worker · code 态 = loop runtime / drainer / scheduler + apply 执行件 |

### 3.4 实施的三种形态（防概念混淆）

| 形态 | 谁实施 | 例子 |
|---|---|---|
| ① 人工实施 | 人 | 重启级参数、部署变更、记忆删除类 |
| ② 注册生效 | 治理面系统件（审批面本身） | 角色/工具/skill 注册——批准即生效，**不算任何源头的职责** |
| ③ actuator 实施 | 按方案产物类型路由的 actuator 任务 | 热调参、存储清理、batch 扩缩、修复任务 |

只有 ③ 属于 actuator 职责；② 是系统对治理决议的机械执行，不是 worker 行为。

---

## 4. 标准控制回路（重订契约）

```
sensor 观察+评估
  └─产物: observation-report（事实+判断，无方案）
     ▼
controller 读 report → 生成方案
  └─产物: modification-plan draft（方案+回滚条件+复测窗口+implementation 路由声明）
     ▼
审批面 A/B/C（人在回路）→ official / reject
     ▼
实施三分流: ①人工 ②注册生效 ③actuator 实施任务（plan hash 契约）
  └─产物: implementation-report（实施记录+实测基线）
     ▼
sensor 复测（verify 窗口——负反馈闭环）
  └─恶化 → observation-report 标注「劣化+证据」→ controller 提「回滚方案」（也是 modification-plan）
```

### 4.1 回滚语义的归位

复测恶化不触发任何「先斩后奏」通道：回滚也是一个方案，走全回路（可设审批快速通道）。
闭环上没有任何角色拥有例外权。

### 4.2 产物契约（Q1 裁决）

- 新设 kind：`observation-report`（sensor 专属）、`modification-plan`（controller 专属）；
- 废止 `optimizer-suggestion`：存量 draft 一次性标注迁移（meta 标记 `migratedFrom: "optimizer-suggestion"`，按产物语义拆分归属）；
- kind 归属由 §6.3 的 `produces` 字段在 `memory.write` 边界服务端强制（fail-fast）。

### 4.3 实施任务契约（Q3 裁决落地）

- `modification-plan` 必填 `implementation` 字段：`{ kind: "param-change"|"code-fix"|"storage-cleanup"|"role-register"|…, routeHint?: string }`；
- official 后系统按 `implementation.kind` 派生普通 actuator 任务，payload 携**方案原文 hash**；
- 「逐字执行、不得改方」不挂角色、挂任务类型契约：实施任务 `done` 时 `result` 必须引用方案 hash，
  偏离即 reject（服务端校验）；实施所需的高权能力（如热调参）经 **plan grant** 注入
  （复用 N28 execution-grant 机制——grant 绑定方案 hash + official 状态，无 grant 拒执行）。

---

## 5. Origin 职能分解与退役

Origin 不是删除，而是**职能分解**——三项职能各有去向，且去向都比挂在 Origin 上更语义自洽：

| Origin 现有职能 | 去向 | 理由 |
|---|---|---|
| 全能兜底 / 升级链终点（terminal reject 转写 `origin` 标签） | **废除转写机制整体**（Q4 裁决）——terminal reject = 终态 + events/SSE 外推操作面 | 静默兜底使系统性失败不可定位；失败外推比失败消化诚实 |
| 全树组织权 / 全树投递权 | **废除** | W8 已裁决入口强制显式路由（无缺省入口）——Origin 全树权是前 W8 时代遗留 |
| 谱系之根（gen 0 叙事） | 三源头各自为根 | §2——三根各有自己的分化几何 |

退役连带：`ORIGIN_ROLE` 定义删除；trigger/tag-registry 的 `origin` 标签与转写逻辑删除；
组织权矩阵删 origin 行；worker-cluster 谱系根注释改写；谱系展示支持多根。

---

## 6. 能力守恒定律（谱系的测度结构）

### 6.1 定律陈述

设系统总能力为 **C**（当前全部已注册动作空间 + 任务类型覆盖 + 数据空间 + 组织权总和——
C 随扩展/工具注册增长，按版本计）。

| # | 定律 | 形式化 |
|---|---|---|
| L1 | **覆盖守恒** | 任意 generation g：`⋃ effcap(r)（r ∈ gen g）= C`。分化不创造能力、不丢失能力，只重新划分 |
| L2 | **细化单调** | `cap(c) ⊂ effcap(p)`（子 ⊂ 父有效能力）。generation 是能力粒度的单调轴 |
| L3 | **粒度-深度相关** | gen 越大粒度越细——特化单向（泛化 → 特化），不存在「子比父更泛化」的倒挂 |

推论：每一代都是 C 的一个覆盖（cover），深一代是浅一代的加细（refinement）——
**谱系 = C 上的测度保持细化层级**。

### 6.2 「能力」口径（Q6 裁决）：治理面声明能力

若按「理论可达性」定义，`execTs` 普适（PTC 唯一通用执行基板）使每个叶子角色能力都 = C，
定律退化为恒真。故定为**治理面声明能力四元组**：

```
cap(r)  = ⟨ T(r) 承诺任务类型, A(r) 动作面（actionTools/capabilities 白名单）,
             D(r) 数据面, O(r) 组织权 ⟩
effcap(r) = cap(r) ∪ ⋃ effcap(O(r) 可及子树)     // 经投递可支配的子树能力计入
```

0.16.4 工具面收口与守恒不冲突、互证：收口收的是「亲自执行」，
守恒守的是「职责可及能力」（MID 角色经投递权覆盖整个子树）。

### 6.3 O(r) 与 D(r) 的具体化（Q6 裁决落地）

**组织权 O(r)**（已实施，校验器直接复用——单一事实源）：

```
O(r) = children(r)                     # 逐级继承（0.16.1）
     ∪ supplement(r)                   # 显式补充表（仅 planner/governor 跨子树补充权）
     − {sensor 系, controller 系}      # 治理两族无投递权
     （原 origin 全树权行——随退役删除）
```

实现：W8 P1 组织权矩阵（batch-process 注入 `tasks.delegate/await` 投递面 + 服务端 fail-fast）。

**数据面 D(r)** = `⟨R(r) 可读空间集, W(r) 可写空间集, K(r) 承诺产物 kind 集⟩`：

| 分量 | 底座 | 状态 |
|---|---|---|
| R(r) / W(r) | memory `spaceScope{space,visibility}`（`isVisible`）+ 谱系元数据 `defaultReads` + N28 verified scope / authorized-task-reads | ✅ 已有声明位与强制缝 |
| **K(r)** | 角色定义新增 **`produces`** 字段（如 sensor 系 `["observation-report"]`、controller 系 `["modification-plan"]`、生产工种 `undefined`=不限）；`memory.write` 边界服务端校验（kind ∉ produces → fail-fast，与组织权同款模式） | ❌ 缺口——本次重构补上 |

### 6.4 守恒的工程承载机制

| 机制 | 与守恒的关系 |
|---|---|
| 父角色泛化兜底（MID「仅泛化任务亲自执行」） | **L1 的承载机制**：子类型未覆盖的子域由父保留——兜底不是过渡态，是守恒的永久结构 |
| 0.16.4 工具面收口 | 与 L2 同向：父动作面收窄 = 粒度轴上「亲自执行」让位「组织执行」 |
| 组织权逐级继承 | L2 的组织权投影：`cap(c) ⊂ effcap(p)` ⇒ 父对子树理解充分 ⇒ 组织权成立——守恒给组织权提供理论根据 |
| Origin 退役 | L1 在 gen 0 的直接验证：sensor ∪ controller ∪ actuator = C——Origin 是重复覆盖，不是补充覆盖 |

### 6.5 code role 与 code worker（Q8 裁决）

- **code role = 类型壳**：声明 ⟨任务接取面 T, 可调用内部库 A, 可达数据面 D, 组织权 O⟩——
  即 cap 四元组；谱系树节点（0.16.1「谱系是类型树不是实例树」）；
- **code worker = 壳的运行时实现**：batch 副本 / 执行单元；
- **WorkerKind 重新定位**：不再是与「定义来源」正交的轴，而是**壳的实现形态字段**
  （llm = 任务队列 agent loop 实现；code = loop runtime/drainer/scheduler 实现；hybrid = 混合）；
- 对照轴「定义来源」：code role（代码静态定义）/ registered role（治理面动态注册）——
  registered role 注册时强制挂进谱系，L1–L3 校验通过才批准（§7）。

### 6.6 互斥性定位（Q7 裁决）

只裁决**并集 = C（覆盖完备）**；兄弟间不交（互斥划分）**不作硬约束，作为分化质量指标**——
重复度高 = 合并候选（controller:worker-opt「任务类型合并优先于 worker 合并」裁决输入）。
现状跨族重叠（tester/acceptor 同涉验证、分属 executor/governor 族）是合理的「同能力、不同职责关系」。

---

## 7. 可审计性（Q9 裁决：随重构一并实施）

1. **静态校验器** `scripts/check/check-role-conservation.ts`：从 builtin-roles + tool-reg 快照计算
   各 generation 的 effcap 并集与 C 对账——漏覆盖（有工具无任何角色承诺）/ 倒挂（子 ⊀ 父）fail-fast；
   兄弟重复度以报告形式输出（质量指标，不 fail）；进 lint 套件（与 check-pth-config 同档）；
2. **注册时校验**（治理面）：分化/注册提案批准闸增加 L1–L3 校验——新角色必须是父能力真子集、
   兄弟并集不得破覆盖、`produces` 声明合法；
3. **钉死测试**：与 `agent-tool-convergence.test.ts` 同档——「各代并集 = C」「无倒挂」
   「produces 边界 fail-fast」「terminal reject 触发 events 推送」。

---

## 8. 越界清算表（现状 → 新定义）

| # | 现状 | 新定义 | 处置 |
|---|---|---|---|
| 1 | sensor prompt 含「建议优化方向」 | 只评估不处方 | 7 个 sensor prompt 改写 |
| 2 | sensor 产物 kind=`optimizer-suggestion` | `observation-report`；`modification-plan` 归 controller；旧 kind 废止 | memory kind 迁移 + `produces` 强制 |
| 3 | controller 直调 `manage.params.set` 热调参 | 移出 controller 工具面；实施经 plan grant 的 actuator 任务 | 3 个 controller prompt + 工具面矩阵 |
| 4 | controller:resource「恶化回滚」直接执行 | 回滚 = 方案，走全回路 | prompt 改写 |
| 5 | controller:pth-opt「新扩展经 toolstore 产物链路」（实施语义） | 扩展编写提案 → 批准后实施分流 | prompt 改写 |
| 6 | controller:worker-opt `manage.fix.approve` 直派 debug-case-writer | 派任务 = 实施语义 → 改为提案（批准后路由） | prompt + 工具语义调整 |
| 7 | origin = 根 + 兜底 + 全树权 | 退役，职能三分（§5） | ORIGIN_ROLE 删除；转写删除；组织权矩阵删行 |
| 8 | 谱系 generation：triple gen=1 挂 origin | triple gen=0，全树顺移（Q5——核查无逻辑消费） | 定义 + worker-cluster 注释 + 展示排序 |
| 9 | controller 可读 obs.* | 只读 observation-report + 注册面/配置面快照（Q2） | 工具面收口（capability 白名单剔除 obs.*） |

---

## 9. 不变量（明确不动）

- **观察策略 / 活动因子**：天然合规，一行不动（code 态 sensor 本来就是新定义的模范）；
- **审批面 A/B/C、人在回路**：不变且强化（controller 裁决权上移后，审批面是唯一生效闸）；
- **0.16.4 工具面收口**（actuator 族九类型）：不受影响——actuator 族内务；
- **W8 任务投递**（显式入口 / delegate·await / 事件回流）：不变（Origin 入口语义此前已被架空）；
- **时间尺度分离四环**（0.7.3）：不变，变化只是环内角色动作面收窄；
- **lease.generation**（任务租约代数，乐观并发控制）：与谱系无关，不受影响；
- **bench 装置**：定位更清晰——bench-report 是 `observation-report` 的合法数据源。

---

## 10. 影响面与迁移清单

| 面 | 内容 |
|---|---|
| 角色定义 | `builtin-roles.ts`：ORIGIN_ROLE 删除；triple 升 gen 0 + prompt 全改；新增 `produces` 字段 |
| 类型契约 | `WorkerRole.produces?: readonly string[]`（worker-cluster.ts）；谱系根注释改写 |
| 写边界 | `memory.write` 路径 kind 白名单校验（produces 非空且越界 → fail-fast） |
| 工具面 | controller 系剔除 obs.* + `manage.params.set`；实施类 manage.* 改 plan grant 校验 |
| 组织权 | W8 矩阵删 origin 行（推导函数 + 服务端校验） |
| 终态通知 | terminal reject 转写逻辑删除；events 路由外推（PTL/operator console 可见） |
| 记忆迁移 | 存量 `optimizer-suggestion` draft 标注迁移（一次性脚本/启动迁移） |
| 谱系展示 | routes-lineage / worker-index 支持多根森林；generation 顺移 |
| 校验器 | `scripts/check/check-role-conservation.ts` + lint 接入 + 钉死测试 |
| 文档 | `concepts.md` §0.7.1/§0.16.1 词条修订；N14/N16 等历史文档不改写、加沿革注记 |
| 测试 | agent-tool-convergence 六例更新；新增守恒/边界/终态通知钉死测试 |

---

## 11. 与其他设计的关系

| 设计 | 关系 |
|---|---|
| `execution-modes-and-tool-reg-v2-design.md` | WorkerKind 重新定位为 code role 壳的实现形态字段（§6.5）；观察策略 = code 态 sensor，天然合规 |
| `pth-bench-unified-design.md` | bench = 受控测量源：bench-report 作为 `observation-report` 数据源被 sensor 评估；测量策略可注册为 code worker 单元进 Worker Registry |
| N14（sensor/controller 四维细分） | 点位结构保留；「产物 optimizer-suggestion」语义按 §4.2 迁移 |
| N16（角色扩展） | 历史文档不改写，沿革注记指向本文 |
| W8（任务投递） | 组织权矩阵删 origin 行，其余不变 |

---

## 12. 当前概要设计（待补充）

> 占位：此处用于补充三源重构实施后的**当前概要设计**（面向现状的浓缩设计说明）。
> 可涵盖：三源森林实际结构、产物契约与 produces 边界、plan grant 实施链路、
> terminal reject 外推、守恒校验器与注册闸、以及 W4 迁移/文档收尾后的最终形态。
