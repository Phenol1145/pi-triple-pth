# N28 生产化实施计划（草案）

> 日期：2026-08-24
> 前置：N28 可行性验证 GO（`n28-feasibility-report.md` / `n28-feasibility-envelope.json`）。
> 上游设计：`docs/pth/design/n28-role-memory-orchestration-design.md`
> 状态：**计划草案 + M1–M5 内存骨架 + Repository 缝已落地（2026-08-24）**——lease / Region / outbox / weight calibration / rebalance planner 已具纯函数与注册表；PG 持久化实现尚未实施。

## 1. 目标

把 N28 可行性切片升级为生产可运行形态：WorkerReplica 身份持久化、MemoryRegion 责任区持久化、
任务认知账本与 outbox 投影、责任权重标定与重平衡。

## 2. 非目标（本计划不做）

- 自动 Role 分化 / 自动 Region 分裂（后续独立工作流）；
- embeddings / 向量检索；
- N26 摄入边界修改；
- 改变 N27 R1–R6 已验收契约。

## 3. 工作项

### 3.1 持久化 WorkerReplica 身份与 lease

- 将可行性切片的内存 WorkerReplica 身份升级为 PG 持久表（tenant / workerId / roleId / generation / lease 字段）。
- lease 续约、过期回收、重平衡交接使用现有 TaskLease CAS 语义扩展。
- 验收：replica 重启后身份不漂移；同角色多副本可独立寻址。

### 3.2 MemoryRegion / Responsibility 持久化

- 新增 Region 表与 Responsibility 表（tenant / regionId / selector / 成员引用 / weight / owner）。
- 正文不复制；Region 只存引用与可重建投影。
- 可见性过滤顺序保持：tenant → space → status=official → Execution Grant → responsibility priority。
- 验收：Region 成员关系可持久、可重建；责任区不扩大权限。

### 3.3 任务认知账本 outbox 投影

- 将可行性切片的内存 CognitiveBudget ledger 升级为任务级持久账本。
- 写操作与任务状态变更同事务，经 outbox 投影到观测面。
- 验收：任务重跑/恢复后账本可恢复；审计可追溯。

### 3.4 权重标定

- 基于真实任务负载采集责任区命中率、检索扩检率、认知预算占用。
- 生成建议权重（保留人工/监督批准通道，不自动改）。
- 验收：标定结果可复现、可审核。

### 3.5 重平衡

- 在权重标定与容量硬上限之间提供受控重平衡流程（drain → reassign → verify）。
- 重平衡不改变可见性授权，不静默制造知识不可达。
- 验收：重平衡前后 gold item 可达性不变；容量不超限。

## 4. 里程碑

| M | 内容 | 验收 |
|---|---|---|
| M1 | 持久 replica/lease | 重启不漂移、CAS 语义绿 |
| M2 | Region/Responsibility 持久化 | 成员可重建、权限不放大 |
| M3 | 认知账本 outbox | 同事务、审计可追溯 |
| M4 | 权重标定 | 可复现、可审核 |
| M5 | 重平衡 | 可达性不变、容量不超限 |

## 5. 风险

- 持久化引入 schema 迁移：需与现有 PG schema 版本管理一致；
- 重平衡期间任务中断：drain/verify 流程需显式超时与回滚；
- 权重标定噪声：需足够样本与确定性基准（可接 PTH Bench 受控测量）。

## 6. 未决问题

- Region 表是否纳入现有 `pth-kernel-storage` schema 还是独立迁移；
- 重平衡触发频率与人工审批边界；
- 与 Role Catalog 的 Region 声明关系（模块 memory 声明先行落地）。
