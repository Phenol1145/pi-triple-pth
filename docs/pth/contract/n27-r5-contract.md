# N27-R5 契约：生产端口评测 + EvidenceRef 全链一致

> 对应复验报告 **P1-3、P1-4**。
> 文件域：`src/pth/runner/knowledge-context.ts`、`src/pth/execution/{knowledge-ranking,knowledge-broker}.ts`、
> `src/pth/catalog/{pilot-evaluator,data/pilot-eval-queries}.ts`、`scripts/{seed-k5-pilot,eval-k5-pilot}.ts`、
> `packages/pth-memory/src/knowledge-provenance.ts`（EvidenceRef 类型）。
> 依赖：**R3 已合并**（VerificationPlan 已存在，EvidenceRef 进 plan/candidate 链）。

## 1. 目标

1. 评测改走**生产 KnowledgeBroker / KnowledgeContext 端口**，不再手工复制
   resolve/filter/rank（P1-3）。
2. 题集覆盖全部 24 条知识，并加入同域 no-answer、无关内容、顺序扰动、冲突来源、跨版本、
   tenant/space visibility、holdout（P1-3）。
3. 修复零 token 命中回退任意 top-5 的自证漏洞（P1-3）。
4. 让同一 `EvidenceRef {sourceId, locator, sourceVersion, artifactHash...}` 从 DB → Broker →
   Context → Candidate → VerificationPlan → promotion 全链类型一致（P1-4）。

## 2. 阻塞项引用

**P1-3 原文要点：** Evaluator 手工复制检索管线（`pilot-evaluator.ts#L111-L143`），没有通过生产
端口验证 tenant/status/space/evidence injection；60 个标准问题只指向两域各五条 core knowledge，
其余 14 条损坏后指标仍 1.0。查询 token 零命中时过滤函数返回全部候选
（`knowledge-ranking.ts#L39-L60`）；hard negative 只测"resolver 无域"，没测"已解析到域但应无答案"。

**P1-3 关闭条件原文：**

> 评测调用生产 Broker/Context 端口；覆盖全部 24 条知识；加入同域 no-answer、无关内容、
> 顺序扰动、冲突来源、跨版本、tenant/space visibility 和 holdout 题集。

**P1-4 原文要点：** Seed 和 live evaluator 已读 `meta.evidence`，但生产 KnowledgeContext 仍主要
映射 provenance（`knowledge-context.ts#L169-L176`）。评测验证的 evidence 结构不等于 worker 实际
收到的结构。

**P1-4 关闭条件原文：**

> 需要让同一 `EvidenceRef {sourceId, locator, sourceVersion, artifactHash...}` 从 DB、Broker、
> Context、Candidate、VerificationPlan 到 promotion 全链保持类型一致。

## 3. 实施范围

| 文件 | 改动 |
|---|---|
| `packages/pth-memory/src/knowledge-provenance.ts` | 新增/导出 `KnowledgeEvidenceRef` 类型与校验（`sourceId`、`locator`、`sourceVersion?`、`artifactHash?`、`quoteHash?`），并保持 provenance 六字段不变（provenance 管来源任务，evidence 管来源工件，两者分离） |
| `src/pth/execution/knowledge-ranking.ts` | `filterKnowledgeEntriesByQueryText` 零命中不再返回全部（fail-closed 空集或显式 strict 参数）；`rankKnowledgeEntries` 保持纯函数供生产与评测共用 |
| `src/pth/runner/knowledge-context.ts` | `KnowledgeContextEntry.evidence` 从 `meta.provenance` 改为结构化 `KnowledgeEvidenceRef[]`（从 `meta.evidence` 读取；旧条目无 evidence 时明确标记 `evidence: []` 且不得伪装成 provenance） |
| `src/pth/execution/knowledge-broker.ts` | retrieve/search 返回的 entry 保持 `meta.evidence` 原样透出（Broker 不改写）；新增/对齐 EvidenceRef 校验辅助（如需要） |
| `src/pth/catalog/pilot-evaluator.ts` | 删除手写 resolve/filter/rank 管线，改为调用生产 `KnowledgeContextProvider`（传入真实 PgMemoryStore/生产 Catalog）；按生产返回的 entries/evidence 判分 |
| `scripts/eval-k5-pilot.ts` | live 评测走生产端口；输出矩阵按 query 类型分组（standard/no-answer/irrelevant/conflict/version/visibility/holdout） |
| `scripts/seed-k5-pilot.ts` | 为 `meta.evidence` 补 `sourceVersion` + `artifactHash`（从 source registry/snapshot 取）；校验 EvidenceRef 形状 |
| `src/pth/catalog/data/pilot-eval-queries.ts` | 题集扩到全语料覆盖 + 新题型，见 §4.2 |

## 4. 设计裁决要点

### 4.1 生产端口评测

- 评测器组装与生产相同的 `DisciplineResolver` + `PgMemoryStore` + `KnowledgeBroker` +
  `KnowledgeContextProvider`；每条 query 调用 `provide()`（或 broker 生产入口）拿结果，
  **不自行 resolve/filter/rank**。允许保留纯函数单测，但指标计算必须来自生产端口返回值。
- 对 `expectNoKnowledge` 题：断言生产 Context 返回空 entries（或 broker 返回空），而不是
  绕过生产管线直接判空。
- 离线与 live 都跑同一评测器；live 用真实 PG 落库（36→24 条随 seed 调整）并验证
  tenant/status/space 过滤在生产端口生效。

### 4.2 题集扩展

- **标准题必须覆盖全部 24 条 domain-fact**：每条知识至少 1 条 direct + 1 条 compositional
  查询（现有 60 题只有 10/24 覆盖的缺口必须补）。
- 新增题型（每类至少 4 题，跨两域）：
  - `no-answer-same-domain`：resolver 解析到域但语料不支持 → 生产 Context 必须空（不能回退
    top-5；配合 ranking 零命中 fail-closed）。
  - `irrelevant`：无关内容不得进 top-5。
  - `order-perturbation`：输入顺序扰动不得改善指标（对同一查询打乱 candidate 顺序）。
  - `conflict`：同一概念两个来源/版本冲突，必须可被检出（本轮至少解析 authority/time 一方；
    unresolved 显式标注）。
  - `version`：跨版本（old/latest/changed）各至少 2 题。
  - `tenant-space`：跨 tenant/space 负向查询（生产端口 + 真实 PG）。
  - `holdout`：≥30% 题集独立冻结 digest（与 seed/alias 生成隔离），不参与调参。
- **mutation 反事实**：对每条知识逐一破坏 content/evidence（或删除），断言对应题集指标下降；
  全部 24 条破坏后六项指标不得仍为 1.0。

### 4.3 ranking 零命中 fail-closed

- `filterKnowledgeEntriesByQueryText` 零命中 → 返回空（不再 `matched.length>0 ? matched : all`）。
- 中文无空白分词问题用 anchors/domain 锚点与归一化 token 处理；如需保守语义，只允许在
  显式 `strict=true` 时 fail-closed，但生产 Context 与评测必须走 strict。

### 4.4 EvidenceRef 全链

- 类型契约（放在 memory 包导出）：
  `type KnowledgeEvidenceRef = { sourceId: string; locator: string; sourceVersion?: string;
  artifactHash?: string; quoteHash?: string }`。
- `meta.evidence` 为数组；写侧（seed/refiner draft）用 `validateKnowledgeEvidenceRefs` 校验；
  读侧（Context）原样映射进 `KnowledgeContextEntry.evidence`。
- R3 的 VerificationPlan `sourceBindingsDigest` 与 candidate hash 覆盖 evidence 数组；promotion
  CAS 校验 evidence 未变（R3 已留位置，本 lane 填实）。
- provenance 六字段继续存在（来源任务/生产者），不再被 Context 当作 evidence 返回——两者不混用。

## 5. 非目标

- 不实现 N26 的 Source Revision/Trust Policy（evidence 的 artifactHash 仍来自 pilot
  source snapshot，不引入运行时抓取）。
- 不扩展到 10 域 / 60+ 条（N26 Phase 4）。
- 不改 promotion/verdict 逻辑（R1/R3 已做）；本 lane 只把 EvidenceRef 类型接进 R3 已留的位置。

## 6. 验收标准

### 6.1 定向测试与评测

- 单元：
  - `knowledge-ranking.test.ts`：`zero token match returns empty in strict mode`、
    `irrelevant query yields empty top5`。
  - `knowledge-context.test.ts`：`context entries carry structured KnowledgeEvidenceRef[]`、
    `entry without meta.evidence yields evidence: [] (not provenance)`。
- 评测脚本（offline + live 都跑）：
  - `pilot-evaluator uses KnowledgeContextProvider production port`（测试断言其不再自行
    resolve/filter/rank——可用注入的 fake provider 计数调用）。
  - 全 24 条知识覆盖报告：`coveredEntries = 24/24`。
  - mutation 报告：任一条破坏后对应用例失败（mutation score ≥ 0.9）。
  - 新题型全部通过：同域 no-answer 不 top-5 回退、无关/顺序扰动不改善指标、冲突/版本正确、
    tenant/space 负向隔离、holdout digest 冻结。
- 指标：domainRecallAt3 / knowledgeRecallAt5 / evidenceCoverage 阈值 0.9/0.9/0.95 不变；
  新增 hardNegativePassRate / noAnswerAbstention（≥0.95）/ mutationScore（≥0.9）须达标。

### 6.2 关闭条件对账表

| 关闭条件 | 证据 |
|---|---|
| 评测调用生产 Broker/Context 端口 | `pilot-evaluator uses ... production port` + live 报告 |
| 覆盖全部 24 条知识 | `coveredEntries = 24/24` |
| 同域 no-answer / 无关 / 顺序扰动 / 冲突 / 跨版本 / tenant-space / holdout | 6.1 新题型报告，每类有数可查 |
| EvidenceRef 全链类型一致 | `context entries carry structured KnowledgeEvidenceRef[]` + seed 写侧校验 + R3 plan 填实 `sourceBindingsDigest` |

### 6.3 全量门槛

- `npx vitest run`（连接 compose PG/Redis）全绿；`npm run lint` 全绿。
- 评测离线与 live 输出附在 PR；一条 commit；返回改动文件、指标表、偏差说明。
