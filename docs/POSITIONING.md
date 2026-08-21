# 仓库定位矩阵（三仓同源）

> 本文件是 pi-triple-deps / pi-triple-pth / pi-triple-ptl 三仓同源的定位文档。
> 任何定位或边界变更必须三仓同步修改，并同步各仓 README 的定位句。
>
> **本仓**：`pi-triple-pth`（FRACTA engine；当前代码名 PTH）。

## 1. 三仓定位

| 仓库 | 一句话定位 | 是 / 不是 |
|------|-----------|----------|
| `pi-triple-deps` | 公用 **npm 依赖层** | 是：`@away_from/shared`（跨产品协议/配置/session/program-manifest，含 `execution/v1` 执行面协议）与 `@away_from/infra`（平台/workspace/logger/model-router/sdk-adapter/container-runtime）的唯一发布源。不是：产品、不可独立部署、不含产品业务逻辑 |
| `pi-triple-pth` | **FRACTA engine**（下称 engine；当前代码名 PTH / Professional Task Host） | 是：engine 运行时（`src/pth`）——worker 实现与面向 LLM 的 interface 的唯一宿主；唯一交互面（`pth` CLI / `@away_from/pth-console`）；sandbox 执行面与部署物（compose/Dockerfile/monitor）。不是：执行实现（工具链/沙箱进程在外部执行面）、宿主机工具、不依赖 PTL 包 |
| `pi-triple-ptl` | **宿主机本地执行与运维**（PTL） | 是：`ptl` CLI（framework）、tmux 多环境、mailbox/dev-container 扩展、`ptl stack`（对 engine 的容器运维）、`ptl program dev`（本地 pi 调试）、**本地执行器与 dev 容器执行面**（经 `execution/v1` 接入 engine）。不是：engine runtime 宿主、不内嵌 engine 源码 |

## 2. 依赖与调用关系

```
pi-triple-deps（npm: @away_from/shared · @away_from/infra @^1.5.0）
        ▲                            ▲
        │ 协议/类型                   │ 协议/类型
pi-triple-ptl ──── pth CLI / HTTP API v1 ────▶ pi-triple-pth（engine）
（宿主机：运维 + 本地/ dev 执行面）              （worker 实现 + LLM interface）

执行面拓扑（engine 为唯一协议客户端）：
  engine ── execution/v1 ──▶ sandbox 容器 / dev 容器 / 本地执行器

- PTL → engine：零包依赖；只经 pth CLI / HTTP API v1（调用）+ execution/v1（执行面服务端）
- engine → PTL：禁止包依赖、禁止源码依赖；仅允许 engine 以 execution/v1 HTTP 客户端
  调用 PTL 托管的 dev 容器 / 本地执行器（无 PTL 包下载）
```

## 3. 交互面归属

- engine 唯一交互包：`@away_from/pth-console`（`pth` 命令族 + launcher + web console）。
- `ptl hub` 语法已退役（只保留迁移提示）：engine 交互用 `pth …`；容器运维用 `ptl stack …`；本地 pi 调试用 `ptl program dev …`。
- PTL 安装/测试不得触发 engine 源码下载。

## 4. 运维入口语义

- `pth up`（PTH 仓）：PTH 仓**自服务启动**——在 PTH 仓内拉起完整栈并验证。
- `ptl stack`（PTL 仓）：宿主机侧**外部运维入口**——读取 `deploy/pth.deployment.json` 契约对 engine 部署做 build/up/status/logs/upgrade/exec。
- 部署事实源始终是 PTH 仓的 `deploy/`；PTL 仓持有契约副本用于外部运维。

## 5. 执行面归属（FRACTA engine 拓扑）

约定：**platform = FRACTA engine（下称 engine）**。

- **engine 只负责两件事**：worker 实现（角色/循环/槽位/批处理）与面向 LLM 的 interface
  （role prompt、动作面、工具语义、`ExecutionRequest` 的构造与结果回收）。
- **所有执行面都是外部实现**：sandbox 容器（`sandbox-untrusted`）、dev 容器（`dev-container`）、
  本地执行器（`host`）。每个执行面都实现 `execution/v1` 的服务端；engine 是唯一协议客户端。
- **网络以协议中心化，不改现状**：sandbox 保持 `sandbox-internal` egress 锁，engine 双网接入；
  dev 容器 / 本地执行器经 default 网络可达 engine（本地执行器 = `host.docker.internal`）。
- **专业工具链外置**：Lean 等工具链不放在 engine 容器；Lean 放本地执行器，
  经 `execution/v1` 与 engine 连接。
- **优先级**：先固定协议面，再做实现迁移。

## 6. 命名演进

- `PTL`（Pi-Triple-Lite）名称保持不变。
- `platform` 的产品语义已约定为 **FRACTA engine（engine）**；当前代码名仍为
  `PTH`（Professional Task Host），compose 服务名仍为 `pi-platform`。
- 本文档起文档术语统一使用 engine / FRACTA engine；代码、包名、服务名、命令品牌的
  重命名单独立项执行，本矩阵、README 与文档随迁更新。

## 7. 变更纪律

1. 定位/边界变更先改本矩阵（三仓同源同步）；
2. 同步各仓 README 定位句与导航；
3. 涉及代码边界的，同步 `scripts/check-product-boundaries.ts` 与
   `docs/pth/module-ownership.md`（PTH 仓）/ `docs/ptl/architecture.md`（PTL 仓）；
4. 执行面协议变更同步 `docs/execution-surface-v1-design.md` 与
   `docs/fracta-engine-execution-topology.md`（三仓同源）及 `docs/adr/0001-fracta-engine-external-execution-surfaces.md`；
5. 全量门禁回归后再合并。
