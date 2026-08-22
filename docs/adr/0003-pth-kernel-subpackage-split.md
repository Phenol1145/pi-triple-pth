# ADR-0003: PTH kernel 子包拆分（独立 workspace npm 包）

**Status**: accepted

**Date**: 2026-08-23

## Context

Phase D 要求把 `src/pth/kernel`（约 88 文件 / 16.2k LOC）拆分为可独立维护的 workspace npm 包。
用户 D-3 选择“独立 workspace npm 包”，而非仅 barrel 纪律。

kernel 原内部依赖存在 execution ↔ extensions/interpreter/ptc 的环，且依赖根 `config/contracts/catalog/tasking`。
为了得到真正的独立包，必须先把低层契约/配置抽成包，并把 interpreter 侧依赖的 execution 组件
（event-bus / space-registry / tool-registry / debug-case-dispatch）下沉到 interpreter 包，
再由 execution 通过注入提供 `toolFaceBudgetCheck`，从而保持 interpreter → execution 单向依赖。

## Decision

1. 新建 `@away_from/pth-contracts`：原 `src/pth/contracts` 整体迁入，作为纯类型/校验契约包。
2. 新建 `@away_from/pth-config`：原 `src/pth/config` 整体迁入，作为配置中心包。
3. 新建 `@away_from/pth-kernel-storage`：原 `src/pth/kernel/storage/**` + `side-effect-outbox.ts`。
4. 新建 `@away_from/pth-kernel-interpreter`：原 `src/pth/kernel/interpreter/**`、`extensions/**`、`ptc/**`、
   `templates.ts`、`mcp-decompose.ts`、`execution/event-bus.ts`、`execution/space-registry.ts`、
   `execution/tool-registry.ts`、`execution/debug-case-dispatch.ts`。
5. 新建 `@away_from/pth-kernel-execution`：原 `src/pth/kernel/execution/**`（扣除下沉到 interpreter 的文件）、
   `logger.ts`、`prompt-docs.ts`、`exec-channel.ts`、`self-modify.ts`、`concept-design.ts`。
   `assembly.ts` 保留在 `src/pth/kernel/assembly.ts` 作为组合根（依赖 catalog/tasking）。
6. 依赖方向：
   - `pth-contracts` → 无内部依赖
   - `pth-config` → `pth-contracts`
   - `pth-kernel-storage` → `pth-contracts` / `pth-memory` / `pg`
   - `pth-kernel-interpreter` → `pth-contracts` / `pth-config` / `pth-kernel-storage` / `pth-memory` / `pth-sandbox`
   - `pth-kernel-execution` → `pth-contracts` / `pth-config` / `pth-kernel-storage` / `pth-kernel-interpreter` / `pth-memory`
7. `PTH_TOOL_FACE_BUDGET_CHECK` 从 interpreter 移到 execution 包，并通过 `ExtContext.toolFaceBudgetCheck`
   注入 manage 扩展，避免 interpreter → execution 反向依赖。
8. 根 `src/pth/kernel/index.ts` 保留为兼容门面，`assembly.ts` 仍留在根组合根。

## Consequences

- kernel 代码可按 storage/interpreter/execution 独立 typecheck/build/test。
- 跨模块深路径大幅减少，`check:pth-boundaries` 全量清零。
- `import-cycles` static-all SCC 从 2 降为 0。
- 需要更新根 package.json / vitest alias / build/lint 脚本。
- 后续若需发布，按 `pth-contracts → pth-config → pth-kernel-storage → pth-kernel-interpreter → pth-kernel-execution` 顺序发布。
