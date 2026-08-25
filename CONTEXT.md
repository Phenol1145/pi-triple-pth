# FRACTA engine

pi-triple-pth 仓库的领域术语表：engine 运行时上下文。边界归属见 `docs/POSITIONING.md`；架构决策见 `docs/adr/`。

## Language

**engine（FRACTA engine）**:
产品运行时本体——唯一拥有 worker 实现与面向 LLM 的 interface；可以承载无环境副作用的 PTC 编排运行时，但网络、外部进程、凭据和其他外部副作用必须经 typed proxy / `ExecutionRequest` 交给 Execute 执行面，engine 不实现这些基础服务。
_Avoid_: platform（compose 服务名 `pi-platform` 是迁移前的代码名，文档里不用 platform 指产品）、PTH（当前代码名，品牌迁移后废弃）

**worker**:
engine 内按角色实例化的执行单元（role × replica），跑任务循环、消费任务、产出 outcome。
_Avoid_: agent 实例、进程（batch 子进程是 worker 的宿主，不是 worker 本身）

**role-definition/v1**:
Role = 类声明：`catalog/data/roles/<id>.json` 的角色定义文件协议。`version` 单调递增（编辑带
baseVersion 乐观并发）；`generation` 由 parent/composedFrom 派生；revision = 内容哈希供 worker 绑定。
_Avoid_: 把角色写死在源码、把 version/generation 混用

**worker-spec/v1**:
Worker = 对象的实例化参数：`catalog/data/workers.json`（副本数、roleRevision pin、drain 策略）。
运行时投影为 WorkerReplica/WorkerSlot。
_Avoid_: 直接用 PTH_WORKER_ROLES 作为主源（仅 bootstrap 覆盖保留）

**drain-swap**:
role 新 revision 的生效语义：旧 worker 暂停认领 → 新 revision worker 接管 → 旧 worker 跑完在飞任务后退役；失败回滚。保证任何任务全程只由一个 worker 且绑定唯一 role revision。
_Avoid_: 热更新时直接杀旧 worker、修改后强制重启整个 engine

**mutation tiers（可改性分层）**:
T0 不可修改（协议/内核/安全机制，release-only）/ T1 声明式可变（catalog/data，GitOps 热应用）/ T2 配置可变（env/config）。
_Avoid_: 把 T1 数据硬编码进 T0 源码

**LLM interface**:
engine 面向模型暴露的语义面——role prompt、动作空间、工具语义与执行请求的构造；执行细节对 LLM 不可见。
_Avoid_: 工具层、动作层（它们是 LLM interface 的组成部分，不等于整体）

**execution surface（执行面）**:
实现 execution 服务端（v1 或 v1.1）的外部进程/容器——sandbox 容器（`sandbox-untrusted`，v1）、tool containers（compiled/network/secrets）、本地执行器（`host`）、jupyter 服务（双面）。
_Avoid_: 后端（多义，可指任意服务）

**tool containers（工具容器）**:
只承载命令行工具（job 生命周期，含 TTY）的容器域；取代“dev 容器”。域：`compiled`（运行时离线）、`network`（可出网）、`secrets`（凭据工具，仅宿主）、`interactive`（预留）。常驻服务不进 tool containers。
_Avoid_: dev 容器（deprecated）

**pth tools / pth services**:
`pth` 命令族的两个子命令面：`pth tools` 管理 tool containers（生命周期 + 协议调用 + debug 逃生舱）；`pth services` 管理常驻服务（jupyter）。
_Avoid_: /container（PTL 旧命令，兼容期后删除）、docker exec（仅 debug 通道）

**invocation mode（调用模式）**:
execution/v1.1 的模式框架：`sync` / `stream` / `interactive`（WS stdin/pty/resize）/ `persistent`（规范定稿、实现后置）。每个后端经 capabilities `modes` 位图声明支持范围，未声明模式 → `MODE_NOT_SUPPORTED`。
_Avoid_: 把交互/常驻能力写成零散布尔字段

**jupyter service（jupyter 服务）**:
单容器双面的常驻服务：北面 JupyterLab :8888（人 + 内置终端 + P5 kernel provider），南面 execution/v1.1（engine 经 registry 后端 `jupyter` 无头执行 notebook）；一套 jupyter 安装。
_Avoid_: 双 jupyter 容器、docker exec 进 jupyter

**execution backend**:
engine 视角下的某个执行面：由 `ExecutionBackendDescriptor`（id/url/profile/tokenEnv/pathMapping）注册，前端是 `ExecutionBackend` 接口。
_Avoid_: adapter（professional runtime adapter 是 engine 内部构造请求的层，不是协议对端）

**protocol surface（协议面）**:
`@away_from/shared/execution` 里冻结的 wire 契约——路径、事件、错误码、类型与校验；任何执行面不得复制或扩写。
_Avoid_: API、接口面

**local executor（本地执行器）**:
宿主机上的执行面，profile=`host`，支持 pathMapping；按 v1.1 实现，首期承载 Lean 工具链，经 `host.docker.internal` 被 engine 访问。
_Avoid_: 本地后端（LocalBackend 只是其进程内实现件）

**role（角色）**:
四元组 = 身份 + 能力 + 资源 + 模块。身份 = 它是谁（prompt、tags、谱系位置）；能力 = 可使用的工具连同工具内部权限；资源 = 定量配额（模型、推理深度、tokens、时间、step 数）；模块 = 能力的封装集合。
_Avoid_: 把角色等同于 prompt、标签或权限白名单

**capability（能力）**:
role 可使用的单个工具连同其工具内部权限（如 fs 可用但只读、tasks 可用但不可 penetrate）。
_Avoid_: 裸工具名字符串（丢失工具内部权限维度）

**module（模块）**:
一组能力的封装集合，可整体挂接到 role 或卸载，自带内部权限与配额（如 memory 模块、cache 模块）；系统无某模块也可运作——模块是挂接不是内核。
_Avoid_: 内置子系统、内核功能

**routing（任务路由）**:
kernel 层的确定性逐任务分派（tag-registry 精确匹配 / flow 显式角色），不经过任何 role。
_Avoid_: 把类型判断、分流决策放进路由层

**entry task submission（入口任务提交）**:
外部 Agent 应用将用户真实需求澄清、冻结并编译成的自包含 engine 入口请求；它描述根目标、范围、约束与验收，不预写 engine 内部任务图。
_Avoid_: 原始 User Request、worker 内部 child delegation、把外部应用称为 engine 调度器

**durable child delegation（持久化子任务委派）**:
RoleRun Code 在 engine 授权目标集合内声明直接子任务的唯一任务创建语义；engine 以父作用域稳定 key 幂等持久化 child 与 required dependency，并通过有界 outcome envelope 回流结果。
_Avoid_: 通用 `tasks.submit`、fire-and-forget enqueue、list/claim/retry/lease 等任务管理权、跨 RoleRun 内存 Promise

**dependency waiting（依赖等待）**:
父任务存在未终结 required child 时的持久、不可认领状态；PG dependency 是真相源，事件只负责低延迟提示，恢复扫描保证最终唤醒。
_Avoid_: 把等待父任务立即放回 pending 忙认领、让 worker 持有 lease 等待、用进程内事件代替持久状态

**taxonomy differentiation（任务类型分化）**:
类型体系演化的治理回路：controller:router 提出类型分化方案（modification-plan draft）→ 监督批准 → actuator 实施注册进 tag-registry——此后新类型由 routing 确定性分派。
_Avoid_: 角色自主即时创建类型、LLM 逐任务自由分类

**baseline window（基线窗）**:
A/B 优化周期的对照基准：n 轮行为数据为基线，变更生效后以 n+1~2n 轮为实验窗，比较两窗裁决 keep/rollback。
_Avoid_: 无基线的即时调参、凭单点观测裁决

**TCE**:
Tool → Code → Execute 三层（ADR-0004）：一切入口归一化为一段代码；Code 层 = 归一化 + 静态审核（能力调用集 ⊆ role 能力集）；Execute 层 = 代码到执行面的路由。PTC 能力接口第一性，tool-call 是适配投影。
_Avoid_: Command 对象（命令对象形态已退役）、Tool→Command→Execute（旧释义）

**PTC orchestration runtime（PTC 编排运行时）**:
位于 engine 内的无环境副作用 Code runtime；负责 PTC 状态、控制流、静态审核和已授权 typed proxy。`kernel-ts` 是当前实现。网络 I/O、任意进程、provider 凭据和 artifact 副作用不归它所有。
_Avoid_: 把 `kernel-ts` 称为网络后端；为了迁移基础服务而默认把整个 PTC runtime 迁出 engine

**network primitive（网络原语）**:
一次有界、typed、provider-neutral 的 `search` / `fetch` / `extract` 操作。复杂检索由 Code 组合这些原语形成，Execute 不提供隐藏的 `deepSearch` 黑盒。
_Avoid_: 把研究计划、来源信任或长报告生成塞入单个网络能力

**network operation profile（网络操作档）**:
服务端冻结的一组 egress、来源、预算、能力和 retention 约束；V1 启用 `search-public`，`research-public` 只预留边界。`intake-authorized` 仅是 Intake 内部 trace 分类，授权仍来自已验签 Trust Policy/Subscription/Run。profile 由任务、role grant 与 policy 决定，不接受 LLM 自报。
_Avoid_: 把 profile 当 role、全局 trust 标记、provider 配置或 Intake admission 决定

**discovery provider / publisher source / processing intermediary**:
网络信息处理链中的三个独立身份：provider 发现候选链接，publisher 实际发布内容，intermediary 负责抓取、渲染、解析或格式转换。三者必须分别留痕，搜索排名和处理中介都不授予 publisher 信任。
_Avoid_: 用单个 `source` 字段混合搜索引擎、目标站点与 Jina/Firecrawl 等处理服务

**language-capability catalog（语言—能力目录）**:
由 OrchestrationSurface、CapabilityDefinition、CapabilityImplementation、ExecutionTarget/ExecuteService 与 role grant 共同派生的只读快照；按语言和按能力的索引是同一快照的两个投影。
_Avoid_: 两套手写索引、把实现语言或 notebook 语言等同为 PTC 编排宿主、用 `run/eval` 代替能力发现

**PTC 宿主语言**:
可承载 PTC 程序模式的编排语言，门槛 = 持久会话 / 可注入（授权即注入）/ 可静态审核。当前生产实现只有 ts；python/bash 目前是由 ts PTC proxy 调用的 execution language。ADR-0004 中 python/bash 成为宿主是目标态，须在各自具备三条件后才成立。
_Avoid_: 把 NotebookLanguage、实现语言、dev/write 能力或 `run/eval` 逃生舱直接称为已落地 PTC 宿主

**execution language（执行语言）**:
由 ExecutionTarget 执行的程序语言；当前包括 ts/python/bash。它描述代码送往哪个语言运行时，不自动表示该语言拥有 PTC 注入、静态审核或领域能力目录。
_Avoid_: 仅因 executor matrix 支持某语言，就宣称它是 orchestration host

**implementation language（实现语言）**:
某个 capability implementation 内部采用的开发/运行语言，例如 Python extractor 或 TS network adapter；对 LLM 的能力语义与 role 授权没有直接影响。
_Avoid_: 用实现语言决定 capability identity，或把实现细节暴露成任意命令面

**Execute service target（Execute 服务目标）**:
承载 typed operation 的 Execute-owned 服务/端口，例如 network gateway 或 extractor；它不是现有面向 notebook 的 `ExecutionTargetDefinition`。能力实现通过判别式 binding 引用 Execute service 或既有 ExecutionTarget。
_Avoid_: 把 network broker 伪装成支持 bash/ts 的 notebook target

**agentic JIT（工作模式）**:
含有 JIT 环参与的工作模式——任务执行的同时把反复出现的模式固化为持久工具（规则固化、skill、角色分化），后续同类任务由固化产物代偿；智力代偿阶梯第三级，与工具调用（单步代偿）、PTC 程序模式（临时工具，任务结束即弃）并列。现状产物是提示侧串联代偿；并联代偿（固化产物旁路 LLM 直接接管同类任务）待议。
_Avoid_: 经典 JIT（优化目标不是"同样行为更快"，而是重构分工）；optimizer-loop / JIT 内环（它是该模式的实现机制，不等于模式本身）；Agent-JIT 路径 B、A4 护栏 JIT（机制/产物名，不指工作模式）；旧拼写 agentic-JIT（文档遗留）
