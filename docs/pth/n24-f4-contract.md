# N24-F4 契约：重建可信评测（AB-06 / AB-07 / AB-08 / 6.4 / 6.5 / 6.6）

> 目标：把 K5 评测从 fixture self-consistency 改为**生产路径**评测，并诚实扩展题型。

## 1. 生产 Catalog 与 resolver（AB-06）

- 新建 `src/pth/catalog/data/discipline-alias-overrides.ts`（**生产数据**，非评测专用）：
  - 包含 `programming-languages` / `materials-science` 两域 aliases（从
    `pilot-domain-overrides.ts` 迁入，内容不变）；
  - 导出 `PRODUCTION_DOMAIN_ALIAS_OVERRIDES`。
- `scripts/build-discipline-catalog.ts` 生成时合并 overrides（aliases 追加去重、names 覆盖）；
  **删除 `pilot-domain-overrides.ts` 与 `buildPilotCatalog()`**——评测器与生产 assembly/batch
  都使用同一份 `DISCIPLINE_DEFINITIONS` + `DisciplineCatalogBuilder`。
- `discipline-catalog.ts` 的 `computeVersion` 扩展：`id:level:parents:names.zh-CN:aliases:
  description:methodAnchors:toolAnchors:sourceRegistryIds`（任何 catalog 行为字段变化 → 版本变化）。
- 重新生成 `discipline-catalog-data.ts`；测试断言 aliases 存在且 version 与旧 `d8429659` 不同。

## 2. Query-sensitive ranking（AB-07）

- 新建纯函数模块 `src/pth/execution/knowledge-ranking.ts`：
  - `rankKnowledgeEntries(entries, { queryText, domains, domainAncestors })`；
  - score = `domainRelevance * 1000 + queryTokenHits`（queryText 空白分词后对
    content+anchors 大小写不敏感子串命中数；无 queryText 时 queryTokenHits=0）；
  - 降序 score → id 升序 tie-break；
- `KnowledgeBroker.search` 的 `searchKnowledgeEntries` 改为：retrieve → queryText 过滤 →
  `rankKnowledgeEntries` → limit；
- `KnowledgeContextProvider` 排序同样调用该 rank（K3 旧 relevance 排序替换）；
- evaluator 检索复用同一 `rankKnowledgeEntries`（不允许自带排序）。

## 3. Evidence 非空且来自数据库（AB-08 / 6.5）

- `PILOT_KNOWLEDGE.evidence` 已有 `{sourceId, locator}`；seed 时写结构化
  `meta.evidence = [{ sourceId: "pilot-source:" + id, locator }]`（并同步写
  `meta.provenance.sourceRefs = locator 字符串`，canonical 仍 provenance）；
- evaluator 权威判定改为 fail-closed：
  - authoritative 查询必须命中至少一条 expectedEntry；
  - 计入的每条 entry 必须 `evidence.length > 0`；
  - evidence.sourceId 必须存在于 **DB source rows**（live 模式）或 PILOT_SOURCES（离线）；
  - 空 top-5 / 空 evidence 一律 fail；
- `--live` 禁止离线回填 evidence——从 DB `meta.evidence` 读取，缺行/缺字段即 fail。

## 4. Source snapshot 与真实 artifact hash（6.4）

- 新建 `src/pth/catalog/data/pilot-source-snapshots.ts`：
  - 每个 sourceId 一条 1–2 句**权威摘录**（人工可复核）；
  - `artifactHash = sha256(snapshotContent)` 由 `contentHashOf` 计算；
- `PilotKnowledgeSource` 字段改：`registryFingerprint`（sha256(uri|version|authority)，
  原 contentHash 改名） + `artifactHash`（取自 snapshots，必填）；
- seed 写 source entry 的 `meta.artifactHash` 与 `meta.snapshotContent`；evaluator 校验
  source 的 artifactHash 与 snapshot 内容一致；缺失/漂移 fail-closed。

## 5. 题型扩展（6.6）

在现有 60 题基础上追加**不破坏阈值语义**的题目，并新增指标：

- 每域 +6 题 hard negative / no-answer（`expectedEntryIds: []`、`expectNoKnowledge: true`）：
  正确行为 = top5 为空或 queryText 过滤后为空；
- 每域 +4 题多 Domain 组合（`expectedDomains: string[]`，字段名与现有 `domain` 并列；
  resolver 前 3 必须包含全部 expectedDomains）；
- 每域 +2 题混淆题（近义 domain 干扰，期望 primaryDomain=目标域或目标域在 top3）；
- 指标新增：`hardNegativePassRate`（目标 1.0）、`multiDomainResolution`（目标 1.0）、
  `distractorTop3Rate`（目标 ≥0.9）。
- 数据测试校验各题型数量与字段合法性。

## 6. 脚本与报告

- `scripts/eval-k5-pilot.ts`：默认离线 + `--live`；输出全部指标；退出码按
  domainRecallAt3≥0.9、knowledgeRecallAt5≥0.9、evidenceCoverage≥0.95、
  hardNegativePassRate=1.0、multiDomainResolution=1.0、distractorTop3Rate≥0.9；
- 更新 `docs/pth/k5-eval-report.md`：标注生产 Catalog/生产 ranking/DB evidence 的实测值；
  若某指标未达标，报告必须保留缺口并标注 blocked，不得删题凑数。

## 7. 测试与约束

- `test/pth-catalog/pilot-eval-data.test.ts` / `pilot-evaluator.test.ts` 扩展新指标与
  fail-closed 负例（空 evidence/空 top5/硬负例/多域/混淆）；
- 全量 vitest + lint 绿；worktree `.worktrees/f4` / `lane/f4-eval-rebuild`；
- 不改 concepts/parallel-lanes/TODO/README；一条 commit，返回指标与偏差。
