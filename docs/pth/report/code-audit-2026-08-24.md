# PTH 代码审计与结构优化报告（2026-08-24）

> 范围：`src/` 与 `packages/*/src` 的 TypeScript 源码；不含 `dist/`、`node_modules/`、测试夹具与数据目录。
> 方法：现有 `npm run lint` 全链检查 + 大型文件行数扫描 + 跨文件重复代码块扫描。

## 1. 审计结论

- 现有质量门禁全部通过：TS 编译、边界检查、import-cycle、role-conservation、product-boundaries、TCE coverage、docs-links 均绿。
- 存在若干 **大型单体文件** 与 **跨文件重复定义**，但均可非破坏性拆分/收敛。
- 本次已落地一批低风险重构；剩余建议见第 4 节。

## 2. 大型文件扫描（Top 10 源码文件）

| 文件 | 行数 | 性质 |
|---|---|---|
| `src/pth/catalog/data/discipline-catalog-data-a-f.ts` | 1370 | 数据卡（非代码逻辑） |
| `packages/pth-kernel-interpreter/src/ptc/contract.ts` | 1116 | TCE 能力契约（敏感核心） |
| `packages/pth-kernel-storage/src/knowledge-intake-pg.ts` | 1027 | PG 仓储实现 |
| `src/pth/catalog/data/discipline-catalog-data-n-z.ts` | 914 | 数据卡 |
| `packages/pth-memory/src/memory-store-pg.ts` | 836 | PG 仓储实现 |
| `src/pth/catalog/pilot-evaluator.ts` | 720 | 评估器 |
| `src/pth/catalog/data/discipline-catalog-data-g-m.ts` | 708 | 数据卡 |
| `packages/pth-kernel-execution/src/execution/agent-loop.ts` | 694 | agent 主循环（已部分拆分） |
| `packages/pth-contracts/src/runtime-observation.ts` | 685 | 契约类型 + 校验 + 工具函数 |
| `packages/pth-contracts/src/tasking.ts` | 653 | 契约类型 + 校验 + 工具函数 |

## 3. 本次已实施的结构优化

### 3.1 非破坏性大型文件拆分

- `src/pth/execution/knowledge-verdicts.ts`（563 行）拆分为：
  - `knowledge-verdicts-types.ts`：类型契约；
  - `knowledge-verdicts-hash.ts`：hash/稳定序列化纯函数；
  - `knowledge-verdicts-core.ts`：verdict 校验、绑定门禁、晋升判定；
  - 原文件保留为 barrel 再导出，外部导入路径不变。
- `packages/pth-contracts/src/runtime-observation.ts`（685 行）拆分为：
  - `runtime-observation-types.ts`：DTO 类型与常量；
  - `runtime-observation-utils.ts`：谓词、稳定 ID、Freshness 计算、WorkMode 过滤；
  - `runtime-observation-validators.ts`：全部 `validate*` 结构校验；
  - 原文件保留为 barrel 再导出，外部导入路径不变。

### 3.2 代码复用率提升

- **PG 查询面统一**：新增 `src/pth/shared/pg-queryable.ts`，提供 `PgQueryable` 与 `parseJsonField`；
  - `src/pth/execution/pg-repository-types.ts` 改为 barrel 再导出；
  - N25 `PgTaskDraftRepository` 与 N28 三个 PG 适配器统一复用，删除本地重复 `Queryable` / JSON 解析函数。
- **Adapter 执行结果类型收敛**：`ChemExecResult` / `JupyterExecResult` / `Lean4ExecResult` / `U8ExecResult` / `WolframExecResult` 及其 Fn 类型改为 `AdapterExecResult` / `AdapterExecFn` 的别名，删除 5 份重复定义。
- **Env 文件解析收敛**：新增 `packages/pth-config/src/env-file.ts` 的 `parseEnvFile`；
  - `src/cli/runtime/runtime-secrets.ts` 的 `parseSecretsEnvFile` 与 `packages/pth-console/src/launcher.ts` 的 `parseEnvFile` 统一复用同一实现，并保留原导出名。

### 3.3 延后事项记录

- 已在 `docs/pth/plan-implementation-status-inventory.md` 新增「7. 当前延后事项（2026-08-24 记录）」：
  - D1 N25 PG TaskDraft 接入服务层；
  - D2 N28 PG 适配器接入注册表；
  - D3 N26 真实爬取调度与告警；
  - D4 N28 权重标定/重平衡接入治理回路；
  - D5 N31 不排期。

## 4. 后续建议（未在本轮实施）

- 继续拆分高行数契约文件：`packages/pth-contracts/src/tasking.ts` 可按「类型 / 校验 / 工具函数」三明治拆分（`runtime-observation.ts` 已按此模式完成）。
- 继续拆分 PG 仓储实现：`knowledge-intake-pg.ts`、`memory-store-pg.ts` 可按表/领域切片拆分，但需配合真实 PG 集成测试。
- 收敛更多重复定义：
  - `runtime-execution-result` 形状仍散落在 `exec-via-backend.ts` 与 `assembly-runtime-adapter.ts`（形状不同，需先统一语义）；
  - `cognitive-budget.ts` / `cognitive-responsibility.ts` / `system-inspection.ts` 的内存用量字段重复；
  - `agent-loop.ts` 与 `agent-loop-registry-execution.ts` 的 step 汇总片段重复。
- 为重复块扫描建立可复用的 `scripts/check-duplication.ts`，纳入 CI（本轮仅做一次性扫描）。

## 5. 验证

- `npm run lint` 全绿。
- 定向测试通过：`knowledge-verdicts`、`pg-n28-repositories`、`pg-task-draft-repository`、`runtime-secrets`、`launcher`、professional routing 等。
- 全量 `PTH_ASP_MODE=off npx vitest run` 于提交前再次执行。
