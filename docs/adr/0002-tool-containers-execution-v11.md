# ADR-0002: tool containers 重定位与 execution/v1.1 模式框架

**Status**: accepted

**Context**：“dev 容器”语义已经漂移（PTL 工具容器、jupyter 前端、宿主机 wrapper 混在一处），且 execution/v1 只覆盖单向命令执行，无法承载 TTY 交互与有状态内核。2026-08-21 裁决：把这类容器重定位为 **tool containers（工具容器）**，并把 execution 升级为**模式框架**。

## Decisions

1. **tool containers 取代 dev 容器**。域划分：`compiled`（运行时离线）/ `network`（可出网）/
   `secrets`（凭据工具，仅宿主）/ `interactive`（预留）。只承载命令行工具（job 生命周期）；
   常驻服务不进 tool containers。
2. **跨机器迁移 = GHCR 多架构镜像（linux/arm64+amd64）+ `tool-manifest.json` digest 钉版**；
   不做 macOS/Windows 原生产物线，Mach-O 工具留宿主。
3. **部署事实源与生命周期归 PTH 仓**：`deploy/tool-containers/`、`deploy/services/jupyter/`，
   由 `pth tools` / `pth services` 统一管理；PTL `packages/dev-container` 与 `/container`
   一个版本兼容期后退役；宿主机调用走协议（127.0.0.1 动态端口 + 本地注册表），
   `docker exec` 仅保留为 debug 逃生舱。
4. **execution/v1.1 = 模式框架**：`mode = sync | stream | interactive | persistent(预留)`；
   本轮实现前三者（interactive = WS `/exec/:id/ws` 承载 stdin/pty/resize）；
   **persistent 完整 wire 规范本轮定稿、实现后置**，与 sandbox kernel-host 迁移捆绑；
   协议服务端唯一实现 = `@away_from/shared/execution` 的 `ExecutionHttpServer`。
   capabilities 声明 `modes` 位图；请求未声明模式 → `MODE_NOT_SUPPORTED`；
   v1.0 客户端遇 v1.1 fail-closed。
5. **协议客户端 = pth 产品面（engine + pth CLI）**；pth CLI 仅 127.0.0.1 回环访问
   tool containers；浏览器/Jupyter 仍只经 engine。
6. **principal 边界**：HOST_TOKEN / ENGINE_TOKEN；secrets 域不发 ENGINE_TOKEN、不 join
   engine 网络；角色→工具授权全部在 engine 内完成（role capabilities，network 域默认关闭），
   后端对持有效 ENGINE_TOKEN 的 engine 请求视为可信。
7. **jupyter 单容器双面**：一套 jupyter 安装；北面 JupyterLab :8888（人 + 内置终端 +
   P5 kernel provider），南面 execution/v1.1（engine 经 registry 后端 `jupyter` 无头执行
   notebook）；`jupyter-runtime-adapter` 瘦身为薄客户端。
8. **前端分工**：operator console 保留（运维）；JupyterLab 只承担终端与 notebook 交互
   （P5）；未来最多加 1–2 个薄插件，不整体重做控制台。

## Why

- “不同 OS 重复编译”的痛点用多架构 OCI 镜像一次 build、digest 钉版解决，而不是多套原生产物线。
- 交互核有状态：persistent 模式必须成为一等协议模式，否则状态要么退回 engine，要么继续藏在
  kernel-host 私有 lease API 里；规范先定、实现后置，避免本轮范围爆炸。
- 一个后端一套模式能力声明（capabilities），让 sandbox 继续 v1、tool containers/本地执行器
  用 v1.1，升级不强制大爆炸。

## Consequences

- `@away_from/shared` 下次发布合并 P0 descriptor 与 v1.1 模式框架（一次发布，避免空窗）。
- P1 registry 增加 v1/v1.1 能力协商；P2 本地执行器按 v1.1 实现。
- 后续轮次：persistent 实现 + sandbox kernel-host 迁移；engine 的 interactive 消费待真实
  场景出现再设计 agent 驱动 TTY 语义。
- 旧 `~/pi-platform/docker-compose.yaml` 路径引用（agent-reach wrapper、dev-container 包）
  在工具容器迁移轮一并修正。
