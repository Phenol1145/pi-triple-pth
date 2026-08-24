# K5 双域真实任务试点报告（2026-08-18）

> 形态：真实 PTH 任务试点（用户裁决）——运行中的 compose 栈 + deepseek 模型。
> 模型凭据：容器 `/data/agent-dir/auth.json`（PTL pi-config 模板单一源，deepseek key 已配置）。
> 代码基线：main `a70ebfe`（含 K0–K4；K1b revision 修复）。

## 0. 环境

- pi-platform 镜像按当前 main 重建并 recreate（健康 `{"status":"ok", sandbox ok}`）；
- 认证：Redis 注入一次性 token `auth:token:k5-pilot`（tenant=default, platform-admin）；
- 模型：deepseek-v4-flash/pro（agent 默认 flash；solver 角色 pro）。

## 1. 试点任务

| 任务 | domain | 路由 | 结果 |
|---|---|---|---|
| A `f2aee2ff-cad1-4a41-ada7-cc1f33a16d1f` 编程语言官方文档概念提取 | `programming-languages` | solver | completed，5 步，产出 `{concepts:[{name,definition,sourceDoc}]}` 三个概念（类型检查/IR/…），sourceDoc 指向语言规范/编译器文档类型 |
| B `9ec54497-9183-4114-97a0-9aecbc4c720d` 固态电解质材料判据提取 | `materials-science` | solver | completed，11 步，产出 `{criteria:[{name,description,sourceField}]}`（离子电导率 σ≥10⁻³ S/cm、活化能 Ea<0.4 eV，标注 Materials Project/MPContribs/EIS/MD 等来源字段） |

## 2. 逐项验收证据

| 组合设计验收点 | 证据 |
|---|---|
| 双轴路由：唯一 operational role + 多值 domains | 两任务 `assigned_role=solver`；`payload.domains=[<domain>]` + `domainBinding`（`catalogVersion=d8429659`，`resolverVersion=v1-explicit-alias`，confidence=1，evidence=explicit:<id>） |
| KnowledgeContext 有界注入 | 任务执行日志（refiner 洞察）显示 worker 读到 `Knowledge Context 无官方条目` 的诚实降级——目录数据尚未填知识，因此按设计不虚构来源 |
| Refiner 只写 scoped draft + provenance | PG `memory_entries`：A/B 各产生 3 条 `task-insight` draft + 1 条 `differentiation-proposal` draft，`tenant_id=default`、`spaceScope={space:meta,visibility:private}`、`meta.provenance` 六字段含真实 contentHash |
| 候选验证 + 晋升闭环 | 对 `insight-byipli` 与 `insight-e0tj5r` 走 HTTP：domain pass → adversarial pass → `POST /knowledge/promote` 成功 → status official；meta 含 `promotion.promotedBy=memory-keeper`、2 条 verdicts |
| Append-only revision | `insight-e0tj5r` 晋升产生 `memory_revisions` revision=3（status draft→official，reason=knowledge-promotion）。此前发现 status/meta-only 变更不记历史 → 已修 `a70ebfe` 并重建验证 |
| 知识官方门槛 | 晋升后条目仅通过 K4 双 verdict 成为 official；worker 面 broker 只回 official |

## 3. 试点暴露并修复的问题

1. **K1b revision 缺口**：晋升只改 status/meta 时 `write` 的幂等判定（content+version）误判为幂等，不写历史。修复：幂等判定补 `status` 与 `meta`（剥离生成字段 updatedAt）比较；`a70ebfe`，全量 264/2216 绿后重建验证。
2. **认证面**：`/kernel/*` 全量 Bearer 认证（P0-1 已收口）；真实试点必须先在 Redis 建 token——已写入本报告作为 runbook 步骤。

## 4. 尚未覆盖（明确边界）

- 组合设计 Phase 5 的 **30 条冻结查询 recall 评测**：本次未跑（真实任务试点形态）；K2 resolver + K3 search 的离线评测可作为下一批。
- **持久化 candidate 队列/outbox**：K4 设计已声明为已知边界；refiner fire-and-forget 丢 candidate 风险在本次未复现，需长跑观测。
- **领域来源注册表**：任务结果里的 sourceDoc/sourceField 仍是模型自述，未落 `KnowledgeSource` 结构化条目——后续试点应先在目录填入来源注册，再跑真实任务。
- 真实试点跑在 `default` tenant；跨 tenant 隔离只有 K1a/K1b 自动化测试覆盖，未在本轮真实任务中二次实测。

## 5. 结论

K5 双域真实任务试点**通过**：K0–K4 的主链路（目录解析 → 双轴任务 → KnowledgeContext 降级诚实 → refiner scoped draft → 双 verdict → promotion → revision）在真实 LLM 任务上端到端工作。下一步进入「按证据扩展」：先补两个领域的 source registry 与冻结评测集，再跑 30 题 recall 评测，而不是立即批量导入其它领域。
