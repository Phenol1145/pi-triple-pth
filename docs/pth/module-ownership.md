# 模块归属与产品边界（PTL / PTH）

> 依据：`docs/fracta-engine-execution-topology.md`（三仓同步的执行拓扑基线）与各仓 README。
> 本文件回答“哪个目录属于哪个产品、允许怎么 import”，由各仓 `scripts/check-product-boundaries.ts` 机械校验。
> v1.5 拆仓后：PTL 代码在 `pi-triple-ptl`，PTH 代码在本仓，公共能力在 `pi-triple-deps`。

## 1. 产品归属

### PTL（pi 环境管理工具——pi-triple-ptl 仓）
- `packages/framework/src/cli/**`
- `packages/framework/src/commands/**`
- `packages/framework/src/containers/**`
- `packages/framework/src/program-dev/**`（ptl program dev——本地 agent 程序调试）
- `packages/framework/src/stack/**`（ptl stack——容器运维命令族）
- `packages/framework/src/session/**`（PTL tmux session 管理）
- `packages/framework/src/tui-*/**`（TUI，产品形态已定为废弃，保留只读兼容）
- 顶层 PTL 入口/工具：`env.ts`、`extension-copy.ts`、`launcher.ts`、`migrate.ts`、`pit.ts`、`shared-layer.ts`
- `packages/mailbox/src/**`、`packages/dev-container/src/**`（PTL 扩展包）
- 公共能力（非产品专属，pi-triple-deps 仓）：`@away_from/shared`、`@away_from/infra`

### PTH（Agent 协作与自优化系统——本仓）
- `src/pth/**`
- `packages/pth-memory/src/**`
- `packages/pth-sandbox/src/**`
- `packages/pth-console/src/**`（PTH client/protocol/pack + pth CLI 命令 + 人类操作台）

## 2. Import 规则

| 方向 | 规则 |
|---|---|
| PTH core → PTL-only | **禁止**（PTH 不依赖 PTL 环境管理） |
| PTL-only → PTH core | **禁止**（跨产品交互只经 `pth` CLI / HTTP API v1，不 import PTH 包） |
| 过渡区 client/protocol/operator-console → PTH core | 允许（B2/B3 搬迁后按观察清单保留） |
| 任何产品 → `@away_from/shared` / `@away_from/infra` | 允许 |
| 跨包内部深路径 | 仍遵守既有 `check-pth-boundaries`（公共 barrel 规则） |

## 3. 当前过渡状态

- Phase 0 完成：原 `ptl hub` 的 PTH 交互命令迁入 `packages/pth-console/src/commands/`（`pth` CLI 承接）；PTL 本地能力落位 `framework/src/program-dev/` 与 `framework/src/stack/`；framework 不再依赖 `@away_from/pth-console`。
- 产品边界检查器仍把 `packages/pth-console/src/bridge/**`、`operator-console/**` 标记为 `transitional` 观察清单，迁移收尾后可移除。
- 过渡区数量、文件清单在 `check-product-boundaries.ts` 输出中显示，便于迁移进度追踪。

## 4. 变更纪律

- 新增 PTL-only 或 PTH core 模块时，必须在 `check-product-boundaries.ts` 的归属集合中登记；
- 任何新的 PTL→PTH 直接依赖必须先经过本文件评审并记录过渡区；
- 违反者由 lint 阶段 `check:product-boundaries` 与 `test/pth-architecture/product-boundaries.test.ts` 双重拦截。
