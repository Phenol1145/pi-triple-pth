# FRACTA engine

pi-triple-pth 仓库的领域术语表：engine 运行时上下文。边界归属见 `docs/POSITIONING.md`；架构决策见 `docs/adr/`。

## Language

**engine（FRACTA engine）**:
产品运行时本体——唯一拥有 worker 实现与面向 LLM 的 interface；只构造 `ExecutionRequest` 并回收 `ExecutionResult`，自身永不实现执行。
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

**taxonomy differentiation（任务类型分化）**:
类型体系演化的治理回路：controller:router 提出类型分化方案（modification-plan draft）→ 监督批准 → actuator 实施注册进 tag-registry——此后新类型由 routing 确定性分派。
_Avoid_: 角色自主即时创建类型、LLM 逐任务自由分类

**baseline window（基线窗）**:
A/B 优化周期的对照基准：n 轮行为数据为基线，变更生效后以 n+1~2n 轮为实验窗，比较两窗裁决 keep/rollback。
_Avoid_: 无基线的即时调参、凭单点观测裁决

**TCE**:
Tool → Code → Execute 三层（ADR-0004）：一切入口归一化为一段代码；Code 层 = 归一化 + 静态审核（能力调用集 ⊆ role 能力集）；Execute 层 = 代码到执行面的路由。PTC 能力接口第一性，tool-call 是适配投影。
_Avoid_: Command 对象（命令对象形态已退役）、Tool→Command→Execute（旧释义）

**PTC 宿主语言**:
可承载 PTC 程序模式的语言，门槛 = 交互性三条件：持久会话 / 可注入（授权即注入）/ 可静态审核。ts、python、bash 是宿主语言；非交互执行面（C/asm 编译、文档生产）包装为能力被宿主语言调用。
_Avoid_: 把 dev/write 当独立语言空间（它们是能力，不是宿主）

**agentic JIT（工作模式）**:
含有 JIT 环参与的工作模式——任务执行的同时把反复出现的模式固化为持久工具（规则固化、skill、角色分化），后续同类任务由固化产物代偿；智力代偿阶梯第三级，与工具调用（单步代偿）、PTC 程序模式（临时工具，任务结束即弃）并列。现状产物是提示侧串联代偿；并联代偿（固化产物旁路 LLM 直接接管同类任务）待议。
_Avoid_: 经典 JIT（优化目标不是"同样行为更快"，而是重构分工）；optimizer-loop / JIT 内环（它是该模式的实现机制，不等于模式本身）；Agent-JIT 路径 B、A4 护栏 JIT（机制/产物名，不指工作模式）；旧拼写 agentic-JIT（文档遗留）
