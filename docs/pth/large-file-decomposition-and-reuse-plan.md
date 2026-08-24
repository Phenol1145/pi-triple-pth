# 大文件分解与代码复用修复计划（审计审订版）

> 来源：2026-08-24 代码审计（大型文件分解 + 代码复用率专项，对话交付未落盘）→ 同日**逐条对当前代码复核后审订**。
> 本文档替代对话版修复计划；与 `modularity-reuse-audit.md`（2026-08-22 三仓审计，Phase A–D 已闭环）不重叠——那份关注产品边界/循环依赖/跨仓重复，本计划关注 `pi-triple-pth` 仓内大文件与仓内重复。
> 状态：**已实施**（2026-08-24 审订 → 2026-08-24 按 P0→P1→P2 全部落地并全量验证；commit `9d39ace`…`8869081`）。
> 复核基线：分支 `feat/pth-exec-unified` @ `f5ed699`。

## 1. 复核方法与数据

复核手段：对审计清单逐项 `wc -l` 复测 + 结构核对（函数跨度、调用点、包依赖方向）。当前非测试源码 446 文件 / ~80.5k LOC（`src` + `packages` 的 `.ts`）。关键复测数据：

| 文件 | 行数 | 结构核验 |
|---|---:|---|
| `packages/pth-kernel-execution/src/execution/agent-loop.ts` | 822 | `runAgentTaskCore` 单函数 39–808（**~770 行**） |
| `src/pth/execution/knowledge-intake/service.ts` | 1283 | `createKnowledgeIntakeService` 闭包 469–1283（~815 行）；另有 `createKnowledgeIntakeSubscriptionService` 248 起 |
| `src/pth/bootstrap/batch-process.ts` | 1245 | `runBatchProcess` 91–1245（~1155 行），组合根装配流，helpers/types 已抽出仍不减 |
| `packages/pth-kernel-storage/src/knowledge-intake-pg.ts` | 1027 | 单类 `PgKnowledgeIntakeRepository` 85–1022，~20 方法即接口契约；`storeAcquisition` 604–889（285 行） |
| `packages/pth-memory/src/memory-store-pg.ts` | 836 | 同类仓储适配器 |
| `src/pth/catalog/pilot-evaluator.ts` | 720 | 小而多的纯函数群 |
| `src/pth/execution/knowledge-promotion.ts` | 712 | repo 访问与服务编排混置 |
| `packages/pth-console/web-src/src/ui.tsx` | 676 | 12+ Preact 组件单文件 |
| `src/pth/bootstrap/task-loop.ts` | 632 | legacy 兼容壳，已委托 AgentTaskRunner |
| `src/pth/runner/agent-task-runner.ts` | 630 | `executeInner` 125 起，三模式分支（ptc 136–204 / fail-closed 205–218 / llm-agent 219 起） |
| `packages/pth-console/src/operator-console/server.ts` | 624 | 请求分发表 |
| `src/pth/gateway/routes-kernel.ts` | 603 | 路由注册表 |
| `src/pth/runner/intake-processors.ts` | 519 | 低于阈值，高内聚 |

## 2. 对原修复计划的修订（7 项）

| # | 原条目 | 复核结论 | 修订 |
|---|---|---|---|
| 1 | 分解清单 9 文件 | **遗漏最大候选**：`agent-loop.ts` 的 `runAgentTaskCore` 单函数 ~770 行（wave-5 接入 CommandGateway/adapter 后膨胀） | 新增为 P1 头号分解候选 |
| 2 | 拆 `intake-processors.ts` | 实际 519 行且高内聚 | 移出清单 |
| 3 | `batch-process.ts`「按 stage 拆」 | 该函数是组合根：host 引导→工具面→feasibility 运行时→IPC 控制链→intake→outbox→穿透预算，均为带段落注释的装配流，非业务 stage | 改为「按装配段抽 section-assembler 到 `bootstrap/batch/`」，不动业务语义 |
| 4 | legacy TaskLoop 后处理与 `runner/observers/*` 重叠 → 抽取 | wave-6 后 task-loop 已委托 AgentTaskRunner；剩余 notify/archive/requeue 是 legacy 分发路径自身职责 | 不抽取，随 legacy 分支删除决策一并消失 |
| 5 | `defaultRunner` ×3 合一 | `launcher.ts` 版语义不同（固定 `docker` 命令、spawn error 即 reject、无 env opts）且在 `packages/pth-console`——跨包不能依赖 `src/` | 只统一 `src/cli/runtime/` 内两份（doctor:62 与 orchestrator:94 逐字节近同）；launcher 保留 |
| 6 | `parseEnvFile`/`REQUIRED_SECRET_KEYS` 合并 | launcher（pth-console）↔ runtime-secrets（src/cli）跨包，唯一落点是下沉共享包；收益 ~40 行 vs 触碰 boundary 门禁 | 降级 P3：出现第三处重复再下沉 |
| 7 | do-not-split 清单 | `knowledge-intake-pg.ts`（1027）/ `memory-store-pg.ts`（836）是单接口仓储适配器，拆分必降聚合度 | 补入 do-not-split（例外：`storeAcquisition` 285 行单方法可内部提取，可选） |

## 3. 复用类发现（全部复核属实）

| 重复 | 位置 | 说明 |
|---|---|---|
| `notifyTaskDone` ×2（逐字节相同） | `src/pth/bootstrap/task-loop-helpers.ts:11`；`src/pth/runner/observers/notifier-observer.ts` | 两侧均活跃使用（task-loop.ts:538/562；dispatched 路径 observer），非死代码 |
| `maskSqlNoise` ×2 | `packages/pth-memory/src/read-only-query.ts:57`（私有）；`src/pth/execution/knowledge-broker.ts:99`（私有，注释自承"与 pth-memory 同构"） | knowledge-broker 已依赖 `@away_from/pth-memory`（:14 `ancestorChain`），导出复用零新依赖 |
| `sha256hex` ×7 | adapters：assembly:257 / computational-chemistry:118 / job-runner:53 / jupyter:131 / lean4:114 / u8:73 / wolfram:89 | 同一行实现复制 7 份 |
| `makeExec` + `cancel(jobId)` 样板 ×4~6 | makeExec：jupyter:135 / lean4:122 / u8:144 / wolfram:91；cancel：assembly:466 / compchem:208 / jupyter:364 / lean4:389 / u8:363 / wolfram:205 | job-runner.ts 已有公共脚手架（Phase A–D 产物），收敛未收尾 |
| `defaultRunner` ×2 | `src/cli/runtime/runtime-doctor.ts:62`；`runtime-orchestrator.ts:94` | 仅类型参数与 env 透传差异 |
| `sdkCreateSession` base-opts ×3 | `src/pth/core/agent-engine-session.ts:172`；`agent-engine-system.ts:91`；`agent-engine-recovery.ts` | 每处重复 `{cwd, model, thinkingLevel, modelRuntime, sessionManager, tools, customTools}` 装配 |

## 4. 修复计划（审订版）

### P0 — 机械去重（零行为变化，预计净删 ~200 行，可单批次）

1. `sha256hex` ×7 → 迁入 `adapters/job-runner.ts` 导出，7 个 adapter 改 import。
2. adapter cancel/probe 残余 → 收敛进 job-runner.ts 公共脚手架。
3. `notifyTaskDone` ×2 → canonical 落 `runner/observers/notifier-observer.ts`；`task-loop-helpers.ts` 改为 re-export（保住 task-loop 现有 import 与 legacy 路径行为）。
4. `maskSqlNoise` ×2 → `pth-memory/read-only-query.ts` 导出，knowledge-broker 改 import。

### P1 — 小结构修复 + 头号分解候选

5. **`agent-loop.ts` 分解（新增）**：抽三段自包含装配——① system prompt 装配段（根目标/发布者澄清/ASP_BLOCK/环境 prelude）；② 注册表工具面合并段（快照冻结/预算守卫/下划线别名）；③ CommandGateway/adapter 接线段。主循环留原位。目标 822 → ~400 + 2~3 个 100–200 行模块。
6. `defaultRunner` ×2 → 新建 `src/cli/runtime/spawn-runner.ts`。
7. `sdkCreateSession` base-opts ×3 → AgentEngine 加私有 `buildSessionBaseOpts(tenantId)`，三调用点收敛。

### P2 — 大文件分解（保持语义边界，每项独立 commit）

8. `knowledge-intake/service.ts`（1283）→ 按 fetch/extract/review/promote 阶段抽模块；service.ts 只留装配 + 接口。
9. `batch-process.ts`（1245）→ 按装配段抽 section-assembler 到 `bootstrap/batch/`（host-bootstrap / tool-face / feasibility-runtime / ipc-control / intake / outbox-drainer / runchild-budget）。
10. `agent-task-runner.ts`（630）→ 按 exec mode 抽 `runner/exec-modes/{ptc,llm-agent,pulse}.ts`；`executeInner` 变薄分发。
11. `knowledge-promotion.ts`（712）→ repo 访问 vs 服务编排分离。

### P3 — 暂缓（记录理由）

- `ui.tsx`（676，12+ 组件）→ 按组件拆文件：纯前端常规操作，等有 UI 改动顺带做（需 `typecheck:web`）。
- `routes-kernel.ts`（603）/ `operator-console/server.ts`（624）：注册/分发表层高内聚，未显著超阈值。
- `pilot-evaluator.ts`（720）：小而多的纯函数群，高内聚。
- `parseEnvFile` 跨包合并：等第三处重复出现再下沉共享包（候选落点 `@away_from/shared`）。
- `knowledge-intake-pg.ts` 的 `storeAcquisition`（285 行单方法）内部提取：可选，随下次 intake 存储改动评估。

### do-not-split（内聚度保护清单）

- `discipline-catalog-data-*.ts`（1370/914/708，生成物）
- `pth-contracts` 领域契约文件（tasking 653 / knowledge-intake 639 / runtime-observation 685）
- `pth-kernel-storage/src/schema.ts`（618，DDL 单表）
- `knowledge-intake-pg.ts`（1027）/ `memory-store-pg.ts`（836）——单接口仓储适配器（本次新入册）
- `task-loop.ts`（632）——legacy 兼容壳，随删除决策消失

## 5. 验收门禁（每项实施后）

1. `npm run build` + `npm run lint`（含 check:pth-boundaries / import-cycles / pth-config / product-boundaries / docs-links 全项）。
2. 相关测试文件 green；全量 `npx vitest run --maxWorkers=1`（并行跑 testcontainers 有争抢，串行为准）。
3. P2 每项 commit 附前后行数对照，且证明无行为变化（测试不改为原则；必须改测试时在 commit message 说明理由）。

## 6. 执行顺序建议

P0（单批次 1 commit）→ P1（每项 1 commit）→ P2（每项 1 commit，按 8→10→9→11 顺序：先收益大且边界清晰的）。**当前状态：已实施（2026-08-24）。**
