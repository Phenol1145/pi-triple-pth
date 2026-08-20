# 模块归属与产品边界（PTL / PTH）

> 依据：`docs/product-shape.md`（2026-08-21 产品形态基线）。
> 本文件回答“哪个目录属于哪个产品、允许怎么 import”，由 `scripts/check-product-boundaries.ts` 机械校验。

## 1. 产品归属

### PTL（pi 环境管理工具）
- `packages/framework/src/bridge/**`（`ptl hub` CLI 命令实现；经 `@away_from/pth-console` 访问 PTH）
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
- `packages/pth-console/src/**`（PTH client/protocol/pack + 人类操作台）
- `packages/mailbox/src/**`（PTH 侧邮箱/异步通道）

## 2. Import 规则

| 方向 | 规则 |
|---|---|
| PTH core → PTL-only | **禁止**（PTH 不依赖 PTL 环境管理） |
| PTL-only → PTH core | **禁止，唯一例外 `@away_from/pth-console`**（PTL 便捷调用入口，检查器白名单） |
| 过渡区 client/protocol/operator-console → PTH core | 允许（B2/B3 搬迁后按观察清单保留） |
| 任何产品 → `@away_from/shared` / `@away_from/infra` | 允许 |
| 跨包内部深路径 | 仍遵守既有 `check-pth-boundaries`（公共 barrel 规则） |

## 3. 当前过渡状态

- B2/B3 搬迁完成：PTH client/protocol 与 operator-console 迁入 `packages/pth-console`；`ptl hub` CLI 命令实现保留在 `packages/framework/src/bridge/`。
- 产品边界检查器仍把 `packages/pth-console/src/bridge/**`、`operator-console/**` 标记为 `transitional` 观察清单，迁移收尾后可移除。
- 过渡区数量、文件清单在 `check-product-boundaries.ts` 输出中显示，便于迁移进度追踪。

## 4. 变更纪律

- 新增 PTL-only 或 PTH core 模块时，必须在 `check-product-boundaries.ts` 的归属集合中登记；
- 任何新的 PTL→PTH 直接依赖必须先经过本文件评审并记录过渡区；
- 违反者由 lint 阶段 `check:product-boundaries` 与 `test/pth-architecture/product-boundaries.test.ts` 双重拦截。
