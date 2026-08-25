# 模块归属与产品边界（PTL / PTH）

> 依据：`docs/fracta-engine-execution-topology.md`（三仓同步的执行拓扑基线）与各仓 README。
> 本文件回答“哪个目录属于哪个产品、允许怎么 import”，由各仓 `scripts/check/check-product-boundaries.ts` 机械校验。
> v1.5 拆仓后：PTL 代码在 `pi-triple-ptl`，PTH 代码在本仓，公共能力在 `pi-triple-deps`。

## 1. 产品归属

### PTL（pi 环境管理工具——pi-triple-ptl 仓）
- `packages/framework/**`、`packages/mailbox/**`、`packages/dev-container/**`
- 顶层 PTL 入口/工具：`env.ts`、`extension-copy.ts`、`launcher.ts`、`migrate.ts`、`pit.ts`、`shared-layer.ts`
- 公共能力（非产品专属，pi-triple-deps 仓）：`@away_from/shared`、`@away_from/infra`

### PTH（Agent 协作与自优化系统——本仓）
- `src/pth/**`（应用/组装层）
- `src/cli/**`（pth CLI 入口）
- `packages/pth-contracts/**`
- `packages/pth-config/**`
- `packages/pth-memory/**`
- `packages/pth-sandbox/**`
- `packages/pth-kernel-storage/**`
- `packages/pth-kernel-interpreter/**`
- `packages/pth-kernel-execution/**`
- `packages/pth-console/**`（PTH client/protocol/pack + pth CLI 命令 + 人类操作台）
- `packages/pth-cli/**`（pth CLI 打包壳，dist + deploy/ 拷贝）

## 2. Import 规则

| 方向 | 规则 |
|---|---|
| PTH core → PTL-only | **禁止**（PTH 不依赖 PTL 环境管理） |
| PTL-only → PTH core | **禁止**（跨产品交互只经 `pth` CLI / HTTP API v1，不 import PTH 包） |
| 过渡区 client/protocol/operator-console → PTH core | 允许（B2/B3 搬迁后按观察清单保留） |
| 任何产品 → `@away_from/shared` / `@away_from/infra` | 允许 |
| `src/` → `packages/pth-*` | 允许（经公共 barrel） |
| `packages/pth-*` → `src/` | **禁止**（单向依赖） |
| 跨包内部深路径 | 仍遵守既有 `check-pth-boundaries`（公共 barrel 规则） |

## 3. 当前过渡状态

- Phase 0 完成：原 `ptl hub` 的 PTH 交互命令迁入 `packages/pth-console/src/commands/`（`pth` CLI 承接）；PTL 本地能力落位 `pi-triple-ptl` 的 `framework/src/program-dev/` 与 `framework/src/stack/`；framework 不再依赖 `@away_from/pth-console`。
- 产品边界检查器仍把 `packages/pth-console/src/bridge/**`、`operator-console/**` 标记为 `transitional` 观察清单，迁移收尾后可移除。
- 过渡区数量、文件清单在 `check-product-boundaries.ts` 输出中显示，便于迁移进度追踪。
- `packages/pth-cli` 是纯打包壳（无 src），由 `scripts/gen/build-pth-cli-package.sh` 填充 dist，属预期结构。

## 3.5 AgentEngine 独立化标记

- `src/pth/core/agent-engine.ts` 与 `src/pth/prototypes/workflow/**` 为**独立模块**，后期单独维护。
- active workflow / human-review 路径**禁止新增对 AgentEngine 的 import**；本次新增的 Trigger 增强、TaskFlow↔Trigger 接合、Human Interaction 均不依赖 AgentEngine。
- `src/pth/prototypes/workflow/**` 保持冻结原型，不进入 active 路径；待 AgentEngine 独立化后清理或改造。

## 4. 变更纪律

- 新增 PTL-only 或 PTH core 模块时，必须在 `check-product-boundaries.ts` 的归属集合中登记；
- 任何新的 PTL→PTH 直接依赖必须先经过本文件评审并记录过渡区；
- 违反者由 lint 阶段 `check:product-boundaries` 与 `test/pth-architecture/product-boundaries.test.ts` 双重拦截。
