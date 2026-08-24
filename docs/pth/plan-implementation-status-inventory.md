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
| 执行模式与 Tool-Reg v2（Wave 0–6） | ✅ 已收口（2026-08-24；Command 相关以 ADR-0004 为准，TCE W0–W5 将退役网关） |

## 3. 实施中 / 待收尾

| 文档 | 状态 | 剩余内容 |
|---|---|---|
| `docs/pth/container-runtime-adapter-protocol.md` | 实施中 | R1–R3 已覆盖；R4 Docker/OrbStack 数据适配器、R5 Podman 适配器、R6 `/health` 暴露、R8 权威验收待完成。 |
| `docs/fracta-engine-execution-topology.md` | 部分待收尾 | U8-2（有状态 u8 接线）待接线；P5 Jupyter 体验收尾/legacy 清理待办需与 backlog 已办项复核。 |

## 4. 未实施 / 待实施（重点）

按当前优先级排列。

| # | 计划 | 文件 | 状态 | 范围 | 依赖 / 建议 |
|---|---|---|---|---|---|
| 1 | **工具面 TCE 结构化 W0–W5** | `docs/pth/plan/tce-code-model-remediation-plan.md`、`docs/adr/0004-tce-code-layer-ptc-capability-first.md` | ✅ 已完成（2026-08-24） | 能力契约统一 → 能力实现搬迁 → tool-call 投影化 → 静态审核升级 → 网关退役/Execute 重构 → 观测收尾 | 已全部落地；CommandGateway/Execute 分发器保留为兼容 shim；role catalog 可启动 |
| 2 | **Role Catalog 化与四元组细化 W0–W5** | `docs/pth/plan/role-catalog-and-four-tuple-refinement-plan.md` | ✅ 已完成（2026-08-24） | 词汇表收敛 + v1 schema + 42 张角色卡 + catalog 装载 + sensor/controller prompt 自洽 + 守恒校验读 catalog | 已全部落地；builtin-roles 保留为兼容 re-export/测试数据源 |
| 3 | **B9 adversarial 审核链断裂修复** | `docs/fracta-engine-backlog.md`、`docs/pth/report/role-lineage-runtime-derivation.md` | ✅ 已修复（2026-08-24） | `system-triggers.ts` 两个 trigger 补 `role:"controller:adversarial"` + 两处测试断言 | 已并入施工顺序第 1 步完成 |
| 4 | **B10 观测-调节调度源缺失** | `docs/fracta-engine-backlog.md`、`docs/pth/report/role-lineage-runtime-derivation.md` | ✅ 已实施（2026-08-24） | `PTH_GOVERNANCE_LOOP=on` 时注册 sensor 7 + controller 9 周期派单 trigger，任务文本含 A/B 基线窗边界 | 治理回路自闭环前置；已与 B9 同批完成 |
| 5 | **PTH Bench 统一抽象** | `docs/pth/design/pth-bench-unified-design.md` | W0–W4 + HttpBenchDriver + CLI 薄壳完成（2026-08-24） | agentic benchmark 与运行效率测试统一流水线（Scenario/Driver/ExecPolicy/Grader/Baseline Gate） | 核心/runner/gate/ScriptedLlmFn/matrix/HttpBenchDriver/CLI 已落地 |
| 6 | **N25 完整 Human Interaction 协议** | `docs/pth/design/n25-human-interaction-protocol-design.md` | 部分实施（契约 + Intent Resolver + TaskDraft + Presentation + Repository 缝） | HumanRequest HTTP/持久化/任务 wait gate 已实现；PG TaskDraft 持久化与完整 UI 未实施 | 核心协议组件已具骨架，PG 持久化待续 |
| 7 | **N26 完整自主知识摄入** | `docs/pth/design/n26-autonomous-knowledge-intake-design.md`、`docs/pth/plan/n26-productionization-plan.md` | 部分实施；来源发现/自动扩源/多域分类/生产阈值/运营指标骨架已落地（2026-08-24） | N29 最小可信摄入内环已 GO；真实爬取调度与告警未实施 | 来源/扩源/域/阈值/ops 已具骨架，后续接调度与告警 |
| 8 | **N28 生产化** | `docs/pth/design/n28-role-memory-orchestration-design.md`、`docs/pth/plan/n28-role-memory-orchestration-implementation-plan.md`、`docs/pth/plan/n28-productionization-plan.md` | 可行性 GO；生产化计划 + M1–M5 骨架 + Repository 缝已落地（2026-08-24） | persistent lease/Region 表/outbox 投影/权重校准/重平衡等生产化修缮 | WorkerReplicaLeaseRegistry + MemoryRegionRegistry + CognitiveLedgerOutbox + calibrateWeight + planRebalance + Repository 缝已落地，PG 实现待续 |
| 9 | **N31 2.0 统一 Workflow DAG 薄腰** | `docs/pth/design/n31-unified-workflow-dag-design.md` | 明确不实施 2.0 | WorkflowRunGraph / Compiler / 统一查询 API / 通用控制面 | 当前阶段为 1.x 真实场景验证；非近期待办 |
| 10 | **W8 PTL 任务派发与交互逻辑** | `docs/pth/design/w8-task-dispatch-design.md` | 设计提案（待裁决） | 入口显式派发、父→子投递、回流协议、组织权机器校验 | 部分语义已被 task-lifecycle 实现取代；需裁决后再定剩余范围 |
| 11 | **pth-cli 新命令注册渠道** | `docs/pth/design/pth-cli-command-registry-design.md` | 设计定稿待评审 | Symlink Command Registry（外部可执行模型） | 独立 CLI 增强 |
| 12 | **执行模式与 Tool-Reg v2 设计定稿** | `docs/pth/design/execution-modes-and-tool-reg-v2-design.md` | 草案修订版，仍有待评审决策点 | 执行模式统一、Command adapter、规范化优化循环 | 实现计划已按推荐口径落地；设计稿需与 ADR-0004（C=Code）对齐后定稿 |
| 13 | **三源设计 §12 当前概要设计** | `docs/pth/design/three-source-lineage-and-capacity-conservation-design.md` | 占位未补充 | §12 由维护者补写当前概要设计 | 文档待办，非代码计划 |

## 5. 文档状态滞后 / 需回填

以下文档头部状态与实际代码/验收记录不一致——**已于 2026-08-24 文档结构优化批全部回填**（commit `4b8f30d`；另补 n16×2 / n26 / n28 状态、exec-modes-design 的 ADR-0004 指引、w8 重叠注记、modeling-audit 勘误指引）。原记录保留备查：

| 文档 | 现状标记 | 实际状态 |
|---|---|---|
| `docs/pth/design/n30-runtime-observatory-design.md` | “等待按实施计划执行” | ✅ 已有 `n30-runtime-observatory-report.md` GO |
| `docs/pth/design/n32-v13-professional-computing-design.md` | “等待按实施计划执行” | ✅ 已有 `v13-professional-computing-report.md` GO |
| `docs/pth/design/n33-v13-ptl-operator-console-design.md` | “等待按实施计划执行” | ✅ 已有 `n33-operator-console-report.md` / `v14-operator-console-ux-report.md` GO |
| `docs/pth/design/n25-human-interaction-protocol-design.md` | “设计已确认，尚未实施” | ⚠️ 已实现 HumanRequest HTTP/持久化基础，完整协议仍未实施 |
| `docs/pth/plan/execution-modes-and-tool-reg-v2-implementation-plan.md` | 第 1 节实现地图写 ptc/观察策略“未实现” | ⚠️ 代码已有 `ptc-agent-loop.ts` / `observation-strategy.ts`，应更新 |

## 6. 建议执行顺序（2026-08-24 修订）

修订要点：执行模式 Wave 6 补入序列（TCE W4 退役的对象正是它在验证的网关，不同步收官会在同一批文件上撞车）；B9 提到 TCE W0 之前（治理链止血 + 让 TCE 基线捕获修复后的派发行为）；B10 契约预留 A/B 窗口边界；Role Catalog 显式安排「静态审核输入扩展」一拍（模块挂接改变能力集解析，见 ADR-0005）。

0. **执行模式 Wave 6 收尾**（或显式冻结）：按 ADR-0004 口径回填设计/计划文档并完成全量验证。
1. **B9**（分钟级）：修复 adversarial 审核链断裂——`system-triggers.ts` 两处 trigger 补 `role:"controller:adversarial"`，并同步 `system-triggers.test.ts` 两处钉住断裂形态的断言（L110/L122）。✅ 已完成（2026-08-24）。
2. **TCE W0–W5**（当前首要）：能力契约统一为单一真相源，后续工具面/角色面改造全部消费它。✅ 已完成（2026-08-24）。
3. **B10**（小机制）：补齐 sensor/controller 调度源；派单契约设计时即纳入 A/B 优化周期的 n 轮基线窗边界，避免 catalog 阶段返工。✅ 已完成（2026-08-24）。
4. **Role Catalog W0–W5**：与 TCE 共用词汇表，待 TCE 契约稳定后启动；计划中显式包含「静态审核输入扩展」（能力 ∪ 已挂接模块的能力）。✅ 已完成（2026-08-24）。
5. **PTH Bench**：依赖 TCE/观察策略，作为 A/B 周期的受控测量装置。W0–W3 已完成（2026-08-24），W4 可裁。
6. **N25/N26/N28 生产化**：各自独立立项；N28 先写生产化实施计划，N26 需先补外环设计，N25 需先界定剩余范围。
7. **N31 2.0**：保持「1.x 验证中」，不进入近期实施。

非施工项：三源设计 §12 由维护者补写——若其描写「当前构造」，应在 TCE 动工前完成，动工后描写的即是旧世界；W8 是裁决项而非施工项，需单独安排裁决槽。
