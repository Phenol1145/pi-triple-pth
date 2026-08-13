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

### 0.6 优化理论：控制理论 × 现代 JIT

> 第二个理论根基（2026-08-13 用户）——回答"系统怎么变好"。
> 心智负担理论回答"怎么便宜地干活"；优化理论回答"怎么让系统持续变便宜"。

#### 0.6.1 控制论映射：sensor → controller → actuator 反馈回路

经典负反馈回路 → PTH 角色分化：

| 控制论角色 | 职责 | PTH 落点 |
|---|---|---|
| **传感器（sensor）** | 测量系统状态 | sensor 族（worker-opt / system-opt / memory / resource）——obs.callpoint 上报 + scorecard 聚合快照 |
| **控制器（controller）** | 比较设定值与实测——计算控制量 | controller 族×5——裁决 official / reject / merge |
| **执行器（actuator）** | 控制量作用于系统 | actuator——把 official 提案落为实际修改（代码/参数/角色注册） |
| **设定值（setpoint）** | 期望状态 | 优化目标：步数↓ 失败率↓ 成本↓ 时间复用率↑ |
| **人在回路（supervisor）** | 防控制器失控 | 审批面 A/B/C——控制量不自动生效 |

**关键：负反馈而非开环**——每次调节后必观测复测（apply → verify 窗口）——偏差驱动调节，而非一次调好。

#### 0.6.2 现代 JIT 思想：按需优化 + 回退保护

现代 JIT（profiling → 热点识别 → 按需编译 → 失效回退）→ PTH 优化管线：

| JIT 概念 | PTH 落点 |
|---|---|
| profiling（画像） | scorecard 聚合快照（审批面 B——原子 upsert） |
| 热点识别（hotspot） | 反模式检测（repeated-fail / no-progress / gate-heavy / token-bloat） |
| 按需优化（不是全量预调） | 有观测证据才 propose——不预先调优 |
| 回退（deopt） | 劣化 50%+ 自动撤销（baseline 对比 + rolled_back 标记） |
| 版本化 | baseline 记于提案 meta——对比依据 |

**JIT 的精髓：优化是局部、证据驱动、可撤销的——与"全量预设计"相对。**

#### 0.6.3 多级优化循环（不同步长——时间尺度分离）

```
环 4 · 资源环（日/重启级）   resource-sensor → controller:resource → 资源调参（batch/核池/模型配比）
环 3 · 控制环（批次/小时级） sensor 聚合 → controller 裁决 → 审批面 → actuator 应用
环 2 · JIT 环（任务/分钟级）  optimizer-loop：collect → propose → apply → verify（+deopt）
环 1 · 防护环（单步/秒级）    agent-loop：负结果收敛 / 参数指纹 / 未知工具引导（执行内制动）
```

时间尺度分离原则（多环控制的核心）：**快环调微变（工具面/引导），慢环调大变（角色/资源）**——环间不互相干扰，防振荡。

#### 0.6.4 稳定性设计（控制论的贡献）

- **增益限制**：每窗口一个提案——调节幅度受限——不激进
- **复测验证**：apply 后 verify 窗口确认改善才保留——闭环负反馈
- **振荡防护**：deopt 50% 阈值 + rolled_back 标记——同一优化不反复尝试（防 ping-pong）
- **人在回路**：审批面 A/B/C——控制器不能无限自动
- **洞察污染防线**：观测断言与注册表核对——传感器测不准的拒绝入库

#### 0.6.5 理论 → 机制映射

| 理论 | 机制 |
|---|---|
| 控制论 | sensor/controller/actuator 分化 · 审批面 · 负反馈复测（verify 窗口） |
| JIT | scorecard 聚合画像 · 反模式热点 · 按需 propose · deopt 回退 · baseline 版本化 |
| 多级循环 | 4 环步长分层（防护/JIT/控制/资源）· 时间尺度分离 |

### 0.7 LLM 注意力特征（API 协议面）

> 第三个理论根基（2026-08-13 用户）——回答"上下文怎么编排才让模型真正专注"。
> 前两个理论回答"怎么拆"与"怎么变好"；本节回答"每一份上下文怎么用出最大专注度"。

#### 0.7.1 位置效应：核心区寸土寸金

completion 模式 API 调用结构：system prompt / tool definitions / 消息序列（user/assistant/tool）。

**LLM 注意力分布不均匀**：

```
高注意力：system prompt · tool definitions · 会话开头（任务指令）· 会话结尾（最新状态）
低注意力：会话中间（历史消息——lost in the middle）
```

**核心区（开头+结尾）寸土寸金**——每一个 token 都是最高杠杆：决定模型"知道自己是谁、能用什么、要干什么、现在到哪了"。

**让 LLM 专注 = 有效编排核心区信息**——无关内容不进核心区，历史沉在中间。

#### 0.7.2 缓存命中率约束（编排的第二个目标）

前缀缓存（prompt cache）：**前缀稳定才能命中**——编排核心区必须同时优化两个目标：

1. **专注度**：核心区只放高杠杆信息
2. **缓存命中率**：共享内容形成稳定前缀

**关键设计——顺序即策略**：共享块（世界观/角色文档/角色清单/能力文档）排在任务特定内容（任务标题）**之前**——同角色任务间前缀稳定→缓存命中（实测 cacheRead 82.6%）；任务特定内容沉在稳定前缀尾部。

**冲突与权衡**：
- 动态工具面（pick_tools）改工具列表→前缀变→缓存失效——**专注度与缓存的对抗**——v3 实验结论：模型自然不用时收益大于缓存损失（观察中）
- eager 注入（全文入前缀——缓存友好但 tokens↑）vs lazy 指针（省 tokens 但多一次查询）——按"内容稳定性×复用频率"选：高频稳定 eager、低频变动 lazy

#### 0.7.3 编排原则 → PTH 落点

| 原则 | PTH 机制 |
|---|---|
| 核心区只放高杠杆信息 | system prompt 编排顺序：世界观→角色文档→角色清单→能力文档→任务标题 |
| 工具面裁剪 = 专注 + tokens 双赢 | 工具白名单（三重交集）· pick_tools 动态裁剪 |
| 同样 tokens 更高密度 | description 场景语义化（三要素模板） |
| 开头精炼 | 渐进降输入（任务文本只写核心意图） |
| 高注意力位置注入关键引导 | 负结果 N=3 引导注入会话**结尾**（最新工具结果旁） |
| 低注意力区压缩损失最小 | context-compaction 压中间历史（位置效应直接应用） |
| 稳定前缀优先 | eager/lazy 渲染分层（高频稳定 eager / 低频 lazy） |

### 0.8 记忆理论：锚点-原文统一模型

> 第四个理论根基（2026-08-13 用户）——回答"信息怎么存储与供给才最省专注"。
> 与 0.7 的接口：锚点解决"核心区寸土寸金"与"知识完整性"的矛盾。

#### 0.8.1 统一模型：记忆 = 锚点 + 原文

**任何信息都可以拆成两级**：

| 级 | 定义 | 特征 |
|---|---|---|
| **锚点（anchor）** | "这是什么 / 何时该读原文"的描述 | 轻量（几十 tokens）——可入核心区 |
| **原文（original）** | 完整内容 | 重量（几千 tokens）——外置存储，按需拉取 |

**核心命题**：只要锚点把"什么时候该读原文"描述清楚——原始信息就不必展示给 LLM——只提供锚点，需要时展开。

**工具同理**：概括一套工具的整体作用（族锚点）→ 不加载原始工具列表 → 需要时逐级展开。

#### 0.8.2 锚点质量标准（"描述清楚何时读" = 三要素）

锚点质量决定模型能否**自行判断**"我现在需要它"——锚点三要素：

1. **触发条件**（场景锚点）——什么情况下该读
2. **内容预告**——读原文能获得什么
3. **成本预告**——读的成本（一次查询/展开）

→ 这正是工具 description 三要素模板（是什么/何时用/效果预告）的理论根源。

#### 0.8.3 逐级展开与层级深度权衡

- 两级展开：锚点 → 原文（memory.query 读 role-doc/洞察）
- 多级展开：工具族锚点 → 成员工具 → 参数（空间树层级）

**层级深度权衡**：每级消耗一次查询/决策——层数太多→查询成本吞掉收益——与 0.1 的协调成本边界同构（**锚点层级也是分摊粒度问题**）。

#### 0.8.4 与 0.7 的接口：锚点入核心区，原文入消息流

- 锚点稳定 → 前缀缓存友好；原文变动不影响前缀（查询结果落在消息流中部——低注意力区——损失小）
- 锚点轻量 → 核心区放得起；原文按需拉入
- **两理论合成：核心区放锚点，原文沉中间，结尾放最新——三层上下文经济学**

#### 0.8.5 PTH 落点（全部是锚点-原文实例）

| 理论元素 | PTH 机制 |
|---|---|
| 锚点 | index 工具族（memory.index / asp.index 顶层视图）· role-doc id · worker-index 清单 · description 三要素 |
| 原文 | memory_entries 全文 · 工具具体定义 |
| 展开时机 | description"何时用"· 五步工作流探索纪律（先查后试） |
| 逐级展开 | 能力文档分节裁剪（## 基础/## memory/## fs…）· 空间树层级 · 工具族→成员 |
| 锚点标准 | description 三要素模板（触发/预告/成本） |
| 实测 | memory-stats 13 步→2 步——asp.index 顶层锚点后精准切入（18 次盲查→0） |

### 0.9 空间导航理论（综合）

> 第五个理论根基（2026-08-13 用户）——前四节的综合，PTH 的总架构隐喻。

#### 0.9.1 双空间与索引基础

**动作空间**（所有能做的动作）+ **记忆空间**（所有记忆）——两者有良好的索引基础（0.8 锚点体系：asp.index / memory.index / capability-index / worker-index）——LLM 就能在双空间中**自由导航**。

#### 0.9.2 三个导航机制

1. **逐级展开结构**——空间是层级树：顶层概要 → 层级深入 → 具体条目（0.8 逐级展开）
2. **上下文-空间绑定**——LLM 在某空间时，上下文只装该空间内容（工具面 = 该空间动作；知识 = 该空间记忆）——**专注内容按空间分割**（0.7 核心区编排 + 0.1 专注度）
3. **返回简报**——返回上层时带简报（工作总结/洞察）——不是全文带回——空间切换 = 上下文重置

#### 0.9.3 推论：worker 类型分解成为自然行为

设置任务的**硬性分解规范**（子任务→不同 worker→不同空间）：
- **可控**——每步执行有明确边界
- **可见**——任务状态可查（状态机/scorecard）
- **易监督**——产物与简报明确（审批面依赖可判读的输出）

→ 0.1 的"思考量分摊"在空间导航下不是抽象分工，而是**具象的"每个 worker 在它的空间里导航"**。

#### 0.9.4 注意力稀释问题的解决

**主会话上下文单调递增**——注意力随时间被稀释（单上下文固有缺陷）。

空间导航的解法：**上下文有界化**——
- worker 上下文：任务结束即清零（无状态——新任务新空间）
- 任务内：空间切换重置工具面（pick_tools 空间切换重置）
- 主会话：渐进降输入（只留核心意图——细节沉入 PTH 内部空间）

**空间绑定把"无限增长"变成"空间内增长 + 切换重置"——专注度不随时间衰减。**

#### 0.9.5 理论综合图

```
0.1 心智负担（怎么便宜）┐
0.6 优化理论（怎么变好）┤
0.7 注意力特征（怎么编排）├─▶ 空间导航理论 ──▶ 6 域概念（§2 词表）──▶ 机制（代码）
0.8 记忆理论（怎么存供）┘        │
                                  ├─ 动作空间 → 域 C 空间与工具面
                                  ├─ 记忆空间 → 域 B 知识
                                  ├─ 分解规范 → 域 A 任务与角色
                                  ├─ 简报/监督 → 域 D 进化 + 域 F 协作
                                  └─ 有界上下文 → 域 E 执行防护
```

#### 0.9.6 PTH 落点

| 理论元素 | PTH 机制 |
|---|---|
| 动作空间索引 | asp.index 空间树顶层视图 · 三重交集工具面 |
| 记忆空间索引 | memory.index 顶层视图 · 各 kind 索引（role-doc/capability/worker-index） |
| 逐级展开 | 空间树层级 · 能力文档分节 · 工具族→成员 |
| 上下文-空间绑定 | ASP 模式（asp.cd 切换空间→工具面随之切换）· 白名单裁剪 |
| 返回简报 | 任务 done result summary · 洞察沉淀（task-insight）· 空间返回重置 |
| 硬性分解规范 | planner 计划格式（subtasks+dependsOn）· 任务正交路由 · worker 分化 |
| 注意力稀释防线 | worker 无状态上下文 · pick_tools 空间切换重置 · 主会话渐进降输入 |

### 0.10 交互核：动作空间分类与前后端分离

> 第六个理论根基（2026-08-13 用户）——worker 结构的动作空间维度。
> 交互核 = LLM 与计算机之间的交互层——负责执行 LLM 发出的指令并操作计算机。

#### 0.10.1 统一概念：生产核 + 探索核 → 交互核

之前的"生产核/探索核"是**使用场景**的区别（正式执行 vs 探索验证）——不是核的种类——**同一交互核既可用于生产也可用于探索**——统一为一个概念。

**PTC 范式**：ts 程序组合能力函数——一次执行完成多步逻辑——把多步逻辑从 LLM 轮次卸载到计算机（0.1 思考量分摊的极致：思考归模型，执行归计算机）。

#### 0.10.2 动作空间三分类（嵌套包含——不是并列）

```
③ 纯工具调用（基础工具支撑）⊂ ① 单语言核 ⊂ ② 多语言核
```

| 类型 | 定义 | 适用 |
|---|---|---|
| ③ 纯工具调用 | 无多步逻辑——tool call 序列（能力函数工具化——asp 工具族形态） | 只读规划/快速侦察——不需要写程序 |
| ① 单语言核 | 基础工具 + 一种语言组织方式（纯 ts PTC） | developer——专注单一执行模式 |
| ② 多语言核 | 多个单语言核的结合——**每种语言带职责定位** | origin/executor——全能 + A/B 验证 |

**多语言的"不完全包含"**：多语言 ≠ 语言简单并集——每种语言在 worker 里有职责定位（如 python 负责计算、bash 负责沙盒环境管理）——同时提供多种语言**组织方式**，各自服务不同交互意图。

**嵌套继承**：声明 python 核的 worker 自动获得基础工具面 + python 组织方式——无需重复声明。

#### 0.10.3 与 0.2 高低智力分层的咬合

| 交互核 × 推理档 × 模型 | 角色族 |
|---|---|
| ③ 纯工具 × low × flash | scout/memory-stats——最轻量（不写程序=最低心智负担） |
| ③ 纯工具 × high × pro | planner（写计划靠工具——不写代码） |
| ① 单核 ts × medium × flash/pro | developer——专注单一执行模式 |
| ② 多核 × high × pro | origin/executor/controller——A/B 验证与全栈能力 |

#### 0.10.4 前后端分离

**前端抽象**：模型按一个抽象交互核理解自己的交互对象——WorkerKernel 接口——类型①②③是前端授权面（决定 worker 被授权哪些交互通道）。

**后端实体**：分布式共享后端——sandbox 容器 kernel-host（"持久 kernel 宿主池"）——python/ts/bash 核同时处理所有 worker 的请求。

**状态隔离（多租户）**：exec-channel 双模式——stateless（每调用独立 kernel——vm context 新建）/ repl（sessionId 持久 context——变量/函数/声明保留 + idle TTL 回收）——每个 worker 的函数/变量互不泄漏。

**好处**：前端抽象稳定（worker 不感知后端拓扑——加核/换后端无感）· 后端池化（资源效率）· 隔离是安全边界。

#### 0.10.5 实现映射

| 理论元素 | 落点 |
|---|---|
| 交互核声明 | exploreKernels 字段（语义升级：探索核→交互核——含生产+探索） |
| 后端宿主 | sandbox/kernel-host.ts（SANDBOX_URL 通道 + 共享密钥） |
| 前后端通信 | kernel/exec-channel.ts（stateless/repl——"代码级执行唯一入口"） |
| 前端抽象 | interpreter/index.ts WorkerKernel · sandbox-kernel.ts（转发代理） |
| 模式切换 | PTH_PYTHON_MODE/PTH_BASH_MODE = sandbox-kernel（生产默认）\| kernel（本地调试） |

### 0.11 缓存机制（数据缓存——与 token 缓存区分）

> 第七个理论根基（2026-08-13 用户）——机械化处理大量数据的信息载体。

#### 0.11.1 两个缓存概念（严格区分）

| | token 缓存（prompt cache） | 数据缓存（cache 夹） |
|---|---|---|
| 是什么 | 请求前缀命中——省输入 token 成本 | 模型主动把信息读入的存储夹 |
| 场景 | 每轮 LLM 请求自动发生 | 机械化处理大量数据（读入→多步处理） |
| 指标 | cacheHitRate（cacheRead/(cacheRead+非缓存输入)——已实现） | cacheUtilization（读入后是否使用——待实现） |
| 理论坐标 | 0.7.2 | 本节 |

#### 0.11.2 数据缓存机制

AI 要机械化处理大量数据 → 读入缓存夹（load）→ 后续步骤反复取用（get）——**避免每步重复读取**（重复读取 = 重复 token + 重复注意力——0.1 专注度）。

**缓存利用率**：读入后是否使用读入数据——set/load → get 配对追踪（按 key + 字符量加权）——读入未用 = 浪费（读入成本已付）。

#### 0.11.3 现有实现与缺口

| 元素 | 落点 |
|---|---|
| 缓存夹本体 | cache-store.ts（随身缓存——元空间级状态——随 asp.cd 携带——与空间本地状态严格区分） |
| 容量约束 | 双上限（字符+条目）——load 超容拒绝 + cache.cancel 腾位——**背包约束**：迫使对信息价值做判断，防无限囤积 |
| 生命周期 | 任务级（任务结束随会话消亡——持久化走 memory.save） |
| ⚠️ 缺口 | **使用追踪缺失**——只有 set/load 无 get 计数——利用率不可算 |

#### 0.11.4 设计含义

1. cache-store 加使用追踪（key 级 loaded→used 配对）
2. scorecard 新增 cacheUtilization（与 cacheHitRate 命名严格区分）
3. sensor 观测新维度：**数据流效率**——低利用率=读入未用浪费信号——引导/JIT 优化缓存策略（0.6）

---

## 1. 系统定位（v2）

**PTH = 服务器端任务内核。**

```
任务池 → 角色路由 → worker 执行 → 产物提交 → 应用
                ↑                        ↑
           自我调节（控制论外环）    按需优化（JIT 内环）
```

一句话：**把工作正交分解给专职角色，每个角色在它的空间里以最小工具面闭环完成任务（空间导航），系统用多级闭环持续优化自己——所有自改变经过人工裁决闸门。**

理论→定位：§0.9 空间导航是执行隐喻；§0.6 多级闭环是演化隐喻；两者经"硬性分解规范"衔接。

---

## 2. 概念词表（v2——按理论坐标重构）

> 每个域标注理论坐标（§0 五节）与实现落点。术语统一：本表为唯一词表。

### 域 A：任务与角色（理论坐标：0.1 思考量分摊 · 0.9.3 硬性分解规范）

| 概念 | 定义 | 落点 |
|---|---|---|
| **任务（task）** | 最小工作单元：标题/文本/标签/路由/meta | routes-trigger |
| **任务上下文（task ctx）** | 任务的完整上下文载体（tag/route/meta/附加约束）——渐进降输入的接入口 | task payload |
| **任务状态机** | pending → claimed → completed / rejected（claim 回收重领——超时回收） | task-store-pg |
| **任务约束** | maxSteps / 超时——任务级执行上限 | agent-loop |
| **任务池** | 排队容器——claim 认领制 | task-store-pg |
| **路由（routing）** | 标签 → 角色匹配——任务正交路由 | task-resolver · role-router |
| **角色（worker type）** | 正交分工的执行者定义：id / tags / prompt / thinking / capabilities / actionTools / description / model | worker-cluster · default-roles |
| **worker** | 角色实例（进程循环：peek → claim → run）——无状态上下文（任务结束清零——0.9.4） | worker-cluster |
| **worker 生命周期** | fork 子进程 / 热上线广播 / 重启恢复（role-register 幂等） | worker-cluster · assembly |
| **batch** | worker 拓扑：角色×副本数（7×1 默认 / PTH_WORKER_ROLES 配比）——同角色单副本=串行 | batch-process |
| **谱系（lineage）** | 角色父子分化树（origin → 3 支 → n 级）——权威源=official proposal | routes-lineage |
| **分化（differentiation）** | 新角色从父角色派生——提案 → 裁决 → 注册 | worker-cluster |
| **worker-index** | 可用角色清单（注入规划系 + 记忆条目——路由/协作依据——0.8 锚点实例） | worker-cluster |

### 域 B：知识（理论坐标：0.8 锚点-原文 · 0.9.2 上下文-空间绑定）

| 概念 | 定义 | 落点 |
|---|---|---|
| **记忆（memory）** | PTH 共享知识层——SQL 表 `memory_entries`——**记忆空间**（0.9.1） | memory.ts |
| **记忆查询** | SQL（memory.query）——锚点→原文的展开通道 | memory.ts |
| **知识分层** | 条目 status：protected 受保护 / official 官方 / proposal 提案 / draft 草稿 | memory-policy |
| **可见性策略** | 谁可见什么（读侧分层——与 status 写侧对应） | memory-visibility |
| **role-doc** | 角色文档（人设/职责/任务类型/产物约定）——原文（锚点=id） | memory 条目 |
| **能力索引（capability-index）** | 能力函数清单——分节裁剪注入（## 基础/## memory/## fs/…） | prompt-docs |
| **worker-index** | 角色清单（域 A 的文档形态） | worker-cluster |
| **project-map** | 代码库结构地图 | gen-project-map |
| **索引（index 工具族）** | 空间顶层视图——锚点列表（memory.index/asp.index） | agent-tools |
| **洞察（insight）** | 可复用经验（task-insight / tool-function）——返回简报的沉淀形态 | memory |
| **聚合（aggregate）** | 数值型记忆原子累加（incrementAggregate——jsonb upsert 防 lost update） | memory-store-pg |
| **注入模式** | eager（全文入前缀——稳定高频）/ lazy（指针——0.8 锚点模式）/ auto | agent-loop |
| **污染防线** | 写入断言与注册表核对——矛盾拒写 | memory-policy |
| **归档（两种）** | ① 任务归档：产物存 artifacts 卷 ② 记忆归档：controller:memory 的整理（两个不同概念） | task-loop / controller |

### 域 C：空间与工具面（理论坐标：0.9.1 动作空间 · 0.7 核心区编排 · 0.8 工具锚点）

**概念澄清（v2 核心修正）："工具"是双层概念——**

| 层 | 定义 | 例 |
|---|---|---|
| **能力函数（PTC）** | ts 程序内可调用的函数——能力空间 | memory.query / fs.readSource / bash |
| **LLM 工具调用** | 模型函数调用协议里的 tool（带 JSON schema） | bash_run / asp.index / dev.write |
| **核（kernel）** | 执行后端——bash / python / ts / fs（工具族 toolFamily 的根基） | interpreter/ |

| 概念 | 定义 | 落点 |
|---|---|---|
| **动作空间** | 所有可做动作的集合——索引基础（0.9.1） | asp.index |
| **空间（space）** | 动作空间的分区容器——生命周期：创建 → 使用 → 持久化 → 恢复（或归档） | space-registry |
| **空间层级** | 空间树——逐级展开（根 → 空间 → 工具） | space-index |
| **上下文-空间绑定** | 切入空间 → 上下文只装该空间内容（工具面随之切换） | ASP 模式 |
| **工具面（actionTools）** | 角色可用 LLM 工具白名单 | agent-tools |
| **三重交集** | 声明（capabilities）∩ 空间面 ∩ 能力函数 = 实际可用面 | agent-tools |
| **最小工具面** | 目标驱动裁剪——目标-动作映射 | 动作面裁剪规则 |
| **pick_tools** | 元工具声明下一轮工具面（空间切换重置；空数组恢复默认） | agent-tools |
| **场景化描述** | 工具 description 三要素锚点：【场景锚点】/ 何时用 / 效果预告 | agent-tools |
| **别名表** | 直觉名 → 真实工具名映射 | agent-tools |
| **未知工具引导** | 回填别名/引导——不直接判失败 | agent-loop |
| **特殊空间** | write / dev（白名单语义特殊——write 族裁剪教训） | write-space |

### 域 D：进化（理论坐标：0.6 控制论×JIT · 0.9.3 易监督）

| 概念 | 定义 | 落点 |
|---|---|---|
| **scorecard** | 每任务计分卡（步数/tokens/失败率/cacheRead/timeReuse）——外环数据根基 | worker-scorecard |
| **scorecard 聚合快照** | 审批面 B——原子 upsert 聚合视图 | memory-store-pg |
| **观测（obs）** | sensor 上报通道（obs.callpoint / aggregate 优先） | obs.ts |
| **传感器（sensor）** | 观测者（worker-opt / system-opt / memory / resource） | default-roles |
| **控制器（controller）** | 裁决者×5（router / worker-opt / pth-opt / resource / memory）——official/reject/merge | default-roles |
| **执行器（actuator）** | 把 official 提案落为实际修改 | default-roles |
| **提案（proposal）** | 调节建议——draft → 裁决 → official；类型学：differentiation（角色）/ optimizer-suggestion（JIT）/ 资源方案 | optimizer-loop |
| **审批面（A/B/C）** | 人工闸门：A 代码层 / B scorecard 快照 / C 角色注册 | gateway · 监督层 |
| **控制论外环** | 慢环——sensor 聚合 → controller 裁决 → 审批面 → actuator 应用（批次/小时级） | optimizer-loop |
| **JIT 内环** | 快环——collect → propose → apply → verify（任务/分钟级） | optimizer-apply |
| **资源环（第三级）** | 更慢环——资源调参（batch/核池/模型配比——perf-autopilot） | controller:resource |
| **防护环（第零级）** | 单步制动——负结果收敛/参数指纹（秒级——域 E） | agent-loop |
| **deopt 回滚** | JIT 劣化 50%+ 自动撤销（baseline 对比 + rolled_back） | optimizer-apply |
| **时间复用率** | 1 − 关键路径任务数/总任务数——计划并行度 | worker-scorecard |
| **反模式（hotspot）** | repeated-fail / no-progress / gate-heavy / token-bloat——JIT 热点 | optimizer-loop |

### 域 E：执行防护（理论坐标：0.9.4 有界上下文 · 0.6 稳定性）

| 概念 | 定义 | 落点 |
|---|---|---|
| **五步工作流** | 理解 → 探索 → 执行 → 产物 → done（共享世界观） | PTH_WORKER_SYSTEM |
| **探索纪律** | 先查（memory → 能力 → 源码）后试 | 世界观 |
| **负结果收敛** | 同工具族+同目标连续负结果：N=3 引导 / N=5 终止（语义正则+路径模式化） | agent-loop |
| **参数指纹** | 连续相同动作检测（与负结果收敛并存互补） | agent-loop |
| **步数上限** | maxSteps 强制终止（负结果收敛之外的兜底） | agent-loop |
| **LLM 超时保护** | 调用级超时（防模型挂起循环冻结） | agent-loop |
| **上下文压缩** | context-compaction——压中间历史（0.7 位置效应） | context-compaction |
| **token 缓存** | prompt cache 命中链路（llm-fn → scorecard cacheRead——前缀稳定 0.7.2） | llm-fn |
| **claim 回收** | 认领超时回收重领（任务级防护） | task-store-pg |
| **引导注入位** | N=3 引导注入会话结尾（0.7 高注意力区） | agent-loop |

### 域 F：协作（理论坐标：0.9.3 简报/监督 · 0.9.4 主会话有界化）

| 概念 | 定义 | 落点 |
|---|---|---|
| **PTL↔PTH 桥（bridge）** | 程序提交通道（主会话 → PTH 的派发通道） | packages/framework |
| **任务派发（submit）** | pth-cli submit——异步模式（派发不阻塞） | scripts/pth-cli |
| **产物交付（artifacts）** | 产物归档到卷 → 宿主机提取（docker cp）——协作交付物 | task-loop archive |
| **hook（pth-notify）** | PTH 完成/失败 → POST → PTL 扩展 → 通知+会话消息注入（subagent 式唤醒） | task-loop · 扩展 |
| **扩展（ext）** | toolstore 插件——capability 注入（经 caps 白名单门控） | ext-registry |
| **扩展安全边界** | EXEC_TOOL_CAP 门控——ext 能力与执行核映射校验 | capability |
| **监督层（人）** | 审批面裁决者——协作主体（不在自动化环内） | 审批面 A/B/C |
| **异步模式** | 派发不阻塞主会话——推送唤醒 | pth-cli · hook |
| **渐进降输入** | 任务文本只写核心意图——上下文靠 PTH 内部状态自取 | 任务派发规范 |

---

## 3. 概念关系（v2）

```
【执行主干】
  任务 ──路由──▶ 角色 ──claim──▶ worker（batch 副本×N）──五步工作流──▶ 产物 ──提交──▶ 应用
   ▲                │                  │
   └─ worker-index  │                  ├─ system prompt：世界观→角色文档→角色清单→能力文档→任务标题
    (派发依据)       └─ 谱系分化        └─ 动作空间导航：asp.index → 切入空间 → 三重交集工具面

【演化主干】
  scorecard ──sensor 聚合──▶ 观测 ──controller 裁决──▶ 提案 ──审批面──▶ actuator 应用
      ▲                                                        │
      └──── deopt 回滚 ◀── 劣化 50%+ ◀── verify 复测 ◀──────────┘
  （第零环：agent-loop 防护 · 内环：JIT · 外环：控制论 · 第三环：资源）

【知识主干】
  记忆空间 ──锚点（index/worker-index/role-doc id）──▶ 按需展开（memory.query）──▶ 原文
  洞察 ──返回简报──▶ 沉淀（task-insight）──▶ 后续任务锚点

【协作主干】
  主会话 ──bridge──▶ 任务池 ──...──▶ 完成 ──hook──▶ 主会话（推送+注入）──▶ 用户裁决
```

---

## 4. 设计原则（v2——从理论推导）

1. **正交分工**（0.1 思考量分摊 + 0.9.3 分解规范）
2. **先查后试**（0.8 锚点-原文——探索纪律）
3. **锚点先行**（0.8——默认只提供锚点，原文按需展开；部署层 PTH_AGENT_MODE=lazy）
4. **最小信息原则**（0.1 专注度 + 0.7 核心区寸土寸金——工具面裁剪/描述密度/降输入）
5. **负反馈收敛**（0.6 稳定性——一切失控有制动：负结果收敛/参数指纹/deopt 回滚）
6. **人工裁决闸门**（0.6.1 人在回路——自修改不自动生效；可逆微调 JIT 自动+deopt 制动）
7. **数据驱动调节**（0.6 JIT——有观测证据才调节：scorecard/时间复用率/obs）
8. **异步协作**（0.9.4——任务循环不阻塞主会话——hook 推送唤醒）
9. **持久化优先**（0.9.2——空间/角色/洞察落库——重启恢复）
10. **权威谱系源**（official proposal 是谱系真相源——重启从它重建）
11. **时间尺度分离**（0.6.3——快环调微变、慢环调大变——环间不互相干扰）

---

## 5. 机制 ↔ 概念映射（近 20 提交）

| 提交 | 机制 | 主概念 | 理论/原则 |
|---|---|---|---|
| 9c1cfc1..49764c7.. | 概念设计 §0 理论五节 | 理论层 | 全部 |
| 673a019 | planner 模型升级 | 角色（智力分层） | 0.2 高低结合 |
| edf6b41 | worker-index | worker-index | 0.8 锚点 |
| 33fa4db | 负结果收敛 | 负结果收敛 | 0.6 稳定性 |
| dec057f | PTH→PTL hook | hook | 0.9.4 异步 |
| 1065316 | 污染防线/deopt/空间持久化 | 污染防线/deopt/空间生命周期 | 0.6/0.9.2 |
| ab5b45a | 时间复用率 | 时间复用率 | 0.6 JIT |
| fefb741 | description 场景化/别名表 | 场景化描述（0.8.2 锚点标准） | 0.8 |
| 19badd9 | pick_tools | pick_tools/三重交集 | 0.7/0.8 |
| a260170 | 审计修复批 | 三重交集/知识分层/扩展安全 | 0.6.1 |
| 9bb48cf | 审批面 B 聚合 | scorecard 聚合快照 | 0.6 JIT |
| 95a2d74 | 缓存链路 | token 缓存 | 0.7.2 |
| c234884 | 官方 proposal 重建/热上线 | 权威谱系源/worker 生命周期 | 0.9.2 |
| 更早 | 分层/审核/actuator/扩展生态 | — | — |

---

## 6. 概念 → 代码地图

| 概念 | 落点 |
|---|---|
| 任务池/状态机/claim | kernel/storage/task-store-pg.ts |
| 路由 | kernel/execution/task-resolver.ts · role-router.ts |
| 角色/谱系/batch/worker-index | kernel/execution/worker-cluster.ts · batch-process.ts（+ impls/roles/default-roles.ts） |
| 五步工作流/防护/注入编排 | kernel/execution/agent-loop.ts |
| 任务循环/提交/hook | kernel/execution/task-loop.ts（notifyTaskDone） |
| 记忆/分层/可见性/聚合 | kernel/extensions/memory.ts · memory-policy.ts · memory-visibility.ts · storage/memory-store-pg.ts |
| 能力索引/注入模式 | kernel/prompt-docs.ts · agent-loop.ts（buildAgentSystemPrompt） |
| 空间/工具面/场景化描述 | kernel/execution/space-registry.ts · space-index.ts · agent-tools.ts |
| 控制论外环/JIT/防护环 | kernel/execution/optimizer-loop.ts · optimizer-apply.ts · observability/ |
| 审批面 | gateway/routes-lineage.ts（C）+ optimizer-loop（B）+ 监督层（A） |
| 扩展/安全门控 | kernel/extensions/ext-registry.ts · interpreter/ext-capability.ts |
| 组装/恢复 | kernel/assembly.ts |
| PTL 桥 | packages/framework/src/bridge/ |
| 派发/异步 | scripts/pth-cli.ts |

---

## 7. 演进脉络

```
v0.9（动作面/权限/任务池纯化）
 → v0.10（体系自制闭环：控制论×JIT + 审批面 + 空间持久化）
 → 工具调用模式优化（pick_tools + 场景化描述 + 别名表）
 → 鲁棒性三项 · 双视角审计修复批 · 扩展生态（agent-reach）
 → 传感器行为分析 + controller 裁决（死循环机制）
 → 死循环落地 · hook · worker-index · planner 升级
 →【当前】理论五节（§0）→ 概念重构 v2（本文件）+ agentic 测试集（建设中）
```

---

## 8. 设计张力清单与概念债务

### 8.1 设计张力（自相矛盾检查——待用户裁决）

| # | 张力 | 双方 | 状态 |
|---|---|---|---|
| T1 | worker-index 全员注入 vs 专注度核心 | 执行类角色收到 22 行无关清单（0.7 核心区寸土寸金 vs 0.8 锚点） | ⚠️ 待裁决：改规划系注入+其他 lazy |
| T2 | 代码缺省 eager vs 锚点先行原则 | agent-loop 缺省 eager（部署层 compose 已 lazy——但无 compose 部署会 eager 全文） | ⚠️ 建议：缺省改 lazy |
| T3 | pick_tools 动态面 vs 缓存命中率 | 工具列表变→前缀变→缓存失效（0.7.2 已承认） | ⚠️ 需使用条件：何时值得牺牲缓存 |
| T4 | JIT 自动 apply vs 审批面人工闸门 | 0.6.1"控制量不自动生效"vs optimizer-apply 自动 | ⚠️ 待分层裁决：可逆微调自动+deopt / 不可逆大变人工 |
| T5 | 负结果收敛 N=5 终止 vs 合法多探测 | scout 侦察任务合法查多源——"同目标"路径归一可能误终止 | ⚠️ 需"同目标"判定边界 |
| T6 | 空间持久化 vs 空间治理 | 临时空间永久化→治理负担增长（治理 v2 的裁剪与持久化的张力） | ⚠️ 需空间生命周期（临时/持久/归档） |
| T7 | 记忆空间单调增长 vs 有界上下文 | 0.9.4 上下文有界，但记忆库无限增长 | ⚠️ controller:memory 归档未实装 |
| T8 | 能力文档格式 vs 描述三要素锚点标准 | 两套描述标准（清单式 vs 三要素锚点） | ⚠️ 统一到锚点标准 |
| T9 | 渐进降输入 vs 任务理解质量 | "最短指令"下界——核心意图必须完整到可分派 | 📌 边界条件（非矛盾） |
| T10 | 环间同对象仲裁 | JIT 环与控制环作用于同一角色/空间——无仲裁机制 | ⚠️ 低优先级 |

### 8.2 概念债务

- [ ] T1-T10 裁决后落地（部分需代码修改：T1/T2 简单——T3/T4/T5/T6 需设计）
- [ ] 术语统一：role-doc / 工具 description 旧术语向本词表对齐
- [ ] 工作流 SOP——角色特定标准作业步骤还不是一等概念
- [ ] 双 storage 层（pth/storage vs kernel/storage）归属待定
- [ ] agentic 测试集（建设中——planner 规划已产出——执行按计划）
