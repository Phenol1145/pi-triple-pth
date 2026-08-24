# 模块化与代码复用率审计（2026-08-22 刷新）

> 本文件替代旧版 v1.3.0 审计。旧版数据已过期：文件数、循环依赖、重复代码结论均与本版不一致。
> 扫描范围：`pi-triple-deps` / `pi-triple-pth` / `pi-triple-ptl` 三个仓库的 **git 跟踪文件**（排除 node_modules、dist、gitignore 生成物，如 `packages/pth-cli/deploy`）。
> 规模：**990** 个跟踪文件（生产 **602** / 测试 **388**），生产 LOC 约 **113.8k**。

## 1. 总体结论

1. **产品级拆仓方向正确**：PTL/PTH 产品边界 0 违规，`deps` 公共包被两个产品复用，包依赖大体单向。
2. **PTH 引擎内部仍未真正模块化**：`src/pth` 272 文件 / 56.9k LOC 仍是单块；`kernel` 87 文件 / 16.2k LOC、`execution` 35 文件 / 10.5k LOC。
3. **存在 1 个静态运行时循环依赖**，旧审计“0 循环”结论已失效。
4. **代码复用健康度中等**：公共包 fan-in 健康，但 runtime adapter、CLI 命令、web 页面、版本检查等存在成体系重复。

## 2. 规模指标

| 仓库 | 生产文件 | 测试文件 | 生产 LOC（约） |
|---|---:|---:|---:|
| pi-triple-deps | 47 | 17 | 6.8k |
| pi-triple-pth | 446 | 306 | 96.3k |
| pi-triple-ptl | 109 | 65 | 12.2k |
| **合计** | **602** | **388** | **113.8k** |

### 主要模块/包规模

| 模块/包 | 文件数 | LOC |
|---|---:|---:|
| `src/pth/kernel` | 87 | 16,218 |
| `src/pth/execution` | 35 | 10,541 |
| `src/pth/catalog` | 21 | 5,385 |
| `packages/pth-console/src` | 40 | 7,528 |
| `packages/pth-sandbox/src` | 23 | 4,854 |
| `packages/pth-memory/src` | 14 | 3,322 |
| `packages/framework/src` | 78 | 9,868 |
| `packages/pth-console/web-src` | — | 2,764 |

## 3. 产品边界与分包

- ✅ `check:product-boundaries`：PTH/PTL 均 0 违规。
- ✅ 公共包复用面：`@away_from/shared` 66 个 importer、`@away_from/pth-memory` 55、`@away_from/infra` 32、`@away_from/pth-console` 22、`@away_from/pth-sandbox` 22。
- ⚠️ `pth-console` 仍有 **22 个 transitional 文件**（`bridge/**` + `operator-console/**`），迁移未收尾。
- ⚠️ `pth-sandbox` 依赖 `pth-memory` 仅为了 `PTH_MEMORY_LIB_B64`，属于执行层反向依赖存储层，建议下沉常量。

## 4. 循环依赖

### 静态运行时环（1 个，需优先处理）

```
execution/index.ts
  → execution/knowledge-broker.ts
    → runner/index.ts
      → runner/cognitive-working-set.ts
        → execution/index.ts
```

根因：`execution/knowledge-broker.ts` 反向 import `runner/index` 获取 `computeKnowledgeQueryFingerprint`；`runner/cognitive-working-set.ts` 又 import `execution/index`。建议把该纯函数下沉到 `contracts` 或共享层。

### 其它环

- `kernel` 工具注册相关环主要来自动态 import，静态初始化不构成环，但调用期仍耦合。
- `web-src` 存在 `app.tsx ↔ Sidebar/CommandPalette` 的 type-only 环。
- `catalog / runner / execution` 之间存在大范围 type-level 环，说明 barrel 互相 re-export 过多。

## 5. 深路径耦合

`src/pth` 内部相对 import 共 **853** 条：

| 类型 | 数量 | 占比 |
|---|---:|---:|
| 同模块内 | 443 | 52.0% |
| 跨模块走 barrel | 190 | 22.3% |
| 跨模块深路径私有导入 | 220 | 25.8% |

典型深路径：`application/gateway/pth-gateway-facade.ts` → `kernel/storage/task-store-pg.ts`、`tasking/task-control-service.ts`、`execution/knowledge-broker.ts` 等。组合根 `bootstrap` 的深路径可接受，gateway/application 的直接私有访问应逐步收敛到公共 API。

## 6. 重复代码

### 整文件重复（跟踪文件，3 组）

- `deps/packages/shared/src/presence.ts` ≡ `ptl/extensions/_shared/presence.ts`
- `pth/scripts/check-doc-links.ts` ≡ `ptl/scripts/check-doc-links.ts`
- `pth/scripts/check-product-boundaries.ts` ≡ `ptl/scripts/check-product-boundaries.ts`

其中 check 脚本属于拆仓 `copyBoth` 有意复制，但仍是双份维护成本；`presence.ts` 建议收敛。

### 成体系重复样板

- **6 个 professional runtime adapter**：`assembly / lean4 / wolfram / computational-chemistry / jupyter / u8` 重复 job 状态机、输出收集、结果组装、`put` 逻辑。
- **CLI 命令**：`bench / debug / jobs / kernel / observe / programs / request / run / submit / trigger` 反复出现 `requireClient() + PthClient.fromConfig() + 未配置报错`。
- **Web 页面**：`config / debug / overview / work` 重复 `setLoadState / setErrorCode / useEffect` 错误处理样板。
- **版本检查**：`deps/shared`、`ptl/extensions/_shared`、`ptl/packages/mailbox` 三处各有一份相似实现。

### 生成物说明

`packages/pth-cli/deploy` 与根 `deploy` 的整目录重复是 `build-pth-cli-package.sh` 的 rsync 产物，且已被 gitignore，**不计入源码重复**。

## 7. 认知成本与可维护性

### 偏大的文件

- `discipline-catalog-data.ts` **2,965 行**
- `knowledge-intake-pg.ts` **1,496 行**
- `knowledge-intake/service.ts` **1,285 行**
- `batch-process.ts` **1,255 行**
- `memory-store-pg.ts` **1,056 行**

### 双 UI 栈

`pth-console` 同时存在 `web-src/`（Preact + Vite 新操作台）和 `web/operator-console/`（legacy 静态 JS，测试与 `server-assets` fallback 仍在使用）。这是明显的迁移过渡态，建议明确去留。

### 文档过期

- 旧版 `modularity-reuse-audit.md` 数据为 v1.3.0，已由本文件替代。
- `docs/pth/module-ownership.md` 引用的 `docs/product-shape.md` 在当前三仓中不存在，需修复引用。

## 8. 建议优先级与实施后状态

> 状态更新：2026-08-23 Phase A–D 已完成。下表“实施后状态”反映当前三仓代码/门禁实际状态。

| 优先级 | 建议 | 预期收益 | 实施后状态 |
|---|---|---|---|
| P0 | 拆掉 `execution ↔ runner` 静态运行时环，并在 CI 加循环检测 | 消除真实 ESM 环，恢复“0 环”可信度 | ✅ 已完成：`check:import-cycles` static-runtime/static-all/dynamic SCC 均为 0，且纳入 lint |
| P1 | 抽取 runtime adapter 公共执行脚手架 | 去掉 6 个 adapter 的大段重复 | ✅ 已完成：`job-runner.ts` 公共脚手架 + adapter 收敛 |
| P1 | 抽取 CLI `requireClient()` 公共 helper | 去掉 10+ 个命令的重复样板 | ✅ 已完成：`packages/pth-console/src/commands/client.ts` |
| P1 | 把 `PTH_MEMORY_LIB_B64` 从 `pth-memory` 下沉到共享层 | 修正 sandbox 反向依赖 | ✅ 已完成：`@away_from/shared` 导出 `PTH_MEMORY_LIB_B64`，`pth-sandbox` 不再依赖 `pth-memory` |
| P1 | 刷新 `module-ownership.md` 的失效引用 | 文档与代码一致 | ✅ 已完成：不再引用不存在的 `docs/product-shape.md` |
| P2 | 收敛 `_shared` 与 `shared` 的重复（presence/version-check） | 降低跨仓同步成本 | ✅ 已完成：同步守卫测试钉住 `presence.ts` / `extension-version-check.ts` 与 shared 一致 |
| P2 | 明确 operator console 双栈去留 | 减少两个 UI 的维护面 | 🔶 部分完成：legacy 静态 UI 已删除，Preact+Vite 新 UI 为生产面；`bridge/**` + `operator-console/**` 过渡文件仍保留在 `check:product-boundaries` 观察清单（22 个） |
| P2 | 进一步拆分 `src/pth/kernel`，或至少强制 barrel-only 跨模块导入 | 降低 PTH 引擎内部认知成本 | ✅ 已完成：barrel 纪律扩展到整个 `src/pth`；kernel 子包拆为 `pth-contracts/config/kernel-storage/interpreter/execution` 独立 workspace 包；大文件拆分完成 |
