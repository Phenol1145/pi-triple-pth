# N27：v1.2 复验修复轮（R1–R6）实施计划

> 日期：2026-08-18
>
> 输入：`docs/pth/report/v1.2-acceptance-fix-revalidation.md`（NOT ACCEPTED；P0-1…P0-5、P1-1…P1-5、§6 R1–R6）
>
> 目标：按复验报告 §6 的最小关闭顺序，逐条关闭全部 P0/P1，使 Gate A/B/C 可改回 accepted。
> 每 lane 先按本计划与对应分契约实施；**禁止把任何关闭条件缩窄**（这是 F1–F5 被复验驳回的核心原因），
> 每条关闭条件必须有代码 + 真实 PG 正向/负向探针或组合验收证据，可逐条对账。

## 1. 复验结论摘要

复验对象 `main@3beba51`（F1–F5 已合并）。复验认定：provenance、capability 合并、复合租户身份、
生产 Catalog、结构化 seed evidence、默认 Domain 继承和 candidate lineage 真实成立；但分契约把
若干 Gate 关闭条件缩窄，当前状态：

> **F1–F5 contracted fixes merged；原 Gate A/B/C 组合验收仍未关闭。**

仍存在的阻塞：

- **P0-1**：revision/version 不变量被破坏（status/meta-only write 不增 version 却写同 revision 历史 → 二次 mutation `23505`）；promotion 无 expected-revision CAS 与单事务。
- **P0-2**：raw SQL 只有入口授权，没有数据面租户/status/space 隔离。
- **P0-3**：stale verdict 可用于晋升新版本（只拒绝 future，不拒绝 stale）。
- **P0-4**：task commit 与 outbox enqueue 不同事务，崩溃窗口永久丢 candidate。
- **P0-5**：outbox claim 非原子（`FOR UPDATE SKIP LOCKED` 自动提交后锁即释放），多进程可重复处理、stale handler 可把 complete 改回 pending。
- **P1-1**：delegate domains 显式子集未同步裁剪 binding，claim 会丢弃整个 binding。
- **P1-2**：无持久 VerificationPlan，service 层身份/授权仍可选。
- **P1-3**：评测手工复制检索管线；60 题只覆盖 10/24 条知识；零 token 命中回退任意 top-5。
- **P1-4**：结构化 EvidenceRef 未贯通 worker 上下文（生产 Context 仍映射 provenance）。
- **P1-5**：全量组合测试仍出现 `observer failed: ... reading 'pool'`，observer 失败只写 warning。

## 2. R1–R6 与 P0/P1 映射

| Lane | 关闭对象 | 契约文件 |
|---|---|---|
| **R1** | P0-1 revision/version + promotion CAS | `docs/pth/contract/n27-r1-contract.md` |
| **R2** | P0-2 raw SQL 数据面隔离 | `docs/pth/contract/n27-r2-contract.md` |
| **R3** | P0-3 stale verdict、P1-1 Domain subset binding、P1-2 VerificationPlan + service 授权 | `docs/pth/contract/n27-r3-contract.md` |
| **R4** | P0-4 同事务 enqueue、P0-5 claim lease/token/CAS、P1-5 observer 命名 + durable failure | `docs/pth/contract/n27-r4-contract.md` |
| **R5** | P1-3 生产端口评测 + 全语料覆盖、P1-4 EvidenceRef 全链一致 | `docs/pth/contract/n27-r5-contract.md` |
| **R6** | 组合验收：`claim → context → commit → outbox → candidate → verification → promotion → retrieve` 全链 + 崩溃/并发/跨租户 | `docs/pth/contract/n27-r6-contract.md` |

## 3. Wave 划分与依赖

| Wave | Lane | 依赖 | 主要文件域（合并前不得越界） |
|---|---|---|---|
| **wave1**（并行） | R1 / R2 / R4 | 无相互依赖；文件集不相交，可并行 | R1：`packages/pth-memory/src/memory-store-pg.ts` + `src/pth/execution/knowledge-promotion.ts`；R2：`src/pth/application/gateway/pth-gateway-facade.ts` + `src/pth/execution/knowledge-broker.ts`；R4：`src/pth/tasking/{task-dispatcher,task-outcome-observers,side-effect-outbox}.ts` + `src/pth/runner/observers/refine-observer.ts` + `src/pth/kernel/storage/schema.ts` |
| **wave2** | R3 | 依赖 R1（共用 `knowledge-promotion.ts`）；建议先合 R1 再合 R3 | `src/pth/execution/{knowledge-verdicts,knowledge-promotion}.ts`、`src/pth/tasking/{task-control-service,task-work-item-reader}.ts`、`src/pth/kernel/storage/schema.ts`、`src/pth/application/gateway/pth-gateway-facade.ts`、`src/pth/gateway/routes-kernel.ts` |
| **wave3** | R5 | 依赖 R3（VerificationPlan 进 EvidenceRef 链） | `src/pth/runner/knowledge-context.ts`、`src/pth/execution/{knowledge-ranking,knowledge-broker}.ts`、`src/pth/catalog/{pilot-evaluator,data/pilot-eval-queries}.ts`、`scripts/{seed-k5-pilot,eval-k5-pilot}.ts`、`packages/pth-memory/src/knowledge-provenance.ts`（EvidenceRef 类型或新文件） |
| **wave4** | R6 | 依赖 R1–R5 全部合并 | 组合验收测试/脚本 + 最终复验报告 |

> 说明：R2 在 wave1 改 `knowledge-broker.ts`，R5 在 wave3 再改同一文件——因 R2 已合并，属串行依赖，不冲突。
> R3 与 R4 都涉及 `src/pth/kernel/storage/schema.ts`：R4 在 wave1 改 outbox 列，R3 在 wave2 加
> VerificationPlan 表。两者不同区段，但 wave1 并行时 **R3 尚未开工**，故无冲突；R4 合入后 R3 在其上叠加。

## 4. 车道纪律（沿用 parallel-lanes.md）

1. 开工先读 `docs/pth/parallel-lanes.md` 全部 + 本计划 + 本 lane 分契约；把 lane 行标 claimed 并 commit push。
2. 工作目录 `.worktrees/<lane>` / 分支 `lane/<lane>-*`（`scripts/ops/lane-worktrees.sh` 初始化；`ln -s ../../node_modules node_modules` 快速起步）。
3. 只改本契约列出的文件与测试；不改 `concepts.md` / `parallel-lanes.md` 热点（合并时由合并者统一归并）/ `TODO.md` / `README` 徽章。
4. lane 内跑定向测试 + 真实 PG 探针；合并前由合并者跑全量门槛。
5. 遇真实分叉停下来出选择题，裁决结果记入账本决策栏。
6. 完成：lane 分支 push → 账本标 done（填产出 commit）→ 等串行合并。

## 5. 每 wave 合并门槛

1. 该 wave 内每个 lane：定向 vitest（含真实 PG/Redis 负向与并发探针）全绿。
2. 合并前全量：`npx vitest run`（连接 compose PG/Redis 或等价真实依赖）全绿，**不允许以宿主无 DB 环境的 skip 作为证据**。
3. `npm run lint` 全绿（tsc 全包 + `check:pth-boundaries` 0 违规 + `check:pth-config` 0 直读）。
4. 合并者逐条对账契约「关闭条件对账表」：每一条都要有测试/探针证据链接，未对账不得合并。
5. 合并顺序严格 wave1（R1→R2→R4 任意，相互独立）→ wave2（R3）→ wave3（R5）→ wave4（R6）；每 lane 合并后全量门槛重跑。

## 6. 最终完成标准

- R1–R6 全部合并，每条 P0/P1 关闭条件均有正向 + 负向证据；
- R6 组合验收覆盖进程崩溃、并发 drainer、lease 过期、重复结果、policy/tenant 跨租户；
- 最终复验报告按 `v1.2-acceptance-fix-revalidation.md` 的矩阵格式给出，并明确写
  **ACCEPTED**（或诚实标注仍未关闭项——不允许用"测试绿"或"离线 fixture 自洽"替代生产验收）；
- 只有 R1–R6 的正向与负向证据均成立，才可把 Gate A/B/C 改回 accepted。

## 7. 车道表

| Lane | 分支 / worktree | 状态 |
|---|---|---|
| R1 | `lane/r1-revision-promotion` / `.worktrees/r1` | free |
| R2 | `lane/r2-tenant-query-plane` / `.worktrees/r2` | free |
| R3 | `lane/r3-verification-binding` / `.worktrees/r3` | free |
| R4 | `lane/r4-transactional-outbox` / `.worktrees/r4` | free |
| R5 | `lane/r5-production-evaluation` / `.worktrees/r5` | free |
| R6 | `lane/r6-composition-acceptance` / `.worktrees/r6` | free |
