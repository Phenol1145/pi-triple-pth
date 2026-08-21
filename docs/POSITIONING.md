# 仓库定位矩阵（三仓同源）

> 本文件是 pi-triple-deps / pi-triple-pth / pi-triple-ptl 三仓同源的定位文档。
> 任何定位或边界变更必须三仓同步修改，并同步各仓 README 的定位句。
>
> **本仓**：`pi-triple-pth`（容器内执行 / 任务宿主）。

## 1. 三仓定位

| 仓库 | 一句话定位 | 是 / 不是 |
|------|-----------|----------|
| `pi-triple-deps` | 公用 **npm 依赖层** | 是：`@away_from/shared`（跨产品协议/配置/session/program-manifest）与 `@away_from/infra`（平台/workspace/logger/model-router/sdk-adapter/container-runtime）的唯一发布源。不是：产品、不可独立部署、不含产品业务逻辑 |
| `pi-triple-pth` | **容器内执行**的任务宿主（Professional Task Host） | 是：PTH 运行时（`src/pth`）+ 唯一交互面（`pth` CLI / `@away_from/pth-console`）+ sandbox + 部署物（compose/Dockerfile/monitor）。不是：宿主机工具、不依赖 PTL 包 |
| `pi-triple-ptl` | **宿主机本地执行与运维**（PTL） | 是：`ptl` CLI（framework）、tmux 多环境、mailbox/dev-container 扩展、`ptl stack`（对 PTH 的容器运维）、`ptl program dev`（本地 pi 调试）。不是：PTH runtime 宿主、不内嵌 PTH 源码 |

## 2. 依赖与调用关系

```
pi-triple-deps（npm: @away_from/shared · @away_from/infra @^1.5.0）
        ▲                            ▲
        │ 依赖                        │ 依赖
pi-triple-ptl ──── pth CLI / HTTP API v1 ────▶ pi-triple-pth
（宿主机/本地执行）                          （容器内执行/任务宿主）

- PTL → PTH：零包依赖；只经 pth CLI / HTTP API v1
- PTH → PTL：禁止（无包依赖、无源码依赖）
```

## 3. 交互面归属

- PTH 唯一交互包：`@away_from/pth-console`（`pth` 命令族 + launcher + web console）。
- `ptl hub` 语法已退役（只保留迁移提示）：PTH 交互用 `pth …`；容器运维用 `ptl stack …`；本地 pi 调试用 `ptl program dev …`。
- PTL 安装/测试不得触发 PTH 源码下载。

## 4. 运维入口语义

- `pth up`（PTH 仓）：PTH 仓**自服务启动**——在 PTH 仓内拉起完整栈并验证。
- `ptl stack`（PTL 仓）：宿主机侧**外部运维入口**——读取 `deploy/pth.deployment.json` 契约对 PTH 部署做 build/up/status/logs/upgrade/exec。
- 部署事实源始终是 PTH 仓的 `deploy/`；PTL 仓持有契约副本用于外部运维。

## 5. 命名演进

- `PTL`（Pi-Triple-Lite）名称保持不变。
- `PTH`（Professional Task Host）为当前名称；**后续规划更名为 FRACTA 引擎**。
  届时代码/包名/命令品牌的迁移单独立项执行，本矩阵、README 与文档随迁更新；当前不做提前改名。

## 6. 变更纪律

1. 定位/边界变更先改本矩阵（三仓同源同步）；
2. 同步各仓 README 定位句与导航；
3. 涉及代码边界的，同步 `scripts/check-product-boundaries.ts` 与
   `docs/pth/module-ownership.md`（PTH 仓）/ `docs/ptl/architecture.md`（PTL 仓）；
4. 全量门禁回归后再合并。
