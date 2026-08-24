# PTH 文档与计划实施状态盘点

> 日期：2026-08-24
> 口径：以 `docs/` 文档与当前代码交叉核对。文档头部状态若与验收报告/代码冲突，以验收报告与代码为准，并在「待回填」中标注。

## 1. 文档体系总览

- 事实源索引：`docs/docs-manifest.json`（含 taxonomy / docs / codeRuntime）。
- 文档类别：`decisions`（ADR）、`designs`、`contracts`、`reports`、`envelopes`、`operations`、`guides`、`releases`、`artifacts`。
- 当前已归档/历史类文档不参与“未实施计划”统计；本文只盘点**仍处 active / 待实施 / 实施中**的计划。

## 2. 已实施 / 已收口（简述）

以下计划已有明确落地与验收记录，不再列为未实施：

| 计划 / 文档 | 状态 |
|---|---|
| 三源谱系重构 W0–W4 | ✅ 完成（`three-source-lineage-refactoring-plan.md`） |
| 部署目标与配置简化 W0–W4 | ✅ 完成（`deploy-targets-*`） |
| 执行目标矩阵 Phase 1–5 | ✅ 完成（`execution-target-matrix-plan.md`） |
| LLM/Tool/Notebook 统一执行后端主路径 | ✅ 完成（`llm-tool-notebook-unified-execution-backend-plan.md`） |
| Workflow/Trigger/Human Review 修正 | ✅ 完成（`workflow-trigger-human-review-correction-plan.md`；含通用 human-requests HTTP） |
| 任务生命周期与上下文 | ✅ 完成（`task-lifecycle-and-context-design.md`） |
| 大文件分解与复用 P0–P2 | ✅ 完成（`large-file-decomposition-and-reuse-plan.md`） |
| N28 Role/Memory/Worker 可行性验证 | ✅ GO（`n28-feasibility-report.md` / `n28-feasibility-envelope.json`） |
| N29 最小知识摄入内环 | ✅ MIN_INNER_LOOP_GO（`n29-minimal-intake-report.md` / `n29-minimal-intake-acceptance.json`） |
| N30 统一运行观测台 | ✅ GO（`n30-runtime-observatory-report.md` / `n30-runtime-observatory-envelope.json`） |
| N32/v1.3 专业计算 | ✅ GO（`v13-professional-computing-report.md` / `v13-professional-computing-envelope.json`） |
| N33/v1.4 Operator Console | ✅ GO（`n33-operator-console-report.md` / `v14-operator-console-ux-report.md`） |
| 模块化与可行性跟进 Phase A–E | ✅ 完成（`modularity-and-feasibility-followup-implementation-plan.md`） |
| parallel-lanes 历史 lane | ✅ 全部 done |
| packages/pth-memory、pth-sandbox TODO | ✅ 全部勾平 |

## 3. 实施中 / 待收尾

| 文档 | 状态 | 剩余内容 |
|---|---|---|
| `docs/pth/execution-modes-and-tool-reg-v2-implementation-plan.md` | 实施中 | Wave 0–5 已落地；Wave 6（文档、全量验证、发布准备）进行中。注意文档第 1 节实现地图仍写“ptc 迭代/观察策略未实现”，但代码已存在 `ptc-agent-loop.ts` / `observation-strategy.ts`，需回填。 |
| `docs/pth/container-runtime-adapter-protocol.md` | 实施中 | R1–R3 已覆盖；R4 Docker/OrbStack 数据适配器、R5 Podman 适配器、R6 `/health` 暴露、R8 权威验收待完成。 |
| `docs/fracta-engine-execution-topology.md` | 部分待收尾 | U8-2（有状态 u8 接线）待接线；P5 Jupyter 体验收尾/legacy 清理待办需与 backlog 已办项复核。 |

## 4. 未实施 / 待实施（重点）

按当前优先级排列。

| # | 计划 | 文件 | 状态 | 范围 | 依赖 / 建议 |
|---|---|---|---|---|---|
| 1 | **工具面 TCE 结构化 W0–W5** | `docs/pth/tce-code-model-remediation-plan.md`、`docs/adr/0004-tce-code-layer-ptc-capability-first.md` | 未实施（计划已定稿，实施待批准） | 能力契约统一 → 能力实现搬迁 → tool-call 投影化 → 静态审核升级 → 网关退役/Execute 重构 → 观测收尾 | **当前首要**；role catalog W0 词汇表与它共用 |
| 2 | **Role Catalog 化与四元组细化 W0–W5** | `docs/pth/role-catalog-and-four-tuple-refinement-plan.md` | 未实施（已立项，次优先级） | 词汇表收敛 + v1 schema + catalog 装载 + sensor/controller/actuator/professional 枝切分 | 依赖 TCE W0 能力词汇表；建议 TCE 后启动 |
| 3 | **B9 adversarial 审核链断裂修复** | `docs/fracta-engine-backlog.md`、`docs/pth/role-lineage-runtime-derivation.md` | 未实施（一行级） | `system-triggers.ts` 两个 trigger 补 `role:"controller:adversarial"` | 可独立先修；阻塞 controller 枝切分验证 |
| 4 | **B10 观测-调节调度源缺失** | `docs/fracta-engine-backlog.md`、`docs/pth/role-lineage-runtime-derivation.md` | 未实施（小机制） | 新增向 sensor 七点位 / controller 九点位定期或按 A/B 周期派单的调度器 | 治理回路自闭环前置；建议与 B9 同批 |
| 5 | **PTH Bench 统一抽象** | `docs/pth/pth-bench-unified-design.md` | 待实施（设计稿已定方向） | agentic benchmark 与运行效率测试统一流水线（Scenario/Driver/ExecPolicy/Grader/Baseline Gate） | 依赖 TCE/观察策略落地；受控测量上游 |
| 6 | **N25 完整 Human Interaction 协议** | `docs/pth/n25-human-interaction-protocol-design.md` | 部分实施 | HumanRequest HTTP/持久化/任务 wait gate 已实现；意图解析、TaskDraft、Quality Gate、Presentation 等完整协议未实施 | 需先回填文档状态再评估剩余范围 |
| 7 | **N26 完整自主知识摄入** | `docs/pth/n26-autonomous-knowledge-intake-design.md` | 部分实施 | N29 最小可信摄入内环已 GO；来源发现外环、自动扩源、多域广度、生产默认阈值与持续运营未实施 | 独立产品线；生产化另立项 |
| 8 | **N28 生产化** | `docs/pth/n28-role-memory-orchestration-design.md`、`docs/pth/n28-role-memory-orchestration-implementation-plan.md` | 可行性 GO，生产化未开始 | persistent lease/Region 表/outbox 投影/权重校准/重平衡等生产化修缮 | GO 仅授权编写生产化实施计划；需先立新计划 |
| 9 | **N31 2.0 统一 Workflow DAG 薄腰** | `docs/pth/n31-unified-workflow-dag-design.md` | 明确不实施 2.0 | WorkflowRunGraph / Compiler / 统一查询 API / 通用控制面 | 当前阶段为 1.x 真实场景验证；非近期待办 |
| 10 | **W8 PTL 任务派发与交互逻辑** | `docs/pth/w8-task-dispatch-design.md` | 设计提案（待裁决） | 入口显式派发、父→子投递、回流协议、组织权机器校验 | 部分语义已被 task-lifecycle 实现取代；需裁决后再定剩余范围 |
| 11 | **pth-cli 新命令注册渠道** | `docs/pth/pth-cli-command-registry-design.md` | 设计定稿待评审 | Symlink Command Registry（外部可执行模型） | 独立 CLI 增强 |
| 12 | **执行模式与 Tool-Reg v2 设计定稿** | `docs/pth/execution-modes-and-tool-reg-v2-design.md` | 草案修订版，仍有待评审决策点 | 执行模式统一、Command adapter、规范化优化循环 | 实现计划已按推荐口径落地；设计稿需与 ADR-0004（C=Code）对齐后定稿 |
| 13 | **三源设计 §12 当前概要设计** | `docs/pth/three-source-lineage-and-capacity-conservation-design.md` | 占位未补充 | §12 由维护者补写当前概要设计 | 文档待办，非代码计划 |

## 5. 文档状态滞后 / 需回填

以下文档头部状态与实际代码/验收记录不一致，建议顺手回填：

| 文档 | 现状标记 | 实际状态 |
|---|---|---|
| `docs/pth/n30-runtime-observatory-design.md` | “等待按实施计划执行” | ✅ 已有 `n30-runtime-observatory-report.md` GO |
| `docs/pth/n32-v13-professional-computing-design.md` | “等待按实施计划执行” | ✅ 已有 `v13-professional-computing-report.md` GO |
| `docs/pth/n33-v13-ptl-operator-console-design.md` | “等待按实施计划执行” | ✅ 已有 `n33-operator-console-report.md` / `v14-operator-console-ux-report.md` GO |
| `docs/pth/n25-human-interaction-protocol-design.md` | “设计已确认，尚未实施” | ⚠️ 已实现 HumanRequest HTTP/持久化基础，完整协议仍未实施 |
| `docs/pth/execution-modes-and-tool-reg-v2-implementation-plan.md` | 第 1 节实现地图写 ptc/观察策略“未实现” | ⚠️ 代码已有 `ptc-agent-loop.ts` / `observation-strategy.ts`，应更新 |

## 6. 建议执行顺序

1. **TCE W0**（当前首要）：先把能力契约统一，作为后续一切工具面/角色面改造的单一真相源。
2. **B9**（一行级、可独立）：修复 adversarial 审核链断裂，避免治理链静默空转。
3. **B10**（小机制、可独立）：补齐 sensor/controller 调度源，让治理回路自闭环。
4. **Role Catalog W0**：与 TCE W0 共用词汇表，待 TCE 契约稳定后启动。
5. **PTH Bench**：依赖 TCE/观察策略，适合在工具面结构化后作为受控测量装置。
6. **N25/N26/N28 生产化**：各自独立立项；N28 先写生产化实施计划，N26 需先补外环设计，N25 需先回填现状并界定剩余范围。
7. **N31 2.0**：保持“1.x 验证中”，不进入近期实施。
