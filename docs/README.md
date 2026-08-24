# pi-triple-pth 文档索引

> 全量文档清单由 `npm run docs:manifest` 生成 `docs/docs-manifest.json`（category/status 的机器可读事实源）。
> 本文件是**人读入口索引**：只收录当前活跃的主线文档与里程碑；历史设计稿（n14–n24 车道系列、v1.2 验收系列、k5 系列等）请查 manifest `status=historical`。
> 登记纪律：新增文档须能被 `scripts/build-docs-manifest.ts` 正确分类，并在本索引择区登记。
> 历史 SPEC/plan 链接（superpowers 等）保留指向旧仓归档：https://github.com/Phenol1145/pi-triple

## 仓库定位与协议

| 主题 | 文档 |
|------|------|
| 仓库定位 | [POSITIONING](POSITIONING.md)（三仓同源） |
| 执行面协议 | [execution-surface-v1-design](execution-surface-v1-design.md)（三仓同源） |
| 执行面拓扑与协议面固定计划 | [fracta-engine-execution-topology](fracta-engine-execution-topology.md)（三仓同源） |
| 待办设计方案（B 系列断裂登记） | [fracta-engine-backlog](fracta-engine-backlog.md)（三仓同源） |
| Role / Worker 定义协议 | [role-worker-protocol-v1](pth/role-worker-protocol-v1.md)（PTH 仓） |
| 领域术语表 | [CONTEXT](../CONTEXT.md)（仓库根） |
| ADR-0001：执行面全部外部化 | [adr/0001](adr/0001-fracta-engine-external-execution-surfaces.md)（三仓同源） |
| ADR-0002：tool containers 与 execution/v1.1 | [adr/0002](adr/0002-tool-containers-execution-v11.md)（三仓同源） |
| ADR-0003：pth-kernel 子包拆分 | [adr/0003](adr/0003-pth-kernel-subpackage-split.md) |
| ADR-0004：TCE 的 C 是 Code · PTC 能力接口第一性 | [adr/0004](adr/0004-tce-code-layer-ptc-capability-first.md) |
| ADR-0005：Role 四元组（身份/能力/资源/模块） | [adr/0005](adr/0005-role-four-tuple.md)（编号独立于旧仓归档） |

## 当前主线（2026-08-24 起）：系统构造模型化

| 主题 | 文档 | 状态 |
|------|------|------|
| 文档/计划实施状态盘点 | [plan-implementation-status-inventory](pth/plan-implementation-status-inventory.md) | 活跃（推荐执行顺序以此为准） |
| 工具面 TCE 结构化整改（W0–W5） | [tce-code-model-remediation-plan](pth/tce-code-model-remediation-plan.md) | 计划完成，待实施（当前首要） |
| Role 谱系 catalog 化与四元组细化（W0–W5） | [role-catalog-and-four-tuple-refinement-plan](pth/role-catalog-and-four-tuple-refinement-plan.md) | 计划完成，排在 TCE 之后 |
| 系统构造模型化审计（四元组裁决 / TCE 矩阵 / 可插拔性） | [system-construction-modeling-audit](pth/system-construction-modeling-audit.md) | 结论记录（§2.2 有两条勘误，见 TCE 计划 §0） |
| Role 谱系运行时推导（五环） | [role-lineage-runtime-derivation](pth/role-lineage-runtime-derivation.md) | 结论记录（发现断裂 B1/C1 → 已登记 backlog B9/B10） |
| 三源谱系与容量守恒设计 | [three-source-lineage-and-capacity-conservation-design](pth/three-source-lineage-and-capacity-conservation-design.md) | 已定稿（§12 概要设计待维护者补写） |
| 三源谱系重构计划 | [three-source-lineage-refactoring-plan](pth/three-source-lineage-refactoring-plan.md) | ✅ 已完成（W0–W4） |

## 部署 / 配置 / 概念

| 主题 | 文档 |
|------|------|
| 部署 / `pth up` | [deployment](pth/deployment.md) |
| 配置中心 | [configuration](pth/configuration.md) |
| 概念与命令映射 | [concepts](pth/concepts.md) |
| 架构 / 内核 / 编排 | [architecture](pth/architecture.md) · [kernel](pth/kernel.md) · [orchestration](pth/orchestration.md) |
| 模块归属 | [module-ownership](pth/module-ownership.md) |
| Trigger 运行时 / 沙箱安全运维 | [trigger-runtime](pth/trigger-runtime.md) · [sandbox-security-operations](pth/sandbox-security-operations.md) |
| 拆仓设计 | [repo-split-v15-design](pth/repo-split-v15-design.md) |
| 拆仓报告 | [phase1](pth/phase1-deps-split-report.md) · [phase2（主仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/docs/pth/phase2-pth-split-report.md) · [phase3（主仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/docs/pth/phase3-ptl-split-report.md) |

## PTH 核心设计（2026-08 落地）

| 主题 | 文档 | 状态 |
|------|------|------|
| 任务生命周期与上下文（goal / paused / pause / 压缩 / ASP 双轨） | [task-lifecycle-and-context-design](pth/task-lifecycle-and-context-design.md) | ✅ 已实施（2026-08-23 验收通过） |
| TCE 三层统一执行后端 | [llm-tool-notebook-unified-execution-backend-plan](pth/llm-tool-notebook-unified-execution-backend-plan.md) | ✅ 已实施（主路径）；C 的含义由 ADR-0004 修订为 Code |
| 执行模式与 Tool-Reg v2（tool-call / asp / ptc / pulse） | [design](pth/execution-modes-and-tool-reg-v2-design.md) · [plan](pth/execution-modes-and-tool-reg-v2-implementation-plan.md) | 实施中（Wave 0–5 已落地，Wave 6 收尾） |
| ExecutionTarget Matrix（notebook cell 路由） | [execution-target-matrix-plan](pth/execution-target-matrix-plan.md) | ✅ 已实施（Phase 1–5） |
| Trigger / Human Review 修正 | [workflow-trigger-human-review-correction-plan](pth/workflow-trigger-human-review-correction-plan.md) | ✅ 已实施（2026-08 批次） |
| pth-cli 命令注册渠道 | [pth-cli-command-registry-design](pth/pth-cli-command-registry-design.md) | 设计定稿待评审（实施待排期） |

## 已验收里程碑（GO）

| 里程碑 | 验收报告 | 设计稿 |
|------|------|------|
| N28 角色记忆编排可行性 | [feasibility-report](pth/n28-feasibility-report.md)（GO） | [n28 design](pth/n28-role-memory-orchestration-design.md)（生产化未开始） |
| N29 最小知识摄入内环 | [n29 report](pth/n29-minimal-intake-report.md)（MIN_INNER_LOOP_GO） | [n26 design](pth/n26-autonomous-knowledge-intake-design.md)（完整设计未实施） |
| N30 运行观测台 | [n30 report](pth/n30-runtime-observatory-report.md)（GO） | [n30 design](pth/n30-runtime-observatory-design.md) |
| N32 v1.3 专业计算 | [v13 report](pth/v13-professional-computing-report.md)（GO） | [n32 design](pth/n32-v13-professional-computing-design.md) |
| N33 PTL 五页操作台 | [n33 report](pth/n33-operator-console-report.md)（GO） | [n33 design](pth/n33-v13-ptl-operator-console-design.md) |
| v1.4 操作台 UX | [v14 report](pth/v14-operator-console-ux-report.md)（GO） | — |

## 未实施 / 待排期（详见盘点文档）

N25 完整 Human Interaction 协议 · N26 完整自主摄入 · N28 生产化 · PTH Bench 统一抽象（[pth-bench-unified-design](pth/pth-bench-unified-design.md)） · N31 统一工作流 DAG 2.0（[明确不实施](pth/n31-unified-workflow-dag-design.md)） · W8 任务派发提案（[待裁决](pth/w8-task-dispatch-design.md)） · backlog B9（adversarial 审核链断裂，一行修复）/ B10（观测-调节调度源缺失）。
