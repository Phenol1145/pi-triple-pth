# 模块归属与产品边界（PTL / PTH）

> 依据：`docs/product-shape.md`（2026-08-21 产品形态基线）。
> 本文件回答“哪个目录属于哪个产品、允许怎么 import”，由 `scripts/check-product-boundaries.ts` 机械校验。

## 1. 产品归属

### PTL（pi 环境管理工具）
- `packages/framework/src/cli/**`
- `packages/framework/src/commands/**`
- `packages/framework/src/containers/**`
- `packages/framework/src/session/**`（PTL tmux session 管理）
- `packages/framework/src/tui-*/**`（TUI，产品形态已定为废弃，保留只读兼容）
- 顶层 PTL 入口/工具：`env.ts`、`extension-copy.ts`、`launcher.ts`、`migrate.ts`、`pit.ts`、`shared-layer.ts`
- 公共能力（非产品专属）：`packages/shared/src`、`packages/infra/src`

### PTH（Agent 协作与自优化系统）
- `src/pth/**`
- `packages/pth-memory/src/**`
- `packages/pth-sandbox/src/**`
- `packages/mailbox/src/**`（PTH 侧邮箱/异步通道）
- PTH 对外 client/操作台过渡区（物理上还在 framework 包，待 B3 迁移）：
  - `packages/framework/src/bridge/**`（PTH HTTP client）
  - `packages/framework/src/operator-console/**`（当前人类操作台，先搬迁再扩展）

## 2. Import 规则

| 方向 | 规则 |
|---|---|
| PTH core → PTL-only | **禁止**（PTH 不依赖 PTL 环境管理） |
| PTL-only → PTH core | **禁止**（PTL 只保留便捷调用；PTH 业务经 bridge 或 operator-console 过渡区） |
| 过渡区 bridge/operator-console → PTH core | 允许（待 B3 搬迁后收紧） |
| 任何产品 → `@away_from/shared` / `@away_from/infra` | 允许 |
| 跨包内部深路径 | 仍遵守既有 `check-pth-boundaries`（公共 barrel 规则） |

## 3. 当前过渡状态

- `operator-console` 逻辑上属于 PTH，但物理位置在 `packages/framework`；B3 会搬迁到 PTH 侧。
- 在搬迁完成前，产品边界检查器把 `bridge/**`、`operator-console/**` 标记为 `transitional`，不视为违规。
- 过渡区数量、文件清单在 `check-product-boundaries.ts` 输出中显示，便于迁移进度追踪。

## 4. 变更纪律

- 新增 PTL-only 或 PTH core 模块时，必须在 `check-product-boundaries.ts` 的归属集合中登记；
- 任何新的 PTL→PTH 直接依赖必须先经过本文件评审并记录过渡区；
- 违反者由 lint 阶段 `check:product-boundaries` 与 `test/pth-architecture/product-boundaries.test.ts` 双重拦截。
