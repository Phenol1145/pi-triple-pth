# FRACTA engine

pi-triple-pth 仓库的领域术语表：engine 运行时上下文。边界归属见 `docs/POSITIONING.md`；架构决策见 `docs/adr/`。

## Language

**engine（FRACTA engine）**:
产品运行时本体——唯一拥有 worker 实现与面向 LLM 的 interface；只构造 `ExecutionRequest` 并回收 `ExecutionResult`，自身永不实现执行。
_Avoid_: platform（compose 服务名 `pi-platform` 是迁移前的代码名，文档里不用 platform 指产品）、PTH（当前代码名，品牌迁移后废弃）

**worker**:
engine 内按角色实例化的执行单元（role × replica），跑任务循环、消费任务、产出 outcome。
_Avoid_: agent 实例、进程（batch 子进程是 worker 的宿主，不是 worker 本身）

**LLM interface**:
engine 面向模型暴露的语义面——role prompt、动作空间、工具语义与执行请求的构造；执行细节对 LLM 不可见。
_Avoid_: 工具层、动作层（它们是 LLM interface 的组成部分，不等于整体）

**execution surface（执行面）**:
实现 `execution/v1` 服务端的外部进程/容器——sandbox 容器（`sandbox-untrusted`）、dev 容器（`dev-container`）、本地执行器（`host`）。
_Avoid_: 后端（多义，可指任意服务）

**execution backend**:
engine 视角下的某个执行面：由 `ExecutionBackendDescriptor`（id/url/profile/tokenEnv/pathMapping）注册，前端是 `ExecutionBackend` 接口。
_Avoid_: adapter（professional runtime adapter 是 engine 内部构造请求的层，不是协议对端）

**protocol surface（协议面）**:
`@away_from/shared/execution` 里冻结的 wire 契约——路径、事件、错误码、类型与校验；任何执行面不得复制或扩写。
_Avoid_: API、接口面

**local executor（本地执行器）**:
宿主机上的执行面，profile=`host`，支持 pathMapping；首期承载 Lean 工具链，经 `host.docker.internal` 被 engine 访问。
_Avoid_: 本地后端（LocalBackend 只是其进程内实现件）
