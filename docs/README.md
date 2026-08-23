# pi-triple-pth 文档索引

> 全量文档清单由 `npm run docs:manifest` 生成 `docs/docs-manifest.json`。
> 历史 SPEC/plan 链接（superpowers 等）保留指向旧仓归档：https://github.com/Phenol1145/pi-triple

## 仓库定位与协议

| 主题 | 文档 |
|------|------|
| 仓库定位 | [POSITIONING](POSITIONING.md)（三仓同源） |
| 执行面协议 | [execution-surface-v1-design](execution-surface-v1-design.md)（三仓同源） |
| 执行面拓扑与协议面固定计划 | [fracta-engine-execution-topology](fracta-engine-execution-topology.md)（三仓同源） |
| Role / Worker 定义协议 | [role-worker-protocol-v1](pth/role-worker-protocol-v1.md)（PTH 仓） |
| 决策记录 | [ADR-0001：执行面全部外部化](adr/0001-fracta-engine-external-execution-surfaces.md)（三仓同源） |
| 决策记录 | [ADR-0002：tool containers 与 execution/v1.1](adr/0002-tool-containers-execution-v11.md)（三仓同源） |

## 部署 / 配置 / 概念

| 主题 | 文档 |
|------|------|
| 部署 / `pth up` | [deployment](pth/deployment.md) |
| 配置中心 | [configuration](pth/configuration.md) |
| 概念与命令映射 | [concepts](pth/concepts.md) |
| 模块归属 | [module-ownership](pth/module-ownership.md) |
| 拆仓设计 | [repo-split-v15-design](pth/repo-split-v15-design.md) |
| 拆仓报告 | [phase1](pth/phase1-deps-split-report.md) · [phase2（主仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/docs/pth/phase2-pth-split-report.md) · [phase3（主仓归档）](https://github.com/Phenol1145/pi-triple/blob/main/docs/pth/phase3-ptl-split-report.md) |

## PTH 核心设计（2026-08 落地）

| 主题 | 文档 | 状态 |
|------|------|------|
| 任务生命周期与上下文（goal / paused / pause / 压缩 / ASP 双轨） | [task-lifecycle-and-context-design](pth/task-lifecycle-and-context-design.md) | ✅ 已实施（2026-08-23 验收通过） |
| TCE 三层：Tool → Command → Execute 统一执行后端 | [llm-tool-notebook-unified-execution-backend-plan](pth/llm-tool-notebook-unified-execution-backend-plan.md) | ✅ 已实施（主路径） |
| ExecutionTarget Matrix（notebook cell 路由） | [execution-target-matrix-plan](pth/execution-target-matrix-plan.md) | ✅ 已实施（Phase 1–5） |
| Trigger / Human Review 修正 | [workflow-trigger-human-review-correction-plan](pth/workflow-trigger-human-review-correction-plan.md) | ✅ 已实施（2026-08 批次） |
| pth-cli 命令注册渠道 | [pth-cli-command-registry-design](pth/pth-cli-command-registry-design.md) | 设计定稿待评审（实施待排期） |
