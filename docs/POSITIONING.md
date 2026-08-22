# 仓库定位矩阵（三仓同源）

> 本文件是 pi-triple-deps / pi-triple-pth / pi-triple-ptl 三仓同源的定位文档。
> 任何定位或边界变更必须三仓同步修改，并同步各仓 README 的定位句。
>
> **本仓**：`pi-triple-pth`（FRACTA engine；当前代码名 PTH）。

## 1. 三仓定位

| 仓库 | 一句话定位 | 是 / 不是 |
|------|-----------|----------|
| `pi-triple-deps` | 公用 **npm 依赖层** | 是：`@away_from/shared`（跨产品协议/配置/session/program-manifest，含 `execution/v1.1` 模式框架、`HttpExecutionBackend`、`ExecutionHttpServer`）与 `@away_from/infra` 的唯一发布源。不是：产品、不可独立部署、不含产品业务逻辑 |
| `pi-triple-pth` | **FRACTA engine**（下称 engine；当前代码名 PTH / Professional Task Host） | 是：engine 运行时（`src/pth`）——worker 实现与面向 LLM 的 interface 的唯一宿主；唯一交互面（`pth` CLI / `@away_from/pth-console`，含 `pth tools` / `pth services` / `pth local-exec` 命令族）；sandbox 执行面；**tool containers 与 jupyter 服务的部署事实源**（`deploy/tool-containers/`、`deploy/services/jupyter/`）；部署物（compose/Dockerfile/monitor）。不是：执行实现（工具链/沙箱进程在外部执行面）、宿主机原生工具、不依赖 PTL 包 |
| `pi-triple-ptl` | **宿主机本地开发工具带**（PTL） | 是：`ptl` CLI（framework）、tmux 会话/纸带（session/trace）、mailbox、`ptl program dev`、模板与配置。`ptl stack` 处于 **deprecated 兼容期**（容器生命周期已迁 `pth up`/`pth tools`/`pth services`）；TUI 产品形态已废弃（前端 = `pth web` operator console / JupyterLab）。不是：tool containers / jupyter 服务部署事实源（已迁 PTH 仓）、**本地执行器**（已迁 PTH：`pth local-exec` + `pth services` 进程监督器）、engine runtime 宿主、不内嵌 engine 源码；`packages/dev-container` 处于 **deprecated 兼容期**（一个版本后退役） |

## 2. 依赖与调用关系

```
pi-triple-deps（npm: @away_from/shared · @away_from/infra @^1.5.0）
        ▲                            ▲
        │ 协议/类型                   │ 协议/类型
pi-triple-ptl ──── pth CLI / HTTP API v1 ────▶ pi-triple-pth（engine）
（宿主机：运维 + 本地执行面）                    （worker 实现 + LLM interface）

执行面拓扑（协议客户端 = pth 产品面：engine + pth CLI）：
  engine ── execution/v1.1 ──▶ sandbox / tool containers / 本地执行器 / jupyter
  pth CLI ── execution/v1.1 ──▶ tool containers（仅 127.0.0.1 回环）

- PTL → engine：零包依赖；只经 pth CLI / HTTP API v1（调用）
- engine → PTL：禁止包依赖、禁止源码依赖；本地执行器由 **PTH 托管**（`pth local-exec` +
  `pth services` 进程监督器），PTL 只提供会话/纸带/本地程序调试
- tool containers / jupyter 部署事实源与生命周期管理均归 PTH 仓（`pth tools` / `pth services`）
```

## 3. 交互面归属

- engine 唯一交互包：`@away_from/pth-console`（`pth` 命令族 + launcher + web console）。
- `pth` 命令族扩展：`pth tools`（工具容器生命周期 + 协议调用）与 `pth services`
  （常驻服务，如 jupyter）由本仓实现；`docker exec` 仅保留为 `pth tools debug` 逃生舱。
- `ptl hub` 语法已退役；engine 交互用 `pth …`；容器运维用 `pth up`/`pth tools`/`pth services`（`ptl stack` deprecated）；本地执行器用 `pth local-exec`；本地 pi 调试用 `ptl program dev …`；`ptl tui` 已废弃（前端 = `pth web` / JupyterLab）。
- P6 已定稿待实现：`pth doctor` / `pth up --profile|--all` / `pth status --all` 成为统一运维入口（设计：`docs/pth/p6-pth-cli-runtime-profiles-design.md`）。
- PTL `/container` 命令族 deprecated：一个版本兼容期内转发到 `pth tools`，随后删除。
- PTL 安装/测试不得触发 engine 源码下载。

## 4. 运维入口语义

- `pth up`（PTH 仓）：engine 栈自服务启动（redis/postgres/pi-platform/sandbox）；P6 将扩展为 `--profile core|tools|lean4|u8|jupyter|full` 的统一编排入口（engine 最后起，保证 backend probe 全绿）。
- `pth tools`（PTH 仓）：tool containers 独立 compose 项目的生命周期与协议调用。
- `pth services`（PTH 仓）：宿主进程监督器（local-lean/local-u8）+ 常驻服务（jupyter）的统一生命周期管理；jupyter 北面内置终端的 `pth` 经宿主依赖树只读挂载透传（镜像不打包 pth）。
- `ptl stack`（PTL 仓）：deprecated 兼容期——容器生命周期统一由 `pth up`/`pth tools`/`pth services` 管理。
- 部署事实源始终是 PTH 仓的 `deploy/`；PTL 仓持有契约副本用于外部运维。

## 5. 执行面归属（FRACTA engine 拓扑）

约定：**platform = FRACTA engine（下称 engine）**。

- **engine 只负责两件事**：worker 实现（角色/循环/槽位/批处理）与面向 LLM 的 interface
  （role prompt、动作面、工具语义、`ExecutionRequest` 的构造与结果回收）。
- **所有执行面都是外部实现**：sandbox（v1）、tool containers（v1.1）、本地执行器（v1.1）、
  jupyter 服务（v1.1 南北两面）。每个执行面都实现 execution 服务端；协议客户端 =
  **pth 产品面（engine + pth CLI）**，pth CLI 仅经 127.0.0.1 回环访问 tool containers。
- **tool containers 四域**：compiled（运行时离线；engine + pth CLI）、network（可出网；
  engine 按角色 capability 白名单 + pth CLI）、secrets（凭据工具；仅 pth CLI，不 join
  engine 网络）、interactive（预留域；协议模式已定义，无实体容器）。常驻服务不进
  tool containers（服务生命周期 ≠ 工具 job 生命周期）。
- **jupyter 单容器双面**：北面 JupyterLab :8888（人 + pi-kernel provider；内置终端 `pth`
  经宿主只读挂载透传），南面 execution/v1.1（engine 经 registry 后端 `jupyter` 做无头
  notebook 执行）；一套安装、共享 workspaces/artifacts 卷。
- **网络以协议中心化，不改现状**：sandbox 保持 `sandbox-internal` egress 锁，engine 双网接入；
  dev/tool containers / 本地执行器经 default 网络（本地执行器 = `host.docker.internal`）；
  tool containers 对外仅动态回环端口。
- **专业工具链外置**：Lean 等工具链不放在 engine 容器；Lean 放本地执行器，经 execution 连接。
- **网关**：暂不引入统一网关；北向单入口 = engine `:3000`，南向执行面与 PG/Redis 数据面保持
  直连。引入北向网关的触发条件与硬约束见 `docs/fracta-engine-execution-topology.md` §7。
- **优先级**：先固定协议面，再做实现迁移。

## 6. 命名演进

- `PTL`（Pi-Triple-Lite）名称保持不变。
- `platform` 的产品语义已约定为 **FRACTA engine（engine）**；当前代码名仍为
  `PTH`（Professional Task Host），compose 服务名仍为 `pi-platform`。
- **tool containers（工具容器）** 取代 “dev 容器”：旧词 deprecated，文档与命令不得新增使用；
  域 id = `compiled` / `network` / `secrets` / `interactive`（预留）。
- 代码、包名、服务名、命令品牌的 FRACTA 重命名单独立项执行。

## 7. 变更纪律

1. 定位/边界变更先改本矩阵（三仓同源同步）；
2. 同步各仓 README 定位句与导航；
3. 涉及代码边界的，同步 `scripts/check-product-boundaries.ts` 与
   `docs/pth/module-ownership.md`（PTH 仓）/ `docs/ptl/architecture.md`（PTL 仓）；
4. 执行面协议变更同步 `docs/execution-surface-v1-design.md` 与
   `docs/fracta-engine-execution-topology.md`（三仓同源）及
   `docs/adr/0001-fracta-engine-external-execution-surfaces.md`、
   `docs/adr/0002-tool-containers-execution-v11.md`；
5. tool containers 镜像发布必须同步 `deploy/tool-containers/tool-manifest.json`（digest 钉版）；
6. 全量门禁回归后再合并。
